use keyring::Entry;
use rusqlite::{params, Connection, OptionalExtension, Result, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

// ── Per-account keyring ────────────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "fursoy-mail";

fn account_key(email: &str) -> String {
    format!("oauth-{}", email)
}

pub fn save_tokens(email: &str, access_token: &str, refresh_token: &str) -> Result<(), String> {
    let data = serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
    })
    .to_string();
    Entry::new(KEYRING_SERVICE, &account_key(email))
        .and_then(|e| e.set_password(&data))
        .map_err(|e| format!("Token kaydedilemedi: {e}"))
}

pub fn load_tokens(email: &str) -> Option<(String, String)> {
    let json = Entry::new(KEYRING_SERVICE, &account_key(email))
        .ok()?
        .get_password()
        .ok()?;
    let val: serde_json::Value = serde_json::from_str(&json).ok()?;
    let access = val["access_token"].as_str()?.to_string();
    let refresh = val["refresh_token"].as_str()?.to_string();
    if access.is_empty() {
        return None;
    }
    Some((access, refresh))
}

pub fn delete_tokens(email: &str) {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, &account_key(email)) {
        let _ = entry.delete_credential();
    }
}

// Legacy single-account keyring (for one-time migration)
fn load_legacy_tokens() -> Option<(String, String)> {
    let json = Entry::new(KEYRING_SERVICE, "oauth-tokens")
        .ok()?
        .get_password()
        .ok()?;
    let val: serde_json::Value = serde_json::from_str(&json).ok()?;
    let access = val["access_token"].as_str()?.to_string();
    let refresh = val["refresh_token"].as_str()?.to_string();
    if access.is_empty() {
        return None;
    }
    Some((access, refresh))
}

fn delete_legacy_tokens() {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, "oauth-tokens") {
        let _ = entry.delete_credential();
    }
}

// ── Structs ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: String, // same as email
    pub email: String,
    pub picture: String,
    pub display_order: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Attachment {
    pub id: String,
    pub email_id: String,
    pub account_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub attachment_id: Option<String>, // Gmail attachment ID for on-demand fetch
    pub data: Option<String>,          // base64 data for small inline attachments
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Email {
    pub id: String,
    pub thread_id: String,
    pub sender: String,
    pub recipient: String,
    pub cc: String,
    pub subject: String,
    pub snippet: String,
    pub body_html: String,
    pub date: i64,
    pub unread: bool,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailSummary {
    pub id: String,
    pub thread_id: String,
    pub sender: String,
    pub recipient: String,
    pub cc: String,
    pub subject: String,
    pub snippet: String,
    pub date: i64,
    pub unread: bool,
    pub label: String,
    pub account_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthInfo {
    pub access_token: String,
    pub refresh_token: String,
    pub email: String,
    pub picture: String,
}

/// Counts local cache rows which cannot safely be assigned to an account.
/// This intentionally returns no message or attachment content.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct OrphanedCacheCounts {
    pub emails: i64,
    pub inbox_unread: i64,
    pub attachments: i64,
}

// ── DB path ────────────────────────────────────────────────────────────────────

pub fn get_db_path(app: &AppHandle) -> std::path::PathBuf {
    let app_dir = app.path().app_data_dir().unwrap();
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).unwrap();
    }
    app_dir.join("mailapp.db")
}

fn has_account_scoped_primary_key(conn: &Connection, table: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let keys: std::collections::HashMap<String, i64> = stmt
        .query_map([], |row| Ok((row.get(1)?, row.get(5)?)))?
        .filter_map(Result::ok)
        .collect();
    Ok(keys.get("account_id") == Some(&1) && keys.get("id") == Some(&2))
}

fn migrate_account_scoped_primary_keys(conn: &Connection) -> Result<()> {
    if !has_account_scoped_primary_key(conn, "emails")? {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE emails_rebuilt (
               id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL,
               recipient TEXT NOT NULL DEFAULT '', cc TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL,
               snippet TEXT NOT NULL, body_html TEXT NOT NULL, date INTEGER NOT NULL,
               unread BOOLEAN NOT NULL, label TEXT NOT NULL DEFAULT 'inbox', account_id TEXT NOT NULL DEFAULT '',
               sync_generation INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (account_id, id)
             );
             INSERT INTO emails_rebuilt SELECT id, thread_id, sender, recipient, cc, subject, snippet, body_html, date, unread, label, account_id, sync_generation FROM emails;
             DROP TABLE emails;
             ALTER TABLE emails_rebuilt RENAME TO emails;
             COMMIT;",
        )?;
    }
    if !has_account_scoped_primary_key(conn, "attachments")? {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE attachments_rebuilt (
               id TEXT NOT NULL, email_id TEXT NOT NULL, account_id TEXT NOT NULL,
               filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
               attachment_id TEXT, data TEXT, PRIMARY KEY (account_id, id)
             );
             INSERT INTO attachments_rebuilt SELECT id, email_id, account_id, filename, mime_type, size, attachment_id, data FROM attachments;
             DROP TABLE attachments;
             ALTER TABLE attachments_rebuilt RENAME TO attachments;
             COMMIT;",
        )?;
    }
    Ok(())
}

// ── init_db ────────────────────────────────────────────────────────────────────

