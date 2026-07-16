mod auth;
mod db;
mod gmail;
mod img_proxy;
mod notify;
mod settings;
mod window_state;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Emitter;
use tokio::sync::oneshot;

/// Per-account sync lock — prevents concurrent syncs for the same account
#[derive(Default)]
pub struct SyncWorkers {
    active: HashMap<String, i64>,
    resync_requested: HashMap<String, i64>,
    backfilling: HashMap<String, i64>,
}

impl SyncWorkers {
    /// Returns true only for the caller that owns this account's worker.
    pub fn claim_or_request_resync(&mut self, account_id: &str, account_generation: i64) -> bool {
        match self.active.get(account_id) {
            Some(active_generation) if *active_generation == account_generation => {
                self.resync_requested.insert(account_id.to_string(), account_generation);
                false
            }
            _ => {
                self.active.insert(account_id.to_string(), account_generation);
                true
            }
        }
    }

    pub fn take_resync_request(&mut self, account_id: &str, account_generation: i64) -> bool {
        if self.active.get(account_id) != Some(&account_generation) {
            return false;
        }
        self.resync_requested.remove(account_id) == Some(account_generation)
    }

    /// Atomically either keeps the worker for a queued refresh or releases it.
    pub fn take_resync_or_release(&mut self, account_id: &str, account_generation: i64) -> bool {
        if self.active.get(account_id) != Some(&account_generation) {
            return false;
        }
        self.backfilling.remove(account_id);
        if self.resync_requested.remove(account_id) == Some(account_generation) {
            true
        } else {
            self.active.remove(account_id);
            false
        }
    }

    pub fn set_backfilling(&mut self, account_id: &str, account_generation: i64) -> bool {
        if self.active.get(account_id) != Some(&account_generation) {
            return false;
        }
        self.backfilling.insert(account_id.to_string(), account_generation);
        true
    }

    pub fn is_backfilling(&self, account_id: Option<&str>) -> bool {
        match account_id {
            Some(account_id) => self.backfilling.contains_key(account_id),
            None => !self.backfilling.is_empty(),
        }
    }

    pub fn release(&mut self, account_id: &str, account_generation: i64) {
        if self.active.get(account_id) == Some(&account_generation) {
            self.active.remove(account_id);
            self.resync_requested.remove(account_id);
            self.backfilling.remove(account_id);
        }
    }

    pub fn invalidate_account(&mut self, account_id: &str) {
        self.active.remove(account_id);
        self.resync_requested.remove(account_id);
        self.backfilling.remove(account_id);
    }
}

/// Single per-account worker state for initial sync, incremental sync, and backfill.
pub struct SyncState {
    pub workers: Mutex<SyncWorkers>,
}

type TokenRefreshResult = Result<db::AuthInfo, String>;

/// Shares one in-flight OAuth refresh result with every caller for an account.
/// Different accounts remain independent and can refresh in parallel.
#[derive(Default)]
pub struct TokenRefreshFlights {
    waiters: Mutex<HashMap<String, Vec<oneshot::Sender<TokenRefreshResult>>>>,
}

impl TokenRefreshFlights {
    /// Returns a receiver when another caller already owns this account's
    /// refresh. `None` means the caller must perform the refresh itself.
    pub fn join_or_start(&self, account_id: &str) -> Option<oneshot::Receiver<TokenRefreshResult>> {
        let mut waiters = self.waiters.lock().ok()?;
        if let Some(account_waiters) = waiters.get_mut(account_id) {
            let (sender, receiver) = oneshot::channel();
            account_waiters.push(sender);
            Some(receiver)
        } else {
            waiters.insert(account_id.to_string(), Vec::new());
            None
        }
    }

    pub fn finish(&self, account_id: &str, result: TokenRefreshResult) {
        let waiters = self
            .waiters
            .lock()
            .ok()
            .and_then(|mut all| all.remove(account_id))
            .unwrap_or_default();
        for waiter in waiters {
            let _ = waiter.send(result.clone());
        }
    }
}

