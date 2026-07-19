use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Emitter};
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetWindowRect,
};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NotificationPayload {
    pub title: String,
    pub body: String,
    pub kind: Option<String>,
    pub code: Option<String>,
    #[serde(rename = "emailId")]
    pub email_id: Option<String>,
    pub duration: Option<u32>,
    #[serde(rename = "accountId")]
    pub account_id: Option<String>,
    #[serde(rename = "accountPicture")]
    pub account_picture: Option<String>,
    #[serde(rename = "multiAccount")]
    pub multi_account: Option<bool>,
}

pub struct PendingNotification(pub Mutex<Option<NotificationPayload>>);

#[tauri::command]
pub fn is_system_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    crate::require_command_window(&window, &["main"])?;
    Ok(is_fullscreen())
}

pub fn is_fullscreen() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 == std::ptr::null_mut() {
            return false;
        }

        let desktop = GetDesktopWindow();
        let mut desktop_rect = RECT::default();
        let mut window_rect = RECT::default();

        if GetWindowRect(desktop, &mut desktop_rect).is_err()
            || GetWindowRect(hwnd, &mut window_rect).is_err()
        {
            return false;
        }

        let is_covering = window_rect.left <= 0
            && window_rect.top <= 0
            && window_rect.right >= desktop_rect.right
            && window_rect.bottom >= desktop_rect.bottom;

        if !is_covering {
            return false;
        }

        let mut class_name = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut class_name) as usize;
        if len > 0 {
            let class_string = String::from_utf16_lossy(&class_name[..len]);
            if class_string == "WorkerW"
                || class_string == "Progman"
                || class_string == "Shell_TrayWnd"
            {
                return false;
            }
        }

        true
    }
}

const NOTIF_W: f64 = 340.0;
const MARGIN: f64 = 16.0;
const TASKBAR_H: f64 = 48.0;

#[tauri::command]
pub async fn show_custom_notification(
    window: tauri::WebviewWindow,
    app: AppHandle,
    title: String,
    body: String,
    kind: Option<String>,
    code: Option<String>,
    email_id: Option<String>,
    duration: Option<u32>,
    account_id: Option<String>,
    account_picture: Option<String>,
    multi_account: Option<bool>,
) -> Result<(), String> {
    crate::require_command_window(&window, &["main"])?;
    if kind.as_deref() == Some("mail") {
        let email_id = email_id
            .as_deref()
            .ok_or_else(|| "Mail notification is missing an email ID.".to_string())?;
        let account_id = account_id
            .as_deref()
            .ok_or_else(|| "Mail notification is missing an account ID.".to_string())?;
        if !crate::db::email_belongs_to_account(&app, email_id, account_id)? {
            return Err("Mail notification does not belong to the selected account.".to_string());
        }
    }
    let controls = crate::settings::read_app_controls(&app);
    if !controls.allows_notification(
        kind.as_deref(),
        code.as_ref().is_some_and(|value| !value.is_empty()),
    ) {
        return Ok(());
    }

    if is_fullscreen() {
        return Ok(());
    }

    let payload = NotificationPayload { title, body, kind, code, email_id, duration, account_id, account_picture, multi_account };

    // If window already exists (hidden or visible), just send new notification
    if let Some(window) = app.get_webview_window("notification") {
        window
            .emit("new-notification", payload)
            .map_err(|e| format!("Bildirim iletilemedi: {e}"))?;
        window
            .show()
            .map_err(|e| format!("Bildirim penceresi gösterilemedi: {e}"))?;
        return Ok(());
    }

    // Store payload for first load
    if let Some(state) = app.try_state::<PendingNotification>() {
        *state.0.lock().unwrap() = Some(payload.clone());
    }

    let monitor_result = app.primary_monitor();
    let (screen_w, screen_h) = if let Ok(Some(monitor)) = monitor_result {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale)
    } else {
        (1920.0, 1080.0)
    };

    let initial_h = 90.0; // fits one card; JS will resize after mount
    let x = screen_w - NOTIF_W - MARGIN;
    let y = screen_h - initial_h - MARGIN - TASKBAR_H;

    let app_clone = app.clone();
    let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = tauri::WebviewWindowBuilder::new(
            &app_clone,
            "notification",
            tauri::WebviewUrl::App("notification.html".into()),
        )
        .title("Notification")
        .inner_size(NOTIF_W, initial_h)
        .position(x, y)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map(|_| ())
        .map_err(|e| format!("Bildirim penceresi oluşturulamadı: {e}"));

        if result.is_err() {
            if let Some(state) = app_clone.try_state::<PendingNotification>() {
                if let Ok(mut pending) = state.0.lock() {
                    pending.take();
                }
            }
        }
        let _ = result_sender.send(result);
    })
    .map_err(|e| format!("Bildirim penceresi başlatılamadı: {e}"))?;
    tokio::time::timeout(std::time::Duration::from_secs(5), result_receiver)
        .await
        .map_err(|_| "Bildirim penceresi zamanında başlatılamadı.".to_string())?
        .map_err(|_| "Bildirim penceresi başlatılamadı.".to_string())?
}

/// Called by notification window to get the initial payload
#[tauri::command]
pub fn get_pending_notification(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Option<NotificationPayload>, String> {
    crate::require_command_window(&window, &["notification"])?;
    if let Some(state) = app.try_state::<PendingNotification>() {
        Ok(state.0.lock().unwrap().take())
    } else {
        Ok(None)
    }
}

/// Called by notification window to get screen info for repositioning
#[tauri::command]
pub fn get_screen_info(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(f64, f64), String> {
    crate::require_command_window(&window, &["notification"])?;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        Ok((size.width as f64 / scale, size.height as f64 / scale))
    } else {
        Ok((1920.0, 1080.0))
    }
}

/// Show the main window and force WebView2 to re-render at the correct DPI.
/// On Windows, hiding a WebView2 window puts it in a degraded render mode;
/// setting the size again after show() triggers a proper recompose.
pub fn show_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .show()
        .map_err(|e| format!("Ana pencere gösterilemedi: {e}"))?;
    window
        .unminimize()
        .map_err(|e| format!("Ana pencere geri yüklenemedi: {e}"))?;
    // Force WebView2 to re-render at correct DPI after being hidden.
    // Skip if maximized/fullscreen — set_size would un-maximize the window.
    let is_maximized = window.is_maximized().unwrap_or(false);
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    if !is_maximized && !is_fullscreen {
        if let Ok(size) = window.inner_size() {
            window
                .set_size(tauri::PhysicalSize::new(size.width + 1, size.height))
                .map_err(|e| format!("Ana pencere yeniden çizilemedi: {e}"))?;
            window
                .set_size(tauri::PhysicalSize::new(size.width, size.height))
                .map_err(|e| format!("Ana pencere boyutu geri yüklenemedi: {e}"))?;
        }
    }
    window
        .set_focus()
        .map_err(|e| format!("Ana pencereye odaklanılamadı: {e}"))
}

/// Called by notification window to focus the main window reliably via Rust
#[tauri::command]
pub fn focus_main_window(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    crate::require_command_window(&window, &["notification"])?;
    if let Some(window) = app.get_webview_window("main") {
        show_main_window(&window)?;
    }
    Ok(())
}