pub fn init_db(app: &AppHandle) -> Result<()> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path)?;

    // accounts table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            picture TEXT NOT NULL DEFAULT '',
            display_order INTEGER NOT NULL DEFAULT 0,
            cache_generation INTEGER NOT NULL DEFAULT 1
        )",
        [],
    )?;
    let account_generation_column_exists: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('accounts') WHERE name='cache_generation'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|count| count > 0)
        .unwrap_or(false);
    if !account_generation_column_exists {
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN cache_generation INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS account_generations (
            account_id TEXT PRIMARY KEY,
            generation INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO account_generations (account_id, generation)
         SELECT id, cache_generation FROM accounts",
        [],
    )?;

    // attachments table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS attachments (
            id TEXT NOT NULL,
            email_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0,
            attachment_id TEXT,
            data TEXT,
            PRIMARY KEY (account_id, id)
        )",
        [],
    )?;

    // emails table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS emails (
            id TEXT NOT NULL,
            thread_id TEXT NOT NULL DEFAULT '',
            sender TEXT NOT NULL,
            recipient TEXT NOT NULL DEFAULT '',
            cc TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL,
            snippet TEXT NOT NULL,
            body_html TEXT NOT NULL,
            date INTEGER NOT NULL,
            unread BOOLEAN NOT NULL,
            label TEXT NOT NULL DEFAULT 'inbox',
            account_id TEXT NOT NULL DEFAULT '',
            sync_generation INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, id)
        )",
        [],
    )?;

    // Migration: add missing columns to emails
    let mut thread_id_was_missing = false;
    for (col, ddl) in [
        ("label", "ALTER TABLE emails ADD COLUMN label TEXT NOT NULL DEFAULT 'inbox'"),
        ("recipient", "ALTER TABLE emails ADD COLUMN recipient TEXT NOT NULL DEFAULT ''"),
        ("thread_id", "ALTER TABLE emails ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''"),
        ("cc", "ALTER TABLE emails ADD COLUMN cc TEXT NOT NULL DEFAULT ''"),
        ("account_id", "ALTER TABLE emails ADD COLUMN account_id TEXT NOT NULL DEFAULT ''"),
        ("sync_generation", "ALTER TABLE emails ADD COLUMN sync_generation INTEGER NOT NULL DEFAULT 0"),
    ] {
        let exists: bool = conn
            .prepare(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('emails') WHERE name='{}'",
                col
            ))
            .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
            .map(|c| c > 0)
            .unwrap_or(false);
        if !exists {
            conn.execute(ddl, [])?;
            if col == "thread_id" {
                thread_id_was_missing = true;
            }
        }
    }

    migrate_account_scoped_primary_keys(&conn)?;

    // If thread_id column was just added, all existing rows have thread_id=''.
    // Also handle the case where emails exist with empty thread_ids from old syncs.
    // Reset sync_state so the next startup does a full re-sync and re-fetches thread_ids.
    if thread_id_was_missing {
        conn.execute("DELETE FROM sync_state", []).ok();
    } else {
        let empty_thread_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM emails WHERE thread_id = ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if empty_thread_count > 0 {
            conn.execute("DELETE FROM sync_state", []).ok();
        }
    }

    // sync_state: migrate to per-account schema
    let sync_has_account_id: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name='account_id'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !sync_has_account_id {
        conn.execute("DROP TABLE IF EXISTS sync_state", [])?;
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_state (
            account_id TEXT PRIMARY KEY,
            history_id TEXT,
            last_full_sync_generation INTEGER NOT NULL DEFAULT 0,
            active_full_sync_generation INTEGER,
            pending_full_history_id TEXT,
            gmail_inbox_messages_unread INTEGER,
            gmail_inbox_threads_unread INTEGER
        )",
        [],
    )?;
    for (col, ddl) in [
        (
            "last_full_sync_generation",
            "ALTER TABLE sync_state ADD COLUMN last_full_sync_generation INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "active_full_sync_generation",
            "ALTER TABLE sync_state ADD COLUMN active_full_sync_generation INTEGER",
        ),
        (
            "pending_full_history_id",
            "ALTER TABLE sync_state ADD COLUMN pending_full_history_id TEXT",
        ),
        (
            "gmail_inbox_messages_unread",
            "ALTER TABLE sync_state ADD COLUMN gmail_inbox_messages_unread INTEGER",
        ),
        (
            "gmail_inbox_threads_unread",
            "ALTER TABLE sync_state ADD COLUMN gmail_inbox_threads_unread INTEGER",
        ),
    ] {
        let exists: bool = conn
            .prepare(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name='{}'",
                col
            ))
            .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
            .map(|count| count > 0)
            .unwrap_or(false);
        if !exists {
            conn.execute(ddl, [])?;
        }
    }

    // The Gmail page token that follows the locally cached newest messages for
    // each account/folder. This lets the UI load older mail on demand instead
    // of downloading an entire mailbox during the first sync.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mailbox_cursors (
            account_id TEXT NOT NULL,
            label TEXT NOT NULL,
            next_page_token TEXT,
            PRIMARY KEY (account_id, label)
        )",
        [],
    )?;

    // Indexes for common queries
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emails_label_date ON emails(label, date DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emails_account_label_date ON emails(account_id, label, date DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emails_inbox_unread ON emails(label, unread, account_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emails_account_generation ON emails(account_id, sync_generation)",
        [],
    )?;

    // Legacy auth table (kept for migration only)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS auth (
            id INTEGER PRIMARY KEY,
            access_token TEXT NOT NULL DEFAULT '',
            refresh_token TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            picture TEXT NOT NULL DEFAULT ''
        )",
        [],
    )?;

    // One-time migration: auth row → accounts table
    let accounts_empty: bool = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get::<_, i64>(0))
        .map(|c| c == 0)
        .unwrap_or(true);

    if accounts_empty {
        let legacy: Option<(String, String, String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT access_token, refresh_token, email, picture FROM auth WHERE id = 1",
                )
                .ok();
            stmt.as_mut().and_then(|s| {
                s.query_row([], |r| {
                    Ok((
                        r.get::<_, String>(0).unwrap_or_default(),
                        r.get::<_, String>(1).unwrap_or_default(),
                        r.get::<_, String>(2).unwrap_or_default(),
                        r.get::<_, String>(3).unwrap_or_default(),
                    ))
                })
                .ok()
            })
        };

        if let Some((sql_access, sql_refresh, email, picture)) = legacy {
            if !email.is_empty() {
                conn.execute(
                    "INSERT OR IGNORE INTO accounts (id, email, picture, display_order) VALUES (?1, ?2, ?3, 0)",
                    params![email, email, picture],
                )?;

                let (access, refresh) = if let Some(tokens) = load_legacy_tokens() {
                    delete_legacy_tokens();
                    tokens
                } else if !sql_access.is_empty() {
                    (sql_access, sql_refresh)
                } else {
                    (String::new(), String::new())
                };

                if !access.is_empty() {
                    let _ = save_tokens(&email, &access, &refresh);
                }

                conn.execute(
                    "UPDATE emails SET account_id = ?1 WHERE account_id = ''",
                    params![email],
                )?;
            }
        }
    }

    // Any remaining rows without an owner cannot safely be assigned to an
    // account. They are local cache only, so discard them rather than allowing
    // them to affect all-account lists or unread counts.
    purge_orphaned_cache_from_conn(&mut conn)?;

    Ok(())
}

// ── Account CRUD ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_accounts(app: tauri::AppHandle) -> Result<Vec<Account>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, email, picture, display_order \
             FROM accounts ORDER BY display_order ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let iter = stmt
        .query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                email: row.get(1)?,
                picture: row.get(2)?,
                display_order: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(iter.filter_map(|r| r.ok()).collect())
}

pub fn upsert_account(app: &AppHandle, email: &str, picture: &str) -> Result<Account, String> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let max_order: i32 = tx
        .query_row(
            "SELECT COALESCE(MAX(display_order), -1) FROM accounts",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);

    tx.execute(
        "INSERT INTO account_generations (account_id, generation) VALUES (?1, 1)
         ON CONFLICT(account_id) DO NOTHING",
        params![email],
    )
    .map_err(|e| e.to_string())?;
    let cache_generation: i64 = tx
        .query_row(
            "SELECT generation FROM account_generations WHERE account_id = ?1",
            params![email],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO accounts (id, email, picture, display_order, cache_generation)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
             picture = excluded.picture,
             cache_generation = excluded.cache_generation",
        params![email, email, picture, max_order + 1, cache_generation],
    )
    .map_err(|e| e.to_string())?;

    let display_order: i32 = tx
        .query_row(
            "SELECT display_order FROM accounts WHERE id = ?1",
            params![email],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Account {
        id: email.to_string(),
        email: email.to_string(),
        picture: picture.to_string(),
        display_order,
    })
}

pub fn get_account_picture(app: &AppHandle, email: &str) -> String {
    let db_path = get_db_path(app);
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    conn.query_row(
        "SELECT picture FROM accounts WHERE id = ?1",
        params![email],
        |r| r.get(0),
    )
    .unwrap_or_default()
}