fn is_background_launch() -> bool {
    std::env::args().any(|arg| arg == "--background" || arg == "--hidden" || arg == "--minimized")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("mailimg", |_app, request, responder| {
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn(async move {
                let response = match img_proxy::fetch_remote_image(uri).await {
                    Ok((bytes, content_type)) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", content_type)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cross-Origin-Resource-Policy", "cross-origin")
                        .header("Cache-Control", "max-age=86400")
                        .body(bytes)
                        .unwrap_or_else(|_| {
                            tauri::http::Response::builder()
                                .status(500)
                                .body(Vec::new())
                                .unwrap()
                        }),
                    Err(_) => tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap(),
                };
                responder.respond(response);
            });
        })
        .manage(SyncState {
            workers: Mutex::new(SyncWorkers::default()),
        })
        .manage(TokenRefreshFlights::default())
        .manage(notify::PendingNotification(Mutex::new(None)))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                window_state::save_window_state(window);
                window_state::save_window_state_after_transition(window.clone());
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    window_state::save_window_state(window);
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            _ => {}
        })
        .setup(|app| {
            let background_launch = is_background_launch();

            let _ = dotenvy::dotenv();

            db::init_db(app.handle()).expect("Failed to initialize database");
            window_state::restore_window_state(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                if background_launch {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            use tauri::{
                menu::{CheckMenuItem, Menu, MenuItem},
                tray::TrayIconBuilder,
                Manager,
            };
            let controls = settings::read_app_controls(app.handle());
            let mute_i = CheckMenuItem::with_id(
                app,
                "toggle_mute_notifications",
                "Bildirimleri sessize al",
                true,
                controls.notifications_muted,
                None::<&str>,
            )?;
            let pause_i = CheckMenuItem::with_id(
                app,
                "toggle_pause_sync",
                "Mail çekmeyi durdur",
                true,
                controls.mail_sync_paused,
                None::<&str>,
            )?;
            let quit_i = MenuItem::with_id(app, "quit", "Kapat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&mute_i, &pause_i, &quit_i])?;
            let mute_item = mute_i.clone();
            let pause_item = pause_i.clone();

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle_mute_notifications" => {
                        let mut controls = settings::read_app_controls(app);
                        controls.notifications_muted = !controls.notifications_muted;
                        let _ = settings::write_app_controls(app, &controls);
                        let _ = mute_item.set_checked(controls.notifications_muted);
                        let _ = app.emit("app-controls-changed", controls);
                    }
                    "toggle_pause_sync" => {
                        let mut controls = settings::read_app_controls(app);
                        controls.mail_sync_paused = !controls.mail_sync_paused;
                        let _ = settings::write_app_controls(app, &controls);
                        let _ = pause_item.set_checked(controls.mail_sync_paused);
                        let _ = app.emit("app-controls-changed", controls);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            notify::show_main_window(&window);
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            auth::start_google_oauth,
            auth::refresh_access_token,
            db::get_accounts,
            db::get_account_auth,
            db::remove_account,
            db::reorder_accounts,
            db::search_contacts,
            db::get_local_emails,
            db::search_local_emails,
            db::get_emails_by_label,
            db::get_orphaned_cache_counts,
            db::reset_local_mail_cache,
            db::get_email_body,
            db::get_inbox_unread_count,
            db::get_thread_emails,
            gmail::sync_emails,
            gmail::refresh_email_from_gmail,
            gmail::get_mailbox_download_status,
            gmail::mark_as_read,
            gmail::mark_as_unread,
            gmail::archive_email,
            gmail::trash_email,
            gmail::move_to_inbox,
            gmail::permanently_delete,
            gmail::send_reply,
            gmail::send_email,
            gmail::fetch_attachment_data,
            gmail::save_and_reveal_attachment,
            db::get_email_attachments,
            notify::show_custom_notification,
            notify::get_pending_notification,
            notify::get_screen_info,
            notify::is_system_fullscreen,
            notify::focus_main_window,
            settings::get_launch_at_startup,
            settings::set_launch_at_startup,
            settings::get_app_controls,
            settings::set_app_controls,
            settings::set_notifications_muted,
            settings::set_mail_sync_paused,
            settings::set_app_language
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{SyncWorkers, TokenRefreshFlights};

    #[test]
    fn worker_keeps_ownership_until_the_queued_resync_is_consumed() {
        let mut workers = SyncWorkers::default();

        assert!(workers.claim_or_request_resync("account-a", 1));
        assert!(!workers.claim_or_request_resync("account-a", 1));
        assert!(workers.set_backfilling("account-a", 1));

        assert!(workers.take_resync_or_release("account-a", 1));
        assert!(!workers.claim_or_request_resync("account-a", 1));
        assert!(workers.take_resync_or_release("account-a", 1));
        assert!(!workers.take_resync_or_release("account-a", 1));
        assert!(workers.claim_or_request_resync("account-a", 1));

        workers.invalidate_account("account-a");
        assert!(workers.claim_or_request_resync("account-a", 2));
        workers.release("account-a", 1);
        assert!(!workers.claim_or_request_resync("account-a", 2));
    }

    #[tokio::test]
    async fn token_refresh_singleflight_shares_the_leader_result_per_account() {
        let flights = TokenRefreshFlights::default();

        assert!(flights.join_or_start("account-a").is_none());
        let waiting_a = flights.join_or_start("account-a").expect("join account-a refresh");
        assert!(flights.join_or_start("account-b").is_none());

        flights.finish("account-a", Err("refresh failed".to_string()));
        assert_eq!(
            waiting_a
                .await
                .expect("receive account-a result")
                .expect_err("account-a refresh should fail"),
            "refresh failed"
        );

        // Completing account-a does not affect account-b's independent flight.
        let waiting_b = flights.join_or_start("account-b").expect("join account-b refresh");
        flights.finish("account-b", Err("other account failed".to_string()));
        assert_eq!(
            waiting_b
                .await
                .expect("receive account-b result")
                .expect_err("account-b refresh should fail"),
            "other account failed"
        );

        assert!(flights.join_or_start("account-a").is_none());
    }
}