pub fn get_account_cache_generation(app: &AppHandle, account_id: &str) -> Result<i64, String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT cache_generation FROM accounts WHERE id = ?1",
        params![account_id],
        |row| row.get(0),
    )
    .map_err(|_| "Account is no longer available".to_string())
}

fn ensure_account_generation(
    conn: &Connection,
    account_id: &str,
    expected_generation: i64,
) -> Result<()> {
    let generation = conn
        .query_row(
            "SELECT cache_generation FROM accounts WHERE id = ?1",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if generation == Some(expected_generation) {
        Ok(())
    } else {
        Err(rusqlite::Error::QueryReturnedNoRows)
    }
}

#[tauri::command]
pub fn remove_account(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    remove_account_cache_from_conn(&mut conn, &account_id).map_err(|e| e.to_string())?;

    delete_tokens(&account_id);
    if let Ok(mut workers) = app.state::<crate::SyncState>().workers.lock() {
        workers.invalidate_account(&account_id);
    }

    Ok(())
}

fn remove_account_cache_from_conn(conn: &mut Connection, account_id: &str) -> Result<()> {
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO account_generations (account_id, generation) VALUES (?1, 2)
         ON CONFLICT(account_id) DO UPDATE SET generation = generation + 1",
        params![account_id],
    )?;
    tx.execute(
        "DELETE FROM attachments WHERE account_id = ?1",
        params![account_id],
    )?;
    tx.execute(
        "DELETE FROM emails WHERE account_id = ?1",
        params![account_id],
    )?;
    tx.execute(
        "DELETE FROM sync_state WHERE account_id = ?1",
        params![account_id],
    )?;
    tx.execute(
        "DELETE FROM mailbox_cursors WHERE account_id = ?1",
        params![account_id],
    )?;
    tx.execute("DELETE FROM accounts WHERE id = ?1", params![account_id])
        ?;
    tx.commit()
}

/// Removes only downloaded local mail data. Gmail messages, accounts and OAuth
/// credentials remain untouched; the next sync rebuilds this cache from Gmail.
fn reset_local_mail_cache_from_conn(
    conn: &mut Connection,
    account_id: Option<&str>,
) -> Result<Vec<String>> {
    let account_ids = match account_id {
        Some(id) => vec![id.to_string()],
        None => {
            let mut stmt = conn.prepare("SELECT id FROM accounts")?;
            let ids = stmt.query_map([], |row| row.get::<_, String>(0))?
                .filter_map(Result::ok)
                .collect();
            ids
        }
    };
    let tx = conn.transaction()?;

    match account_id {
        Some(id) => {
            tx.execute(
                "UPDATE account_generations SET generation = generation + 1 WHERE account_id = ?1",
                params![id],
            )?;
            tx.execute(
                "UPDATE accounts SET cache_generation = cache_generation + 1 WHERE id = ?1",
                params![id],
            )?;
            tx.execute("DELETE FROM attachments WHERE account_id = ?1", params![id])?;
            tx.execute("DELETE FROM emails WHERE account_id = ?1", params![id])?;
            tx.execute("DELETE FROM sync_state WHERE account_id = ?1", params![id])?;
            tx.execute("DELETE FROM mailbox_cursors WHERE account_id = ?1", params![id])?;
        }
        None => {
            // Bump every generation before deleting the cache so a worker that
            // was already in flight cannot write stale rows back after reset.
            tx.execute("UPDATE account_generations SET generation = generation + 1", [])?;
            tx.execute("UPDATE accounts SET cache_generation = cache_generation + 1", [])?;
            tx.execute("DELETE FROM attachments", [])?;
            tx.execute("DELETE FROM emails", [])?;
            tx.execute("DELETE FROM sync_state", [])?;
            tx.execute("DELETE FROM mailbox_cursors", [])?;
        }
    }
    tx.commit()?;
    Ok(account_ids)
}

#[tauri::command]
pub fn reset_local_mail_cache(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let invalidated_accounts = reset_local_mail_cache_from_conn(&mut conn, account_id.as_deref())
        .map_err(|e| e.to_string())?;
    if let Ok(mut workers) = app.state::<crate::SyncState>().workers.lock() {
        for account_id in invalidated_accounts {
            workers.invalidate_account(&account_id);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn reorder_accounts(app: tauri::AppHandle, ordered_ids: Vec<String>) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    for (i, id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "UPDATE accounts SET display_order = ?1 WHERE id = ?2",
            params![i as i32, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Contact autocomplete ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ContactSuggestion {
    pub name: String,
    pub email: String,
}

fn parse_contact(raw: &str) -> (String, String) {
    let s = raw.trim();
    if let Some(lt) = s.find('<') {
        if let Some(gt) = s.rfind('>') {
            let name = s[..lt].trim().trim_matches('"').to_string();
            let email = s[lt + 1..gt].trim().to_string();
            return (name, email);
        }
    }
    if s.contains('@') {
        return (String::new(), s.to_string());
    }
    (String::new(), String::new())
}

fn search_contacts_from_conn(
    conn: &Connection,
    query: &str,
    account_id: &str,
) -> Result<Vec<ContactSuggestion>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let like = format!("%{}%", query.to_lowercase());

    let mut raw_pairs: Vec<(String, i64)> = Vec::new();

    // Senders from received emails
    let mut stmt = conn
        .prepare(
            "SELECT sender, COUNT(*) FROM emails \
             WHERE account_id = ?2 AND label != 'sent' AND sender != '' AND LOWER(sender) LIKE ?1 \
             GROUP BY sender ORDER BY COUNT(*) DESC LIMIT 20",
        )?;
    let rows = stmt
        .query_map(params![like, account_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for r in rows.flatten() {
        raw_pairs.push(r);
    }

    // Recipients from sent emails
    let mut stmt2 = conn
        .prepare(
            "SELECT recipient, COUNT(*) FROM emails \
             WHERE account_id = ?2 AND label = 'sent' AND recipient != '' AND LOWER(recipient) LIKE ?1 \
             GROUP BY recipient ORDER BY COUNT(*) DESC LIMIT 20",
        )?;
    let rows2 = stmt2
        .query_map(params![like, account_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for r in rows2.flatten() {
        raw_pairs.push(r);
    }

    // Parse, dedupe by email, sort by count
    let q = query.to_lowercase();
    let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut best: std::collections::HashMap<String, ContactSuggestion> =
        std::collections::HashMap::new();

    for (raw, count) in raw_pairs {
        for part in raw.split(',') {
            let (name, email) = parse_contact(part.trim());
            if email.is_empty() || !email.contains('@') {
                continue;
            }
            let el = email.to_lowercase();
            if !el.contains(&q) && !name.to_lowercase().contains(&q) {
                continue;
            }
            *counts.entry(el.clone()).or_insert(0) += count;
            best.entry(el).or_insert(ContactSuggestion { name, email });
        }
    }

    let mut result: Vec<(i64, ContactSuggestion)> = counts
        .into_iter()
        .filter_map(|(k, c)| best.remove(&k).map(|s| (c, s)))
        .collect();
    result.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(result.into_iter().take(8).map(|(_, s)| s).collect())
}

#[tauri::command]
pub fn search_contacts(
    app: AppHandle,
    query: String,
    account_id: String,
) -> Result<Vec<ContactSuggestion>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    search_contacts_from_conn(&conn, &query, &account_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account_auth(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<Option<AuthInfo>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT email, picture FROM accounts WHERE id = ?1",
            params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    let Some((email, picture)) = row else {
        return Ok(None);
    };

    let Some((access_token, refresh_token)) = load_tokens(&email) else {
        return Ok(None);
    };

    Ok(Some(AuthInfo {
        access_token,
        refresh_token,
        email,
        picture,
    }))
}

// ── Email CRUD ────────────────────────────────────────────────────────────────

fn upsert_emails_in_generation(
    app: &AppHandle,
    account_id: &str,
    emails: Vec<Email>,
    sync_generation: Option<i64>,
    expected_account_generation: Option<i64>,
) -> Result<()> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path)?;
    let sync_generation = sync_generation.unwrap_or_else(|| {
        conn.query_row(
            "SELECT active_full_sync_generation FROM sync_state WHERE account_id = ?1",
            params![account_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
        .unwrap_or(0)
    });
    let tx = conn.transaction()?;
    if let Some(expected_account_generation) = expected_account_generation {
        ensure_account_generation(&tx, account_id, expected_account_generation)?;
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO emails (id, thread_id, sender, recipient, cc, subject, snippet, \
                                 body_html, date, unread, label, account_id, sync_generation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(account_id, id) DO UPDATE SET
                thread_id = excluded.thread_id,
                sender    = excluded.sender,
                recipient = excluded.recipient,
                cc        = excluded.cc,
                subject   = excluded.subject,
                snippet   = excluded.snippet,
                body_html = excluded.body_html,
                date      = excluded.date,
                unread    = excluded.unread,
                label     = excluded.label,
                account_id= excluded.account_id,
                sync_generation = excluded.sync_generation",
        )?;

        for email in emails {
            stmt.execute(params![
                email.id,
                email.thread_id,
                email.sender,
                email.recipient,
                email.cc,
                email.subject,
                email.snippet,
                email.body_html,
                email.date,
                email.unread,
                email.label,
                account_id,
                sync_generation,
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

pub fn upsert_emails(app: &AppHandle, account_id: &str, emails: Vec<Email>) -> Result<()> {
    upsert_emails_in_generation(app, account_id, emails, None, None)
}

pub fn upsert_sync_emails(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    sync_generation: Option<i64>,
    emails: Vec<Email>,
) -> Result<()> {
    upsert_emails_in_generation(
        app,
        account_id,
        emails,
        sync_generation,
        Some(account_generation),
    )
}

fn map_summary_row(row: &rusqlite::Row) -> rusqlite::Result<EmailSummary> {
    Ok(EmailSummary {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        sender: row.get(2)?,
        recipient: row.get(3)?,
        cc: row.get(4)?,
        subject: row.get(5)?,
        snippet: row.get(6)?,
        date: row.get(7)?,
        unread: row.get(8)?,
        label: row.get(9)?,
        account_id: row.get(10)?,
    })
}

const SUMMARY_COLS: &str =
    "id, thread_id, sender, recipient, cc, subject, snippet, date, unread, label, account_id";

fn orphaned_cache_counts_from_conn(conn: &Connection) -> Result<OrphanedCacheCounts> {
    Ok(OrphanedCacheCounts {
        emails: conn.query_row(
            "SELECT COUNT(*) FROM emails WHERE account_id = ''",
            [],
            |row| row.get(0),
        )?,
        inbox_unread: conn.query_row(
            "SELECT COUNT(*) FROM emails WHERE account_id = '' AND label = 'inbox' AND unread = 1",
            [],
            |row| row.get(0),
        )?,
        attachments: conn.query_row(
            "SELECT COUNT(*) FROM attachments WHERE account_id = ''",
            [],
            |row| row.get(0),
        )?,
    })
}

fn purge_orphaned_cache_from_conn(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM attachments WHERE account_id = ''", [])?;
    tx.execute("DELETE FROM emails WHERE account_id = ''", [])?;
    tx.execute("DELETE FROM sync_state WHERE account_id = ''", [])?;
    tx.execute("DELETE FROM mailbox_cursors WHERE account_id = ''", [])?;
    tx.commit()
}

/// Safe local-cache diagnosis for legacy rows with no account owner.
/// No mail content is returned and no data is changed.
#[tauri::command]
pub fn get_orphaned_cache_counts(app: tauri::AppHandle) -> Result<OrphanedCacheCounts, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    orphaned_cache_counts_from_conn(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_emails_by_label(
    app: tauri::AppHandle,
    label: String,
    account_id: Option<String>,
    limit: Option<u32>,
    before_date: Option<i64>,
    before_account_id: Option<String>,
    before_id: Option<String>,
) -> Result<Vec<EmailSummary>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let limit = i64::from(limit.unwrap_or(100).clamp(1, 5_000));

    match account_id {
        Some(id) => {
            let (sql, cursor_id) = match (before_date, before_id) {
                (Some(date), Some(cursor_id)) => (
                    format!(
                        "SELECT {SUMMARY_COLS} FROM emails
                         WHERE label = ?1 AND account_id = ?2
                           AND (date < ?3 OR (date = ?3 AND id > ?4))
                         ORDER BY date DESC, id ASC LIMIT ?5"
                    ),
                    Some((date, cursor_id)),
                ),
                _ => (
                    format!(
                        "SELECT {SUMMARY_COLS} FROM emails WHERE label = ?1 AND account_id = ?2
                         ORDER BY date DESC, id ASC LIMIT ?3"
                    ),
                    None,
                ),
            };
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = if let Some((date, cursor_id)) = cursor_id {
                stmt.query_map(params![label, id, date, cursor_id, limit], map_summary_row)
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect()
            } else {
                stmt.query_map(params![label, id, limit], map_summary_row)
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect()
            };
            Ok(rows)
        }
        None => {
            let cursor = match (before_date, before_account_id, before_id) {
                (Some(date), Some(account_id), Some(id)) => Some((date, account_id, id)),
                _ => None,
            };
            let sql = if cursor.is_some() {
                format!(
                    "SELECT {SUMMARY_COLS} FROM emails
                     WHERE label = ?1 AND account_id != ''
                       AND (date < ?2 OR (date = ?2 AND (account_id > ?3 OR (account_id = ?3 AND id > ?4))))
                     ORDER BY date DESC, account_id ASC, id ASC LIMIT ?5"
                )
            } else {
                format!(
                    "SELECT {SUMMARY_COLS} FROM emails WHERE label = ?1 AND account_id != ''
                     ORDER BY date DESC, account_id ASC, id ASC LIMIT ?2"
                )
            };
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = if let Some((date, account_id, id)) = cursor {
                stmt.query_map(params![label, date, account_id, id, limit], map_summary_row)
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect()
            } else {
                stmt.query_map(params![label, limit], map_summary_row)
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect()
            };
            Ok(rows)
        }
    }
}

#[tauri::command]
pub fn get_local_emails(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<Vec<EmailSummary>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    match account_id {
        Some(id) => {
            let sql = format!(
                "SELECT {SUMMARY_COLS} FROM emails WHERE account_id = ?1 ORDER BY date DESC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = stmt
                .query_map(params![id], map_summary_row)
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
        None => {
            let sql = format!(
                "SELECT {SUMMARY_COLS} FROM emails WHERE account_id != '' ORDER BY date DESC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = stmt
                .query_map([], map_summary_row)
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
    }
}

fn escape_like_pattern(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn search_local_emails_from_conn(
    conn: &Connection,
    query: &str,
    account_id: Option<&str>,
    limit: i64,
) -> Result<Vec<EmailSummary>> {
    let pattern = format!("%{}%", escape_like_pattern(query.trim()));
    let text_match = "(subject LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' OR recipient LIKE ? ESCAPE '\\' OR cc LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\')";

    let (sql, account) = match account_id {
        Some(id) => (
            format!(
                "SELECT {SUMMARY_COLS} FROM emails
                 WHERE account_id = ? AND {text_match}
                 ORDER BY date DESC, id ASC LIMIT ?"
            ),
            Some(id),
        ),
        None => (
            format!(
                "SELECT {SUMMARY_COLS} FROM emails
                 WHERE account_id != '' AND {text_match}
                 ORDER BY date DESC, account_id ASC, id ASC LIMIT ?"
            ),
            None,
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = match account {
        Some(id) => stmt.query_map(
            params![id, pattern, pattern, pattern, pattern, pattern, limit],
            map_summary_row,
        )?,
        None => stmt.query_map(
            params![pattern, pattern, pattern, pattern, pattern, limit],
            map_summary_row,
        )?,
    };
    Ok(rows.filter_map(|row| row.ok()).collect())
}

/// Searches all locally cached message summaries for the selected account.
/// This deliberately searches metadata only; message bodies stay on-demand.
#[tauri::command]
pub fn search_local_emails(
    app: tauri::AppHandle,
    query: String,
    account_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<EmailSummary>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let limit = i64::from(limit.unwrap_or(500).clamp(1, 1_000));
    search_local_emails_from_conn(&conn, &query, account_id.as_deref(), limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_email_body(app: tauri::AppHandle, id: String, account_id: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT body_html FROM emails WHERE id = ?1 AND account_id = ?2",
        params![id, account_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn mark_email_as_read_local(app: &AppHandle, id: &str, account_id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("UPDATE emails SET unread = 0 WHERE id = ?1 AND account_id = ?2", params![id, account_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_email_as_unread_local(app: &AppHandle, id: &str, account_id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("UPDATE emails SET unread = 1 WHERE id = ?1 AND account_id = ?2", params![id, account_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_email_label(app: &AppHandle, id: &str, account_id: &str, label: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE emails SET label = ?1 WHERE id = ?2 AND account_id = ?3",
        params![label, id, account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_email_from_db(app: &AppHandle, id: &str, account_id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM emails WHERE id = ?1 AND account_id = ?2", params![id, account_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_inbox_unread_count(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<i64, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    inbox_unread_count_from_conn(&conn, account_id.as_deref()).map_err(|e| e.to_string())
}

fn inbox_unread_count_from_conn(conn: &Connection, account_id: Option<&str>) -> Result<i64> {
    let count: i64 = match account_id {
        Some(id) => conn.query_row(
            "SELECT COALESCE(
                (SELECT gmail_inbox_messages_unread FROM sync_state WHERE account_id = ?1),
                (SELECT COUNT(*) FROM emails WHERE label = 'inbox' AND unread = 1 AND account_id = ?1)
             )",
            params![id],
            |row| row.get(0),
        ),
        None => conn.query_row(
            "SELECT COALESCE(SUM(COALESCE(
                s.gmail_inbox_messages_unread,
                (SELECT COUNT(*) FROM emails e WHERE e.label = 'inbox' AND e.unread = 1 AND e.account_id = a.id)
             )), 0)
             FROM accounts a
             LEFT JOIN sync_state s ON s.account_id = a.id",
            [],
            |row| row.get(0),
        ),
    }
    ?;
    Ok(count)
}

pub fn set_gmail_inbox_unread_stats(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    messages_unread: i64,
    threads_unread: i64,
) -> Result<(), String> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    ensure_account_generation(&tx, account_id, account_generation).map_err(|_| "Account is no longer available")?;
    tx.execute(
        "INSERT INTO sync_state (
             account_id, gmail_inbox_messages_unread, gmail_inbox_threads_unread
         ) VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id) DO UPDATE SET
             gmail_inbox_messages_unread = excluded.gmail_inbox_messages_unread,
             gmail_inbox_threads_unread = excluded.gmail_inbox_threads_unread",
        params![account_id, messages_unread, threads_unread],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// ── Sync state (per-account history ID) ────────────────────────────────────────

pub fn get_history_id(app: &AppHandle, account_id: &str) -> Option<String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).ok()?;
    conn.query_row(
        "SELECT history_id FROM sync_state WHERE account_id = ?1",
        params![account_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

pub fn set_history_id(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    history_id: &str,
) -> Result<(), String> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    ensure_account_generation(&tx, account_id, account_generation).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO sync_state (account_id, history_id) VALUES (?1, ?2)
         ON CONFLICT(account_id) DO UPDATE SET history_id = excluded.history_id",
        params![account_id, history_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveFullSync {
    pub generation: i64,
    pub pending_history_id: String,
}

pub fn get_active_full_sync(app: &AppHandle, account_id: &str) -> Result<Option<ActiveFullSync>, String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT active_full_sync_generation, pending_full_history_id
         FROM sync_state WHERE account_id = ?1 AND active_full_sync_generation IS NOT NULL",
        params![account_id],
        |row| {
            Ok(ActiveFullSync {
                generation: row.get(0)?,
                pending_history_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn next_full_sync_generation(app: &AppHandle, account_id: &str) -> Result<i64, String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COALESCE(last_full_sync_generation, 0) + 1 FROM sync_state WHERE account_id = ?1",
        params![account_id],
        |row| row.get(0),
    )
    .optional()
    .map(|generation| generation.unwrap_or(1))
    .map_err(|e| e.to_string())
}

fn complete_full_sync_from_conn(
    conn: &mut Connection,
    account_id: &str,
    account_generation: i64,
    cursors: &[(String, Option<String>)],
    history_id: &str,
    sync_generation: i64,
) -> Result<()> {
    let tx = conn.transaction()?;
    ensure_account_generation(&tx, account_id, account_generation)?;
    {
        let mut cursor_stmt = tx.prepare(
            "INSERT INTO mailbox_cursors (account_id, label, next_page_token) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id, label) DO UPDATE SET next_page_token = excluded.next_page_token",
        )?;
        for (label, next_page_token) in cursors {
            cursor_stmt.execute(params![account_id, label, next_page_token])?;
        }
    }
    tx.execute(
        "INSERT INTO sync_state (
             account_id, history_id, last_full_sync_generation,
             active_full_sync_generation, pending_full_history_id
         ) VALUES (?1, NULL, ?2, ?2, ?3)
         ON CONFLICT(account_id) DO UPDATE SET
             history_id = NULL,
             last_full_sync_generation = excluded.last_full_sync_generation,
             active_full_sync_generation = excluded.active_full_sync_generation,
             pending_full_history_id = excluded.pending_full_history_id",
        params![account_id, sync_generation, history_id],
    )?;
    tx.commit()
}

/// Publishes the initial mailbox cursors and a pending Gmail history checkpoint together.
/// A failed transaction leaves both at their previous values so the same Gmail pages
/// can be retried safely. The checkpoint becomes active only after the full backfill.
pub fn complete_full_sync(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    cursors: &[(String, Option<String>)],
    history_id: &str,
    sync_generation: i64,
) -> Result<(), String> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    complete_full_sync_from_conn(
        &mut conn,
        account_id,
        account_generation,
        cursors,
        history_id,
        sync_generation,
    )
        .map_err(|e| e.to_string())
}

fn finalize_full_sync_from_conn(
    conn: &mut Connection,
    account_id: &str,
    account_generation: i64,
    sync_generation: i64,
) -> Result<usize> {
    let tx = conn.transaction()?;
    ensure_account_generation(&tx, account_id, account_generation)?;
    let pending_history_id: String = tx.query_row(
        "SELECT pending_full_history_id FROM sync_state
         WHERE account_id = ?1 AND active_full_sync_generation = ?2",
        params![account_id, sync_generation],
        |row| row.get::<_, Option<String>>(0),
    )?
    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

    tx.execute(
        "DELETE FROM attachments
         WHERE account_id = ?1
           AND email_id IN (
               SELECT id FROM emails
               WHERE account_id = ?1 AND sync_generation != ?2
           )",
        params![account_id, sync_generation],
    )?;
    let deleted = tx.execute(
        "DELETE FROM emails WHERE account_id = ?1 AND sync_generation != ?2",
        params![account_id, sync_generation],
    )?;
    tx.execute(
        "UPDATE sync_state SET
             history_id = ?3,
             active_full_sync_generation = NULL,
             pending_full_history_id = NULL
         WHERE account_id = ?1 AND active_full_sync_generation = ?2",
        params![account_id, sync_generation, pending_history_id],
    )?;
    tx.commit()?;
    Ok(deleted)
}

/// Finishes a full local-cache rebuild. Only rows not seen during the completed
/// generation are removed; Gmail data is never modified.
pub fn finalize_full_sync(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    sync_generation: i64,
) -> Result<usize, String> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    finalize_full_sync_from_conn(&mut conn, account_id, account_generation, sync_generation)
        .map_err(|e| e.to_string())
}

pub fn get_mailbox_cursor_state(
    app: &AppHandle,
    account_id: &str,
    label: &str,
) -> Result<Option<Option<String>>, String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT next_page_token FROM mailbox_cursors WHERE account_id = ?1 AND label = ?2",
        params![account_id, label],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn has_pending_mailbox_pages(
    app: &AppHandle,
    account_id: Option<&str>,
) -> Result<bool, String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let count: i64 = match account_id {
        Some(account_id) => conn.query_row(
            "SELECT COUNT(*) FROM mailbox_cursors
             WHERE account_id = ?1 AND next_page_token IS NOT NULL",
            params![account_id],
            |row| row.get(0),
        ),
        None => conn.query_row(
            "SELECT COUNT(*) FROM mailbox_cursors WHERE next_page_token IS NOT NULL",
            [],
            |row| row.get(0),
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

pub fn set_mailbox_cursor(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    label: &str,
    next_page_token: Option<&str>,
) -> Result<(), String> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    ensure_account_generation(&tx, account_id, account_generation).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO mailbox_cursors (account_id, label, next_page_token) VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id, label) DO UPDATE SET next_page_token = excluded.next_page_token",
        params![account_id, label, next_page_token],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_thread_emails(
    app: tauri::AppHandle,
    thread_id: String,
    account_id: String,
) -> Result<Vec<EmailSummary>, String> {
    if thread_id.is_empty() {
        return Ok(vec![]);
    }
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT {SUMMARY_COLS} FROM emails WHERE thread_id = ?1 AND account_id = ?2 ORDER BY date ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<EmailSummary> = stmt
        .query_map(params![thread_id, account_id], map_summary_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

fn upsert_attachments_with_generation(
    app: &AppHandle,
    account_id: Option<(&str, i64)>,
    attachments: Vec<Attachment>,
) -> Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    if let Some((account_id, account_generation)) = account_id {
        ensure_account_generation(&tx, account_id, account_generation)?;
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments (id, email_id, account_id, filename, mime_type, size, attachment_id, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(account_id, id) DO UPDATE SET
                filename      = excluded.filename,
                mime_type     = excluded.mime_type,
                size          = excluded.size,
                attachment_id = excluded.attachment_id,
                data          = excluded.data",
        )?;
        for att in &attachments {
            stmt.execute(params![
                att.id, att.email_id, att.account_id,
                att.filename, att.mime_type, att.size,
                att.attachment_id, att.data,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn upsert_sync_attachments(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    attachments: Vec<Attachment>,
) -> Result<()> {
    upsert_attachments_with_generation(app, Some((account_id, account_generation)), attachments)
}

#[tauri::command]
pub fn get_email_attachments(
    app: tauri::AppHandle,
    email_id: String,
    account_id: String,
) -> Result<Vec<Attachment>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, email_id, account_id, filename, mime_type, size, attachment_id, data
             FROM attachments WHERE email_id = ?1 AND account_id = ?2 ORDER BY rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![email_id, account_id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                email_id: row.get(1)?,
                account_id: row.get(2)?,
                filename: row.get(3)?,
                mime_type: row.get(4)?,
                size: row.get(5)?,
                attachment_id: row.get(6)?,
                data: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

fn delete_emails_by_ids_from_conn(
    conn: &Connection,
    account_id: &str,
    ids: &[String],
) -> Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }

    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "DELETE FROM emails WHERE account_id = ? AND id IN ({placeholders})"
    );
    let mut params: Vec<&dyn rusqlite::types::ToSql> = vec![&account_id];
    params.extend(ids.iter().map(|s| s as &dyn rusqlite::types::ToSql));
    conn.execute(&sql, params.as_slice())
}

pub fn delete_emails_by_ids(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    ids: &[String],
) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    ensure_account_generation(&conn, account_id, account_generation).map_err(|_| "Account is no longer available")?;
    delete_emails_by_ids_from_conn(&conn, account_id, ids).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_emails_by_ids_scopes_every_id_to_the_requested_account() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE emails (
                id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                PRIMARY KEY (account_id, id)
            );
            INSERT INTO emails (id, account_id) VALUES
                ('delete-1', 'account-a'),
                ('delete-2', 'account-a'),
                ('keep-a', 'account-a'),
                ('delete-1', 'account-b');",
        )
        .expect("seed emails");

        let ids = vec!["delete-1".to_string(), "delete-2".to_string()];
        let deleted = delete_emails_by_ids_from_conn(&conn, "account-a", &ids)
            .expect("delete selected account emails");

        assert_eq!(deleted, 2);
        let remaining: Vec<(String, String)> = conn
            .prepare("SELECT account_id, id FROM emails ORDER BY account_id, id")
            .expect("prepare remaining rows")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query remaining rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("read remaining rows");
        assert_eq!(
            remaining,
            vec![
                ("account-a".to_string(), "keep-a".to_string()),
                ("account-b".to_string(), "delete-1".to_string()),
            ]
        );
    }

    #[test]
    fn full_sync_publish_rolls_back_cursors_when_history_checkpoint_cannot_be_saved() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE mailbox_cursors (
                account_id TEXT NOT NULL,
                label TEXT NOT NULL,
                next_page_token TEXT,
                PRIMARY KEY (account_id, label)
            );",
        )
        .expect("create mailbox cursors");

        let cursors = vec![("inbox".to_string(), Some("next-page".to_string()))];
        assert!(complete_full_sync_from_conn(&mut conn, "account-a", 1, &cursors, "history-1", 1).is_err());

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mailbox_cursors", [], |row| row.get(0))
            .expect("count cursors after rollback");
        assert_eq!(count, 0);
    }

    #[test]
    fn finalize_full_sync_removes_only_stale_local_rows_after_a_complete_generation() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE accounts (
                id TEXT PRIMARY KEY,
                cache_generation INTEGER NOT NULL
            );
            INSERT INTO accounts (id, cache_generation) VALUES ('account-a', 1);
            CREATE TABLE sync_state (
                account_id TEXT PRIMARY KEY,
                history_id TEXT,
                last_full_sync_generation INTEGER NOT NULL DEFAULT 0,
                active_full_sync_generation INTEGER,
                pending_full_history_id TEXT
            );
            CREATE TABLE emails (
                id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                sync_generation INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account_id, id)
            );
            CREATE TABLE attachments (
                id TEXT NOT NULL,
                email_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                PRIMARY KEY (account_id, id)
            );
            INSERT INTO sync_state (
                account_id, history_id, last_full_sync_generation,
                active_full_sync_generation, pending_full_history_id
            ) VALUES ('account-a', NULL, 7, 7, 'history-7');
            INSERT INTO emails (id, account_id, sync_generation) VALUES
                ('current', 'account-a', 7),
                ('stale', 'account-a', 6),
                ('other-account', 'account-b', 2);
            INSERT INTO attachments (id, email_id, account_id) VALUES
                ('current-att', 'current', 'account-a'),
                ('stale-att', 'stale', 'account-a'),
                ('other-att', 'other-account', 'account-b');",
        )
        .expect("seed full-sync state");

        let deleted = finalize_full_sync_from_conn(&mut conn, "account-a", 1, 7)
            .expect("finalize full sync");
        assert_eq!(deleted, 1);

        let remaining_messages: Vec<(String, String)> = conn
            .prepare("SELECT account_id, id FROM emails ORDER BY account_id, id")
            .expect("prepare messages")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query messages")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("read messages");
        assert_eq!(
            remaining_messages,
            vec![
                ("account-a".to_string(), "current".to_string()),
                ("account-b".to_string(), "other-account".to_string()),
            ]
        );

        let remaining_attachments: Vec<(String, String)> = conn
            .prepare("SELECT account_id, id FROM attachments ORDER BY account_id, id")
            .expect("prepare attachments")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query attachments")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("read attachments");
        assert_eq!(
            remaining_attachments,
            vec![
                ("account-a".to_string(), "current-att".to_string()),
                ("account-b".to_string(), "other-att".to_string()),
            ]
        );

        let state: (Option<String>, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT history_id, active_full_sync_generation, pending_full_history_id
                 FROM sync_state WHERE account_id = 'account-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read finalized state");
        assert_eq!(state, (Some("history-7".to_string()), None, None));
    }

    #[test]
    fn account_generation_rejects_writes_from_a_removed_account_worker() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE accounts (
                id TEXT PRIMARY KEY,
                cache_generation INTEGER NOT NULL
            );
            INSERT INTO accounts (id, cache_generation) VALUES ('account-a', 3);",
        )
        .expect("seed account generation");

        assert!(ensure_account_generation(&conn, "account-a", 3).is_ok());
        conn.execute(
            "UPDATE accounts SET cache_generation = 4 WHERE id = 'account-a'",
            [],
        )
        .expect("simulate account removal and re-add");

        assert!(ensure_account_generation(&conn, "account-a", 3).is_err());
        assert!(ensure_account_generation(&conn, "account-a", 4).is_ok());
    }

    #[test]
    fn removing_an_account_deletes_its_attachments_and_invalidates_its_generation() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE accounts (id TEXT PRIMARY KEY, cache_generation INTEGER NOT NULL);
             CREATE TABLE account_generations (account_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
             CREATE TABLE emails (id TEXT, account_id TEXT);
             CREATE TABLE attachments (id TEXT, email_id TEXT, account_id TEXT);
             CREATE TABLE sync_state (account_id TEXT PRIMARY KEY);
             CREATE TABLE mailbox_cursors (account_id TEXT, label TEXT, next_page_token TEXT);
             INSERT INTO accounts VALUES ('account-a', 3), ('account-b', 1);
             INSERT INTO account_generations VALUES ('account-a', 3), ('account-b', 1);
             INSERT INTO emails VALUES ('mail-a', 'account-a'), ('mail-b', 'account-b');
             INSERT INTO attachments VALUES ('att-a', 'mail-a', 'account-a'), ('att-b', 'mail-b', 'account-b');
             INSERT INTO sync_state VALUES ('account-a'), ('account-b');
             INSERT INTO mailbox_cursors VALUES ('account-a', 'inbox', 'cursor-a'), ('account-b', 'inbox', 'cursor-b');",
        )
        .expect("seed account cache");

        remove_account_cache_from_conn(&mut conn, "account-a").expect("remove account cache");

        for table in ["accounts", "emails", "attachments", "sync_state", "mailbox_cursors"] {
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE account_id = 'account-a'"),
                    [],
                    |row| row.get(0),
                )
                .or_else(|_| {
                    conn.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE id = 'account-a'"),
                        [],
                        |row| row.get(0),
                    )
                })
                .expect("count removed account rows");
            assert_eq!(count, 0, "{table} still has removed-account data");
        }
        let generation: i64 = conn
            .query_row(
                "SELECT generation FROM account_generations WHERE account_id = 'account-a'",
                [],
                |row| row.get(0),
            )
            .expect("read invalidated generation");
        assert_eq!(generation, 4);
        let remaining_attachments: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE account_id = 'account-b'", [], |row| row.get(0))
            .expect("keep other account attachment");
        assert_eq!(remaining_attachments, 1);
    }

    #[test]
    fn orphaned_cache_diagnosis_counts_rows_without_returning_mail_content() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE emails (id TEXT, account_id TEXT, label TEXT, unread BOOLEAN);
             CREATE TABLE attachments (id TEXT, account_id TEXT);
             INSERT INTO emails VALUES
                ('orphan-unread', '', 'inbox', 1),
                ('orphan-read', '', 'inbox', 0),
                ('owned-unread', 'account-a', 'inbox', 1);
             INSERT INTO attachments VALUES ('orphan-att', ''), ('owned-att', 'account-a');",
        )
        .expect("seed orphaned cache");

        assert_eq!(
            orphaned_cache_counts_from_conn(&conn).expect("count orphaned cache"),
            OrphanedCacheCounts {
                emails: 2,
                inbox_unread: 1,
                attachments: 1,
            }
        );
    }

    #[test]
    fn orphaned_cache_purge_removes_only_rows_without_an_account_owner() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE emails (id TEXT, account_id TEXT);
             CREATE TABLE attachments (id TEXT, account_id TEXT);
             CREATE TABLE sync_state (account_id TEXT);
             CREATE TABLE mailbox_cursors (account_id TEXT);
             INSERT INTO emails VALUES ('orphan-mail', ''), ('owned-mail', 'account-a');
             INSERT INTO attachments VALUES ('orphan-att', ''), ('owned-att', 'account-a');
             INSERT INTO sync_state VALUES (''), ('account-a');
             INSERT INTO mailbox_cursors VALUES (''), ('account-a');",
        )
        .expect("seed cache rows");

        purge_orphaned_cache_from_conn(&mut conn).expect("purge orphaned cache");

        for table in ["emails", "attachments", "sync_state", "mailbox_cursors"] {
            let orphaned: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE account_id = ''"),
                    [],
                    |row| row.get(0),
                )
                .expect("count orphaned rows");
            let owned: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE account_id = 'account-a'"),
                    [],
                    |row| row.get(0),
                )
                .expect("count owned rows");
            assert_eq!(orphaned, 0, "{table} retained an orphaned row");
            assert_eq!(owned, 1, "{table} removed an owned row");
        }
    }

    #[test]
    fn local_search_covers_cached_metadata_and_respects_account_scope() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE emails (
                id TEXT, thread_id TEXT, sender TEXT, recipient TEXT, cc TEXT,
                subject TEXT, snippet TEXT, date INTEGER, unread BOOLEAN, label TEXT,
                account_id TEXT
             );
             INSERT INTO emails VALUES
                ('a-subject', 't-a', 'Alice <alice@example.test>', '', '', 'Project Atlas', '', 30, 1, 'archive', 'account-a'),
                ('a-recipient', 't-b', 'Bob <bob@example.test>', 'team@example.test', '', 'Status', 'Weekly update', 20, 0, 'sent', 'account-a'),
                ('b-subject', 't-c', 'Carol <carol@example.test>', '', '', 'Project Atlas', '', 10, 1, 'inbox', 'account-b'),
                ('orphan', 't-d', 'Legacy', '', '', 'Project Atlas', '', 40, 1, 'inbox', '');",
        )
        .expect("seed cached summaries");

        let account_a = search_local_emails_from_conn(&conn, "atlas", Some("account-a"), 50)
            .expect("search selected account");
        assert_eq!(account_a.iter().map(|email| email.id.as_str()).collect::<Vec<_>>(), ["a-subject"]);

        let all_accounts = search_local_emails_from_conn(&conn, "atlas", None, 50)
            .expect("search all accounts");
        assert_eq!(
            all_accounts.iter().map(|email| email.id.as_str()).collect::<Vec<_>>(),
            ["a-subject", "b-subject"]
        );

        let recipient = search_local_emails_from_conn(&conn, "team@example.test", Some("account-a"), 50)
            .expect("search recipient");
        assert_eq!(recipient.len(), 1);
        assert_eq!(recipient[0].id, "a-recipient");
    }

    #[test]
    fn contact_suggestions_are_scoped_to_the_sending_account() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE emails (sender TEXT, recipient TEXT, label TEXT, account_id TEXT);
             INSERT INTO emails VALUES
               ('Alice <alice@example.test>', '', 'inbox', 'account-a'),
               ('Bob <bob@example.test>', '', 'inbox', 'account-b'),
               ('', 'carol@example.test', 'sent', 'account-a'),
               ('', 'dave@example.test', 'sent', 'account-b');",
        )
        .expect("seed contacts");

        let account_a = search_contacts_from_conn(&conn, "example.test", "account-a")
            .expect("search account a contacts");
        let mut account_a_emails: Vec<&str> = account_a.iter().map(|contact| contact.email.as_str()).collect();
        account_a_emails.sort_unstable();
        assert_eq!(account_a_emails, ["alice@example.test", "carol@example.test"]);

        let account_b = search_contacts_from_conn(&conn, "example.test", "account-b")
            .expect("search account b contacts");
        let mut account_b_emails: Vec<&str> = account_b.iter().map(|contact| contact.email.as_str()).collect();
        account_b_emails.sort_unstable();
        assert_eq!(account_b_emails, ["bob@example.test", "dave@example.test"]);
    }

    #[test]
    fn resetting_local_cache_clears_all_accounts_and_invalidates_generations() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE accounts (id TEXT PRIMARY KEY, cache_generation INTEGER NOT NULL);
             CREATE TABLE account_generations (account_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
             CREATE TABLE emails (id TEXT, account_id TEXT);
             CREATE TABLE attachments (id TEXT, account_id TEXT);
             CREATE TABLE sync_state (account_id TEXT);
             CREATE TABLE mailbox_cursors (account_id TEXT);
             INSERT INTO accounts VALUES ('account-a', 4), ('account-b', 9);
             INSERT INTO account_generations VALUES ('account-a', 4), ('account-b', 9);
             INSERT INTO emails VALUES ('a-mail', 'account-a'), ('b-mail', 'account-b');
             INSERT INTO attachments VALUES ('a-attachment', 'account-a'), ('b-attachment', 'account-b');
             INSERT INTO sync_state VALUES ('account-a'), ('account-b');
             INSERT INTO mailbox_cursors VALUES ('account-a'), ('account-b');",
        )
        .expect("seed local cache");

        let invalidated = reset_local_mail_cache_from_conn(&mut conn, None)
            .expect("reset all local cache");
        assert_eq!(invalidated, vec!["account-a".to_string(), "account-b".to_string()]);
        for table in ["emails", "attachments", "sync_state", "mailbox_cursors"] {
            let count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .expect("count cleared cache rows");
            assert_eq!(count, 0, "{table} was not cleared");
        }
        let generations: Vec<(String, i64)> = conn
            .prepare("SELECT id, cache_generation FROM accounts ORDER BY id")
            .expect("prepare generation query")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query generations")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(generations, vec![("account-a".to_string(), 5), ("account-b".to_string(), 10)]);
    }

    #[test]
    fn unread_badge_uses_gmail_message_count_with_local_fallback_per_account() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE accounts (id TEXT PRIMARY KEY);
             CREATE TABLE sync_state (
                account_id TEXT PRIMARY KEY,
                gmail_inbox_messages_unread INTEGER,
                gmail_inbox_threads_unread INTEGER
             );
             CREATE TABLE emails (account_id TEXT, label TEXT, unread BOOLEAN);
             INSERT INTO accounts VALUES ('account-a'), ('account-b');
             INSERT INTO sync_state VALUES ('account-a', 5, 2);
             INSERT INTO emails VALUES
                ('account-a', 'inbox', 1), ('account-a', 'inbox', 1),
                ('account-b', 'inbox', 1), ('account-b', 'inbox', 1), ('account-b', 'inbox', 1),
                ('', 'inbox', 1);",
        )
        .expect("seed unread counts");

        assert_eq!(inbox_unread_count_from_conn(&conn, Some("account-a")).unwrap(), 5);
        assert_eq!(inbox_unread_count_from_conn(&conn, Some("account-b")).unwrap(), 3);
        assert_eq!(inbox_unread_count_from_conn(&conn, None).unwrap(), 8);
    }
}
