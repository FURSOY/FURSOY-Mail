use crate::db::{
    complete_full_sync, delete_emails_by_ids, finalize_full_sync, get_active_full_sync,
    get_account_cache_generation, get_all_mailbox_sync_states, get_history_id, get_mailbox_cursor_state, get_mailbox_sync_state,
    has_pending_mailbox_pages, load_tokens,
    next_full_sync_generation, set_history_id, set_mailbox_cursor, upsert_sync_attachments,
    upsert_sync_emails, set_gmail_inbox_unread_stats, set_mailbox_sync_state, Email,
};
use base64::Engine;
use futures::stream::{self, StreamExt, TryStreamExt};
use reqwest::{header::RETRY_AFTER, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const RATE_LIMIT_BACKOFF_SECS: i64 = 60;
const GMAIL_GET_MAX_ATTEMPTS: u32 = 3;
const GMAIL_GET_BASE_BACKOFF_MS: u64 = 400;
const GMAIL_GET_MAX_BACKOFF_MS: u64 = 5_000;
const GMAIL_GET_MAX_RETRY_AFTER_SECS: u64 = 30;

fn is_retryable_gmail_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn parse_retry_after_delay(value: &str) -> Option<std::time::Duration> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| std::time::Duration::from_secs(seconds.min(GMAIL_GET_MAX_RETRY_AFTER_SECS)))
}

fn retry_after_delay(response: &Response) -> Option<std::time::Duration> {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after_delay)
}

fn gmail_retry_delay(
    failed_attempt: u32,
    retry_after: Option<std::time::Duration>,
) -> std::time::Duration {
    let exponential_cap = GMAIL_GET_BASE_BACKOFF_MS
        .saturating_mul(1_u64 << failed_attempt.min(10))
        .min(GMAIL_GET_MAX_BACKOFF_MS);
    // Equal jitter keeps a meaningful delay while preventing concurrent account
    // syncs from retrying in lockstep.
    let half = exponential_cap / 2;
    let jittered_ms = half + rand::random::<u64>() % (exponential_cap - half + 1);
    std::time::Duration::from_millis(jittered_ms).max(retry_after.unwrap_or_default())
}

fn is_retryable_gmail_transport_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request()
}

/// Retry only idempotent Gmail GETs. Mutating POST/DELETE requests deliberately
/// stay on their existing single-attempt path so an ambiguous response cannot
/// duplicate a user action.
async fn gmail_get_with_retry(
    client: &Client,
    access_token: &str,
    url: String,
    error_context: &str,
) -> Result<Response, String> {
    for attempt in 0..GMAIL_GET_MAX_ATTEMPTS {
        match client.get(&url).bearer_auth(access_token).send().await {
            Ok(response)
                if is_retryable_gmail_status(response.status())
                    && attempt + 1 < GMAIL_GET_MAX_ATTEMPTS =>
            {
                let delay = gmail_retry_delay(attempt, retry_after_delay(&response));
                tokio::time::sleep(delay).await;
            }
            Ok(response) => return Ok(response),
            Err(error)
                if is_retryable_gmail_transport_error(&error)
                    && attempt + 1 < GMAIL_GET_MAX_ATTEMPTS =>
            {
                tokio::time::sleep(gmail_retry_delay(attempt, None)).await;
            }
            Err(error) => return Err(format!("{}: {}", error_context, error)),
        }
    }

    unreachable!("Gmail GET retry loop always returns on its final attempt")
}

fn unix_timestamp_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn mailbox_failure_status(error: &str) -> (&'static str, Option<i64>) {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("429")
        || normalized.contains("ratelimit")
        || normalized.contains("rate limit")
        || normalized.contains("userratelimitexceeded")
    {
        return ("rate_limited", Some(unix_timestamp_secs() + RATE_LIMIT_BACKOFF_SECS));
    }
    if normalized.contains("401")
        || normalized.contains("invalid credentials")
        || normalized.contains("unauthenticated")
    {
        return ("relogin_required", None);
    }
    ("error", Some(unix_timestamp_secs() + 15))
}

fn persist_mailbox_failure(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    error: &str,
) {
    if error == "Account is no longer available" {
        return;
    }
    let (status, retry_after) = mailbox_failure_status(error);
    if let Err(status_error) = set_mailbox_sync_state(
        app,
        account_id,
        account_generation,
        status,
        Some(error),
        retry_after,
    ) {
        eprintln!("[SYNC:{}] could not save mailbox status: {}", account_id, status_error);
    }
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct AttachmentPayload {
    pub filename: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub data: String, // base64-encoded file content
}

// ── History API types ──

#[derive(Deserialize, Debug)]
struct HistoryListResponse {
    history: Option<Vec<HistoryRecord>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(rename = "historyId")]
    history_id: Option<String>,
}

#[derive(Deserialize, Debug)]
struct HistoryRecord {
    #[serde(rename = "messagesAdded")]
    messages_added: Option<Vec<HistoryMessage>>,
    #[serde(rename = "messagesDeleted")]
    messages_deleted: Option<Vec<HistoryMessage>>,
    #[serde(rename = "labelsAdded")]
    labels_added: Option<Vec<HistoryLabelChange>>,
    #[serde(rename = "labelsRemoved")]
    labels_removed: Option<Vec<HistoryLabelChange>>,
}

#[derive(Deserialize, Debug)]
struct HistoryMessage {
    message: HistoryMessageRef,
}

#[derive(Deserialize, Debug)]
struct HistoryMessageRef {
    id: String,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct HistoryLabelChange {
    message: HistoryMessageRef,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct ProfileResponse {
    #[serde(rename = "historyId")]
    history_id: String,
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
struct GmailLabelStats {
    #[serde(rename = "messagesUnread")]
    messages_unread: i64,
    #[serde(rename = "threadsUnread")]
    threads_unread: i64,
}

// ── Get current historyId from Gmail profile ──
async fn get_profile_history_id(client: &Client, access_token: &str) -> Result<String, String> {
    let res = gmail_get_with_retry(
        client,
        access_token,
        "https://gmail.googleapis.com/gmail/v1/users/me/profile".to_string(),
        "Profile fetch error",
    )
    .await?;

    if !res.status().is_success() {
        return Err(format!("Profile API error: {}", res.status()));
    }

    let profile: ProfileResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(profile.history_id)
}

/// Gmail exposes both message and thread counts. The product badge intentionally
/// uses messagesUnread, matching the user's Gmail unread-message count.
async fn get_inbox_unread_stats(
    client: &Client,
    access_token: &str,
) -> Result<GmailLabelStats, String> {
    let res = gmail_get_with_retry(
        client,
        access_token,
        "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX".to_string(),
        "Inbox label fetch error",
    )
    .await?;

    if !res.status().is_success() {
        return Err(format!("Inbox label API error: {}", res.status()));
    }

    res.json().await.map_err(|e| e.to_string())
}

// ── Fetch history changes since a given historyId ──
async fn fetch_history(
    client: &Client,
    access_token: &str,
    start_history_id: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<String>, String), String> {
    // Returns: (added_ids, deleted_ids, changed_ids, new_history_id)
    let mut added_ids = std::collections::HashSet::new();
    let mut deleted_ids = std::collections::HashSet::new();
    let mut changed_ids = std::collections::HashSet::new();
    let mut latest_history_id = start_history_id.to_string();
    let mut page_token: Option<String> = None;

    loop {
        let mut url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId={}&maxResults=500",
            start_history_id
        );
        if let Some(ref token) = page_token {
            url.push_str(&format!("&pageToken={}", token));
        }

        let res = gmail_get_with_retry(client, access_token, url, "History fetch error").await?;

        let status = res.status();
        if status.as_u16() == 404 {
            return Err("HISTORY_EXPIRED".to_string());
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            if body.contains("notFound") || body.contains("Start history id is too old") {
                return Err("HISTORY_EXPIRED".to_string());
            }
            return Err(format!("History API error {}: {}", status, body));
        }

        let data: HistoryListResponse = res.json().await.map_err(|e| e.to_string())?;

        if let Some(hid) = &data.history_id {
            latest_history_id = hid.clone();
        }

        if let Some(records) = data.history {
            for record in records {
                if let Some(added) = record.messages_added {
                    for msg in added {
                        added_ids.insert(msg.message.id);
                    }
                }
                if let Some(deleted) = record.messages_deleted {
                    for msg in deleted {
                        deleted_ids.insert(msg.message.id);
                    }
                }
                if let Some(label_adds) = record.labels_added {
                    for change in label_adds {
                        changed_ids.insert(change.message.id);
                    }
                }
                if let Some(label_removes) = record.labels_removed {
                    for change in label_removes {
                        changed_ids.insert(change.message.id);
                    }
                }
            }
        }

        if data.next_page_token.is_none() {
            break;
        }
        page_token = data.next_page_token;
    }

    // Remove deleted from added/changed (if a message was added then deleted)
    for did in &deleted_ids {
        added_ids.remove(did);
        changed_ids.remove(did);
    }

    // Merge added + changed (both need a full fetch)
    let mut fetch_ids: Vec<String> = added_ids.into_iter().collect();
    for cid in changed_ids {
        if !fetch_ids.contains(&cid) {
            fetch_ids.push(cid);
        }
    }

    Ok((
        fetch_ids,
        deleted_ids.into_iter().collect(),
        vec![], // unused
        latest_history_id,
    ))
}

// ── Incremental sync using History API ──
async fn do_incremental_sync(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    access_token: &str,
    start_history_id: &str,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let (fetch_ids, delete_ids, _, new_history_id) =
        fetch_history(&client, access_token, start_history_id).await?;

    eprintln!(
        "[SYNC:{}] incremental: {} to fetch, {} to delete, new historyId={}",
        account_id,
        fetch_ids.len(),
        delete_ids.len(),
        new_history_id
    );

    // Fetch details for new/changed messages
    if !fetch_ids.is_empty() {
        let parsed: Vec<(Email, Vec<crate::db::Attachment>)> = stream::iter(fetch_ids)
            .map(|id| {
                let client = &client;
                let token = access_token;
                async move {
                    fetch_message_detail(client, token, &id)
                        .await
                        .map(parse_message_detail)
                }
            })
            .buffer_unordered(10)
            .try_collect()
            .await
            .map_err(|e| {
                format!(
                    "Incremental sync detail fetch failed; history checkpoint was not advanced: {}",
                    e
                )
            })?;

        if !parsed.is_empty() {
            let acct = account_id.to_string();
            let (emails, mut all_attachments): (Vec<Email>, Vec<Vec<crate::db::Attachment>>) =
                parsed.into_iter().unzip();
            // Backfill account_id into attachments (parse_message_detail doesn't know it)
            let atts_flat: Vec<crate::db::Attachment> = all_attachments
                .iter_mut()
                .flat_map(|v| v.iter_mut().map(|a| { a.account_id = acct.clone(); a.clone() }))
                .collect();
            let app_clone = app.clone();
            let acct2 = acct.clone();
            tokio::task::spawn_blocking(move || {
                upsert_sync_emails(&app_clone, &acct2, account_generation, None, emails)
                    .map_err(|e| e.to_string())?;
                upsert_sync_attachments(&app_clone, &acct2, account_generation, atts_flat)
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| format!("DB upsert task failed: {}", e))??;
        }
    }

    // Only remove local messages after every changed message was fetched and saved.
    if !delete_ids.is_empty() {
        let app_clone = app.clone();
        let account_id = account_id.to_string();
        tokio::task::spawn_blocking(move || delete_emails_by_ids(&app_clone, &account_id, account_generation, &delete_ids))
            .await
            .map_err(|e| format!("DB delete task failed: {}", e))??;
    }

    // Advancing this checkpoint is the final step: a failed sync must be retried
    // from the same history ID so Gmail does not permanently skip any change.
    if get_account_cache_generation(app, account_id)? != account_generation {
        return Err("Account is no longer available".to_string());
    }
    set_history_id(app, account_id, account_generation, &new_history_id)?;

    Ok(())
}

// ── Full sync ──
async fn do_sync(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    access_token: &str,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let profile_history_id = get_profile_history_id(&client, access_token).await?;
    let sync_generation = next_full_sync_generation(app, account_id)?;

    let mut all_ids = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut cursors = Vec::new();

    for label in ["inbox", "sent", "spam", "trash", "archive"] {
        let page = fetch_message_page(
            &client,
            access_token,
            mailbox_query(label).expect("known mailbox label"),
            None,
            100,
        )
        .await?;
        for msg in page.messages {
            if seen_ids.insert(msg.id.clone()) {
                all_ids.push(msg.id);
            }
        }
        cursors.push((label.to_string(), page.next_page_token));
    }

    eprintln!("[SYNC:{}] full sync: {} messages to fetch", account_id, all_ids.len());

    cache_message_details(
        app,
        account_id,
        &client,
        access_token,
        all_ids.into_iter().map(|id| MessageId { id }).collect(),
        Some(sync_generation),
        account_generation,
    )
    .await?;

    if get_account_cache_generation(app, account_id)? != account_generation {
        return Err("Account is no longer available".to_string());
    }
    complete_full_sync(
        app,
        account_id,
        account_generation,
        &cursors,
        &profile_history_id,
        sync_generation,
    )?;
    eprintln!("[SYNC:{}] full sync done, historyId={}", account_id, profile_history_id);

    Ok(())
}


#[derive(Deserialize, Debug)]
struct MessageListResponse {
    messages: Option<Vec<MessageId>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize, Debug)]
struct MessageId {
    id: String,
}

struct MessagePage {
    messages: Vec<MessageId>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Debug)]
struct MessageDetail {
    id: String,
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
    snippet: String,
    payload: Payload,
    #[serde(rename = "internalDate")]
    internal_date: String,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct Payload {
    headers: Vec<Header>,
    parts: Option<Vec<MessagePart>>,
    body: Option<MessageBody>,
}

#[derive(Deserialize, Debug)]
struct Header {
    name: String,
    value: String,
}

#[derive(Deserialize, Debug)]
struct MessagePart {
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(rename = "partId")]
    part_id: Option<String>,
    filename: Option<String>,
    headers: Option<Vec<Header>>,
    body: Option<MessageBody>,
    parts: Option<Vec<MessagePart>>,
}

#[derive(Deserialize, Debug)]
struct MessageBody {
    data: Option<String>,
    #[serde(rename = "attachmentId")]
    attachment_id: Option<String>,
    size: Option<i64>,
}

/// Determine the label for an email based on Gmail label IDs
fn determine_label(label_ids: &[String]) -> String {
    if label_ids.contains(&"SPAM".to_string()) {
        "spam".to_string()
    } else if label_ids.contains(&"TRASH".to_string()) {
        "trash".to_string()
    } else if label_ids.contains(&"SENT".to_string()) && !label_ids.contains(&"INBOX".to_string()) {
        "sent".to_string()
    } else if label_ids.contains(&"INBOX".to_string()) {
        "inbox".to_string()
    } else {
        "archive".to_string()
    }
}

/// Parse a single Gmail message detail into our Email struct + attachment list
fn parse_message_detail(detail: MessageDetail) -> (Email, Vec<crate::db::Attachment>) {
    let mut sender = "Unknown Sender".to_string();
    let mut recipient = String::new();
    let mut cc = String::new();
    let mut subject = "No Subject".to_string();

    for header in &detail.payload.headers {
        if header.name.eq_ignore_ascii_case("from") {
            sender = header.value.clone();
        } else if header.name.eq_ignore_ascii_case("to") {
            recipient = header.value.clone();
        } else if header.name.eq_ignore_ascii_case("cc") {
            cc = header.value.clone();
        } else if header.name.eq_ignore_ascii_case("subject") {
            subject = header.value.clone();
        }
    }

    // Parse HTML/Text body (base64url encoded)
    let mut body_html = String::new();

    if let Some(parts) = &detail.payload.parts {
        if let Some(data) = find_part_data(parts, "text/html") {
            body_html = decode_base64_url(data);
        }
    }

    if body_html.is_empty() {
        if let Some(parts) = &detail.payload.parts {
            if let Some(data) = find_part_data(parts, "text/plain") {
                body_html = decode_base64_url(data);
            }
        }
    }

    if body_html.is_empty() {
        if let Some(body) = &detail.payload.body {
            if let Some(data) = &body.data {
                body_html = decode_base64_url(data);
            }
        }
    }

    // Resolve Inline Images (CID)
    if let Some(parts) = &detail.payload.parts {
        let mut cids = std::collections::HashMap::new();
        collect_inline_images(parts, &mut cids);

        for (cid, data_uri) in cids {
            let cid_target = format!("cid:{}", cid);
            body_html = body_html.replace(&cid_target, &data_uri);
        }
    }

    let labels = detail.label_ids.unwrap_or_default();
    let is_unread = labels.contains(&"UNREAD".to_string());
    let label = determine_label(&labels);
    let date_i64 = detail.internal_date.parse::<i64>().unwrap_or(0);

    let attachments = if let Some(parts) = &detail.payload.parts {
        collect_attachments(parts, &detail.id, "")
    } else {
        vec![]
    };

    let email = Email {
        id: detail.id,
        thread_id: detail.thread_id.unwrap_or_default(),
        sender,
        recipient,
        cc,
        subject,
        snippet: detail.snippet,
        body_html,
        date: date_i64,
        unread: is_unread,
        label,
    };

    (email, attachments)
}

fn mailbox_query(label: &str) -> Result<&'static str, String> {
    match label {
        "inbox" => Ok("in:inbox"),
        "sent" => Ok("in:sent"),
        "spam" => Ok("in:spam"),
        "trash" => Ok("in:trash"),
        "archive" => Ok("-in:inbox -in:sent -in:spam -in:trash -in:drafts"),
        _ => Err("Unknown mailbox label".to_string()),
    }
}

/// Fetch one Gmail result page. We persist its continuation token so a later
/// scroll can continue where the initial cache stopped.
async fn fetch_message_page(
    client: &Client,
    access_token: &str,
    query: &str,
    page_token: Option<&str>,
    max_results: u32,
) -> Result<MessagePage, String> {
    let mut url = reqwest::Url::parse("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .map_err(|e| e.to_string())?;
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("maxResults", &max_results.min(100).to_string());
        params.append_pair("q", query);
        if let Some(token) = page_token {
            params.append_pair("pageToken", token);
        }
    }

    let res = gmail_get_with_retry(
        client,
        access_token,
        url.to_string(),
        "List fetch error",
    )
    .await?;

    if !res.status().is_success() {
        let status = res.status();
        return Err(format!(
            "Gmail API error {}: {}",
            status,
            res.text().await.unwrap_or_default()
        ));
    }

    let list_data: MessageListResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(MessagePage {
        messages: list_data.messages.unwrap_or_default(),
        next_page_token: list_data.next_page_token,
    })
}

/// Fetch full details of a single message
async fn fetch_message_detail(
    client: &Client,
    access_token: &str,
    msg_id: &str,
) -> Result<MessageDetail, String> {
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full",
        msg_id
    );
    let res = gmail_get_with_retry(client, access_token, url, "Detail fetch error").await?;

    if !res.status().is_success() {
        return Err(format!("Detail fetch API error: {}", res.status()));
    }

    res.json::<MessageDetail>().await.map_err(|e| e.to_string())
}

async fn backfill_mailbox(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    access_token: &str,
) -> Result<(), String> {
    let full_sync = get_active_full_sync(app, account_id)?;
    let sync_generation = full_sync.as_ref().map(|sync| sync.generation);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    for label in ["inbox", "sent", "spam", "trash", "archive"] {
        let mut seen_page_tokens = std::collections::HashSet::new();
        loop {
            let Some(Some(page_token)) = get_mailbox_cursor_state(app, account_id, label)? else {
                break;
            };
            if !seen_page_tokens.insert(page_token.clone()) {
                return Err(format!("Gmail pagination cursor repeated for {label}"));
            }
            let page = fetch_message_page(
                &client,
                access_token,
                mailbox_query(label)?,
                Some(&page_token),
                100,
            )
            .await?;
            let next_page_token = page.next_page_token;
            if next_page_token.as_deref() == Some(page_token.as_str()) {
                return Err(format!("Gmail pagination cursor did not advance for {label}"));
            }
            if get_account_cache_generation(app, account_id)? != account_generation {
                return Err("Account is no longer available".to_string());
            }
            cache_message_details(
                app,
                account_id,
                &client,
                access_token,
                page.messages,
                sync_generation,
                account_generation,
            )
            .await?;
            if get_account_cache_generation(app, account_id)? != account_generation {
                return Err("Account is no longer available".to_string());
            }
            set_mailbox_cursor(
                app,
                account_id,
                account_generation,
                label,
                next_page_token.as_deref(),
            )?;

            if next_page_token.is_none() {
                break;
            }
        }
    }

    if let Some(full_sync) = full_sync {
        if get_account_cache_generation(app, account_id)? != account_generation {
            return Err("Account is no longer available".to_string());
        }
        let removed = finalize_full_sync(
            app,
            account_id,
            account_generation,
            full_sync.generation,
        )?;
        eprintln!(
            "[SYNC:{}] full mailbox rebuild complete; removed {} stale local messages",
            account_id, removed
        );
    }

    set_mailbox_sync_state(
        app,
        account_id,
        account_generation,
        "completed",
        None,
        None,
    )?;

    Ok(())
}

async fn run_sync_cycle(
    app: &AppHandle,
    account_id: &str,
    account_generation: i64,
    initial_token: String,
) -> Result<String, String> {
    let mut token = initial_token;
    loop {
        if get_active_full_sync(app, account_id)?.is_some() {
            return Ok(token);
        }
        let history_id = get_history_id(app, account_id);
        if let Some(history_id) = history_id {
            match do_incremental_sync(app, account_id, account_generation, &token, &history_id).await {
                Ok(()) => {}
                Err(error) if error == "HISTORY_EXPIRED" => {
                    eprintln!("[SYNC:{}] history expired, full sync", account_id);
                    do_sync(app, account_id, account_generation, &token).await?;
                }
                Err(error) => return Err(error),
            }
        } else {
            do_sync(app, account_id, account_generation, &token).await?;
        }

        // Keep the displayed badge on Gmail's message-count semantics. This is
        // reconciliation data: direct UI actions still update the badge
        // optimistically instead of waiting for Gmail's label-stat propagation.
        let stats_client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        match get_inbox_unread_stats(&stats_client, &token).await {
            Ok(stats) => set_gmail_inbox_unread_stats(
                app,
                account_id,
                account_generation,
                stats.messages_unread,
                stats.threads_unread,
            )?,
            Err(error) => eprintln!("[SYNC:{}] inbox unread stats unavailable: {}", account_id, error),
        }

        let run_again = {
            let state = app.state::<crate::SyncState>();
            let mut workers = state.workers.lock().map_err(|_| "Sync worker lock poisoned")?;
            workers.take_resync_request(account_id, account_generation)
        };
        if !run_again {
            return Ok(token);
        }

        if let Some((fresh_access, _)) = load_tokens(account_id) {
            token = fresh_access;
        }
    }
}

async fn run_background_backfill_worker(
    app: AppHandle,
    account_id: String,
    account_generation: i64,
    mut token: String,
) {
    loop {
        let started = {
            let state = app.state::<crate::SyncState>();
            let started = match state.workers.lock() {
                Ok(mut workers) => {
                    workers.set_backfilling(&account_id, account_generation)
                }
                Err(_) => false,
            };
            started
        };
        if !started {
            return;
        }

        if let Err(error) = set_mailbox_sync_state(
            &app,
            &account_id,
            account_generation,
            "running",
            None,
            None,
        ) {
            eprintln!("[SYNC:{}] could not save mailbox status: {}", account_id, error);
        }

        let result = backfill_mailbox(&app, &account_id, account_generation, &token).await;
        if let Err(error) = &result {
            eprintln!("[SYNC:{}] background mailbox download paused: {}", account_id, error);
            persist_mailbox_failure(&app, &account_id, account_generation, error);
        }

        let run_again = {
            let state = app.state::<crate::SyncState>();
            let run_again = match state.workers.lock() {
                Ok(mut workers) => workers.take_resync_or_release(&account_id, account_generation),
                Err(_) => false,
            };
            run_again
        };
        if !run_again {
            return;
        }

        if let Some((fresh_access, _)) = load_tokens(&account_id) {
            token = fresh_access;
        }
        match run_sync_cycle(&app, &account_id, account_generation, token).await {
            Ok(fresh_token) => token = fresh_token,
            Err(error) => {
                eprintln!("[SYNC:{}] queued sync failed: {}", account_id, error);
                persist_mailbox_failure(&app, &account_id, account_generation, &error);
                if let Ok(mut workers) = app.state::<crate::SyncState>().workers.lock() {
                    workers.release(&account_id, account_generation);
                }
                return;
            }
        }
    }
}

fn start_background_backfill(
    app: &AppHandle,
    account_id: String,
    account_generation: i64,
    access_token: String,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_background_backfill_worker(app, account_id, account_generation, access_token).await;
    });
}

#[derive(Serialize)]
pub struct MailboxDownloadStatus {
    pub running: bool,
    pub pending: bool,
    pub state: String,
    #[serde(rename = "retryAfter")]
    pub retry_after: Option<i64>,
}

#[tauri::command]
pub fn get_mailbox_download_status(
    app: AppHandle,
    account_id: Option<String>,
) -> Result<MailboxDownloadStatus, String> {
    let state = app.state::<crate::SyncState>();
    let workers = state
        .workers
        .lock()
        .map_err(|_| "Sync worker lock poisoned")?;
    let running = workers.is_backfilling(account_id.as_deref());
    drop(workers);
    let pending = has_pending_mailbox_pages(&app, account_id.as_deref())?;
    let persisted = match account_id.as_deref() {
        Some(account_id) => get_mailbox_sync_state(&app, account_id)?,
        None => get_all_mailbox_sync_states(&app)?
            .into_iter()
            .max_by_key(|state| match state.status.as_str() {
                "relogin_required" => 4,
                "rate_limited" => 3,
                "error" | "paused" => 2,
                "waiting" => 1,
                _ => 0,
            }),
    };
    let retry_after = persisted.as_ref().and_then(|state| state.retry_after);
    let state = if running {
        "running".to_string()
    } else if let Some(state) = persisted {
        state.status
    } else if pending {
        "waiting".to_string()
    } else {
        "completed".to_string()
    };
    Ok(MailboxDownloadStatus { running, pending, state, retry_after })
}

#[tauri::command]
pub async fn sync_emails(
    app: AppHandle,
    account_id: String,
    access_token: String,
    force: Option<bool>,
) -> Result<(), String> {
    let account_generation = get_account_cache_generation(&app, &account_id)?;
    if !force.unwrap_or(false) {
        if let Some(state) = get_mailbox_sync_state(&app, &account_id)? {
            if state.retry_after.is_some_and(|at| at > unix_timestamp_secs()) {
                return Ok(());
            }
        }
    }
    let state = app.state::<crate::SyncState>();

    let owns_worker = state
        .workers
        .lock()
        .map_err(|_| "Sync worker lock poisoned")?
        .claim_or_request_resync(&account_id, account_generation);
    if !owns_worker {
        return Ok(());
    }

    set_mailbox_sync_state(
        &app,
        &account_id,
        account_generation,
        "running",
        None,
        None,
    )?;

    let token = match run_sync_cycle(&app, &account_id, account_generation, access_token).await {
        Ok(token) => token,
        Err(error) => {
            if let Ok(mut workers) = state.workers.lock() {
                workers.release(&account_id, account_generation);
            }
            persist_mailbox_failure(&app, &account_id, account_generation, &error);
            return Err(error);
        }
    };

    start_background_backfill(&app, account_id, account_generation, token);
    Ok(())
}

/// Refreshes exactly one open message without making the mail list wait for
/// Gmail or restarting mailbox pagination.
#[tauri::command]
pub async fn refresh_email_from_gmail(
    app: AppHandle,
    account_id: String,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    let account_generation = get_account_cache_generation(&app, &account_id)?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_default();
    let detail = fetch_message_detail(&client, &access_token, &message_id).await?;
    let (email, mut attachments) = parse_message_detail(detail);
    for attachment in &mut attachments {
        attachment.account_id = account_id.clone();
    }

    let app_for_db = app.clone();
    let account_for_db = account_id.clone();
    tokio::task::spawn_blocking(move || {
        upsert_sync_emails(
            &app_for_db,
            &account_for_db,
            account_generation,
            None,
            vec![email],
        )
        .map_err(|e| e.to_string())?;
        upsert_sync_attachments(
            &app_for_db,
            &account_for_db,
            account_generation,
            attachments,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Message refresh DB task failed: {e}"))??;

    Ok(())
}

async fn cache_message_details(
    app: &AppHandle,
    account_id: &str,
    client: &Client,
    access_token: &str,
    ids: Vec<MessageId>,
    sync_generation: Option<i64>,
    account_generation: i64,
) -> Result<(), String> {
    if get_account_cache_generation(app, account_id)? != account_generation {
        return Err("Account is no longer available".to_string());
    }
    let parsed: Vec<(Email, Vec<crate::db::Attachment>)> = stream::iter(ids)
        .map(|message| async move {
            fetch_message_detail(client, access_token, &message.id)
                .await
                .map(parse_message_detail)
        })
        .buffer_unordered(10)
        .try_collect()
        .await
        .map_err(|e| format!("Message detail fetch failed; mailbox cursor was not advanced: {e}"))?;

    if parsed.is_empty() {
        return Ok(());
    }

    let account_id = account_id.to_string();
    let (emails, mut attachments): (Vec<Email>, Vec<Vec<crate::db::Attachment>>) =
        parsed.into_iter().unzip();
    let attachments: Vec<crate::db::Attachment> = attachments
        .iter_mut()
        .flat_map(|items| {
            items.iter_mut().map(|attachment| {
                attachment.account_id = account_id.clone();
                attachment.clone()
            })
        })
        .collect();
    let app = app.clone();
    let account_for_db = account_id.clone();
    tokio::task::spawn_blocking(move || {
        upsert_sync_emails(
            &app,
            &account_for_db,
            account_generation,
            sync_generation,
            emails,
        )
        .map_err(|e| e.to_string())?;
        upsert_sync_attachments(&app, &account_for_db, account_generation, attachments)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("DB task failed: {}", e))??;

    Ok(())
}

#[tauri::command]
pub async fn archive_email(
    app: AppHandle,
    account_id: String,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // Remove INBOX from Gmail before changing the local cache.
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "removeLabelIds": ["INBOX"]
    });

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail archive error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    crate::db::update_email_label(&app, &message_id, &account_id, "archive")?;

    Ok(())
}

fn gmail_trash_request(client: &Client, url: &str, access_token: &str) -> reqwest::RequestBuilder {
    client
        .post(url)
        .bearer_auth(access_token)
        // Reqwest may omit Content-Length for an empty body. Gmail's action
        // endpoint requires the header even when the payload is zero bytes.
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .body(Vec::<u8>::new())
}

#[tauri::command]
pub async fn trash_email(
    app: AppHandle,
    account_id: String,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // Trash on Gmail before changing the local cache.
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/trash",
        message_id
    );

    let res = gmail_trash_request(&client, &url, &access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail trash error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    crate::db::update_email_label(&app, &message_id, &account_id, "trash")?;

    Ok(())
}

#[tauri::command]
pub async fn move_to_inbox(
    app: AppHandle,
    account_id: String,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // Add INBOX and remove SPAM/TRASH on Gmail before changing the local cache.
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "addLabelIds": ["INBOX"],
        "removeLabelIds": ["SPAM", "TRASH"]
    });

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail move error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    crate::db::update_email_label(&app, &message_id, &account_id, "inbox")?;

    Ok(())
}

#[tauri::command]
pub async fn permanently_delete(
    app: AppHandle,
    account_id: String,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // Permanently delete from Gmail before changing the local cache.
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
        message_id
    );

    let res = client
        .delete(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail delete error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    crate::db::delete_email_from_db(&app, &message_id, &account_id)?;

    Ok(())
}

/// RFC 2047 encodes a header value containing non-ASCII characters.
/// Uses UTF-8 base64 encoded-word format: =?UTF-8?B?<base64>?=
fn mime_encode_header(value: &str) -> String {
    if value.is_ascii() {
        return value.to_string();
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    format!("=?UTF-8?B?{}?=", encoded)
}

/// Base64-encodes a string body per RFC 2045 (wraps at 76 chars).
fn mime_body_base64(body: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(body.as_bytes());
    encoded
        .as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\r\n")
}

/// Builds a RFC 2822 raw email. Without attachments: simple text/html.
/// With attachments: multipart/mixed with HTML part + attachment parts.
fn build_raw_mime(headers: &[(&str, String)], body: &str, attachments: &[AttachmentPayload]) -> String {
    let mut lines = String::from("MIME-Version: 1.0\r\n");
    for (name, value) in headers {
        lines.push_str(&format!("{}: {}\r\n", name, value));
    }

    if attachments.is_empty() {
        lines.push_str("Content-Type: text/html; charset=\"UTF-8\"\r\n");
        lines.push_str("Content-Transfer-Encoding: base64\r\n");
        lines.push_str("\r\n");
        lines.push_str(&mime_body_base64(body));
    } else {
        let boundary = "----=_NextPart_fursoymail_001";
        lines.push_str(&format!("Content-Type: multipart/mixed; boundary=\"{}\"\r\n", boundary));
        lines.push_str("\r\n");

        // HTML body part
        lines.push_str(&format!("--{}\r\n", boundary));
        lines.push_str("Content-Type: text/html; charset=\"UTF-8\"\r\n");
        lines.push_str("Content-Transfer-Encoding: base64\r\n");
        lines.push_str("\r\n");
        lines.push_str(&mime_body_base64(body));
        lines.push_str("\r\n");

        // Attachment parts
        for att in attachments {
            let encoded_name = mime_encode_header(&att.filename);
            lines.push_str(&format!("--{}\r\n", boundary));
            lines.push_str(&format!("Content-Type: {}; name=\"{}\"\r\n", att.mime_type, encoded_name));
            lines.push_str("Content-Transfer-Encoding: base64\r\n");
            lines.push_str(&format!("Content-Disposition: attachment; filename=\"{}\"\r\n", encoded_name));
            lines.push_str("\r\n");
            // Wrap attachment data at 76 chars
            let wrapped = att.data.as_bytes().chunks(76)
                .map(|c| std::str::from_utf8(c).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\r\n");
            lines.push_str(&wrapped);
            lines.push_str("\r\n");
        }

        lines.push_str(&format!("--{}--\r\n", boundary));
    }

    lines
}

#[tauri::command]
pub async fn send_reply(
    app: tauri::AppHandle,
    account_id: String,
    access_token: String,
    to: String,
    subject: String,
    body: String,
    thread_id: String,
    message_id: String,
    attachments: Option<Vec<AttachmentPayload>>,
) -> Result<(), String> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let atts = attachments.unwrap_or_default();

    let clean_subject = subject.trim_start_matches("Re: ").trim_start_matches("re: ");
    let raw_email = build_raw_mime(
        &[
            ("To", to),
            ("Subject", format!("Re: {}", mime_encode_header(clean_subject))),
            ("In-Reply-To", message_id.clone()),
            ("References", message_id),
        ],
        &body,
        &atts,
    );

    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_email.as_bytes());

    let send_body = serde_json::json!({
        "raw": encoded,
        "threadId": thread_id
    });

    let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

    let res = client
        .post(url)
        .bearer_auth(&access_token)
        .json(&send_body)
        .send()
        .await
        .map_err(|e| format!("Send error: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail send error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    // Parse the response to get the sent message ID, then fetch and save to local DB
    let sent_msg: serde_json::Value = res.json().await.unwrap_or_default();
    let sent_id = sent_msg["id"].as_str().unwrap_or("").to_string();
    if !sent_id.is_empty() {
        if let Ok(detail) = fetch_message_detail(&client, &access_token, &sent_id).await {
            let (email, _) = parse_message_detail(detail);
            let app_clone = app.clone();
            let acct = account_id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::db::upsert_emails(&app_clone, &acct, vec![email])
            })
            .await;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn send_email(
    access_token: String,
    to: String,
    subject: String,
    body: String,
    attachments: Option<Vec<AttachmentPayload>>,
) -> Result<(), String> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let atts = attachments.unwrap_or_default();

    let raw_email = build_raw_mime(
        &[
            ("To", to),
            ("Subject", mime_encode_header(&subject)),
        ],
        &body,
        &atts,
    );

    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_email.as_bytes());

    let send_body = serde_json::json!({
        "raw": encoded
    });

    let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

    let res = client
        .post(url)
        .bearer_auth(&access_token)
        .json(&send_body)
        .send()
        .await
        .map_err(|e| format!("Send error: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail send error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn mark_as_read(
    app: AppHandle,
    account_id: String,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // Notify Gmail before changing the local cache.
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "removeLabelIds": ["UNREAD"]
    });

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail mark as read error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    crate::db::mark_email_as_read_local(&app, &message_id, &account_id)?;

    Ok(())
}

#[tauri::command]
pub async fn mark_as_unread(
    app: AppHandle,
    account_id: String,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // Notify Gmail before changing the local cache.
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "addLabelIds": ["UNREAD"]
    });

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail mark as unread error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    crate::db::mark_email_as_unread_local(&app, &message_id, &account_id)?;

    Ok(())
}

fn is_inline_part(part: &MessagePart) -> bool {
    part.headers.as_ref().map_or(false, |hdrs| {
        hdrs.iter().any(|h| {
            h.name.eq_ignore_ascii_case("Content-Disposition")
                && h.value.to_lowercase().starts_with("inline")
        })
    })
}

fn collect_attachments(
    parts: &[MessagePart],
    email_id: &str,
    account_id: &str,
) -> Vec<crate::db::Attachment> {
    let mut result = Vec::new();
    for part in parts {
        let filename = part.filename.as_deref().unwrap_or("").trim().to_string();
        if !filename.is_empty() && !is_inline_part(part) {
            if let Some(body) = &part.body {
                let size = body.size.unwrap_or(0);
                let part_key = part.part_id.as_deref().unwrap_or(&filename);
                let id = format!("{}_{}", email_id, part_key);
                result.push(crate::db::Attachment {
                    id,
                    email_id: email_id.to_string(),
                    account_id: account_id.to_string(),
                    filename,
                    mime_type: part.mime_type.clone(),
                    size,
                    attachment_id: body.attachment_id.clone(),
                    data: body.data.clone(),
                });
            }
        }
        if let Some(subparts) = &part.parts {
            result.extend(collect_attachments(subparts, email_id, account_id));
        }
    }
    result
}

fn collect_inline_images(
    parts: &[MessagePart],
    cids: &mut std::collections::HashMap<String, String>,
) {
    for part in parts {
        if part.mime_type.starts_with("image/") {
            if let Some(headers) = &part.headers {
                let mut content_id = String::new();
                for header in headers {
                    if header.name.eq_ignore_ascii_case("Content-ID") {
                        content_id = header.value.replace("<", "").replace(">", "");
                        break;
                    }
                }

                if !content_id.is_empty() {
                    if let Some(body) = &part.body {
                        if let Some(data) = &body.data {
                            let standard_b64 = data.replace("-", "+").replace("_", "/");
                            let data_uri =
                                format!("data:{};base64,{}", part.mime_type, standard_b64);
                            cids.insert(content_id, data_uri);
                        }
                    }
                }
            }
        }

        if let Some(subparts) = &part.parts {
            collect_inline_images(subparts, cids);
        }
    }
}

fn find_part_data<'a>(parts: &'a [MessagePart], mime_type: &str) -> Option<&'a String> {
    for part in parts {
        if part.mime_type == mime_type {
            if let Some(body) = &part.body {
                if let Some(data) = &body.data {
                    return Some(data);
                }
            }
        }
        if let Some(subparts) = &part.parts {
            if let Some(data) = find_part_data(subparts, mime_type) {
                return Some(data);
            }
        }
    }
    None
}

fn decode_base64_url(data: &str) -> String {
    let engine = base64::engine::general_purpose::URL_SAFE;
    if let Ok(decoded) = engine.decode(data) {
        String::from_utf8(decoded).unwrap_or_else(|_| "Decode Error".to_string())
    } else {
        "Base64 Error".to_string()
    }
}

/// Fetches attachment data (from DB for small files, Gmail API for large ones).
async fn get_attachment_bytes(
    app: &tauri::AppHandle,
    email_id: &str,
    account_id: &str,
    attachment_db_id: &str,
    access_token: &str,
) -> Result<(Vec<u8>, String, String), String> {
    let atts = crate::db::get_email_attachments(app.clone(), email_id.to_string(), account_id.to_string())
        .map_err(|e| e.to_string())?;
    let att = atts.into_iter().find(|a| a.id == attachment_db_id)
        .ok_or_else(|| "Attachment not found".to_string())?;

    let b64 = if let Some(data) = att.data.filter(|d| !d.is_empty()) {
        data
    } else {
        let gmail_att_id = att.attachment_id
            .ok_or_else(|| "No attachment ID".to_string())?;
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/attachments/{}",
            email_id, gmail_att_id
        );
        let res = gmail_get_with_retry(&client, access_token, url, "Fetch error").await?;
        if !res.status().is_success() {
            let status = res.status();
            return Err(format!(
                "Gmail API error {}: {}",
                status,
                res.text().await.unwrap_or_default()
            ));
        }
        #[derive(serde::Deserialize)]
        struct AttachmentResponse { data: String }
        let body: AttachmentResponse = res.json().await.map_err(|e| e.to_string())?;
        body.data
    };

    // Gmail uses URL-safe base64
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(b64.replace(['\n', '\r'], "").as_str())
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    Ok((bytes, att.filename, att.mime_type))
}

fn safe_attachment_filename(filename: &str) -> String {
    let basename = std::path::Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment")
        .trim();

    let cleaned: String = basename
        .chars()
        .map(|ch| {
            if ch.is_control()
                || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\u{202e}')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|ch: char| ch == '.' || ch == ' ');
    let cleaned: String = cleaned.chars().take(120).collect();
    let cleaned = cleaned.trim_matches(|ch: char| ch == '.' || ch == ' ');

    if cleaned.is_empty() {
        return "attachment".to_string();
    }

    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let is_reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));

    if is_reserved {
        let extension = std::path::Path::new(cleaned)
            .extension()
            .and_then(|extension| extension.to_str());
        match extension {
            Some(extension) if !extension.is_empty() => format!("{}_file.{}", stem, extension),
            _ => format!("{}_file", stem),
        }
    } else {
        cleaned.to_string()
    }
}

/// Saves attachment to Downloads folder and reveals it in Windows Explorer.
#[tauri::command]
pub async fn save_and_reveal_attachment(
    app: tauri::AppHandle,
    email_id: String,
    account_id: String,
    attachment_db_id: String,
    access_token: String,
) -> Result<String, String> {
    let (bytes, filename, _mime) =
        get_attachment_bytes(&app, &email_id, &account_id, &attachment_db_id, &access_token).await?;

    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| format!("Cannot find Downloads folder: {}", e))?;

    // A sender controls attachment filenames. Keep the saved file inside Downloads
    // instead of trusting path segments or Windows device names from the message.
    let safe_filename = safe_attachment_filename(&filename);
    let mut dest = downloads.join(&safe_filename);
    if dest.parent() != Some(downloads.as_path()) {
        return Err("Unsafe attachment filename".to_string());
    }

    // Avoid overwriting existing files by appending a counter
    if dest.exists() {
        let stem = std::path::Path::new(&safe_filename)
            .file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = std::path::Path::new(&safe_filename)
            .extension().and_then(|s| s.to_str()).unwrap_or("");
        let mut i = 2u32;
        loop {
            let candidate = if ext.is_empty() {
                format!("{} ({})", stem, i)
            } else {
                format!("{} ({}).{}", stem, i, ext)
            };
            dest = downloads.join(&candidate);
            if !dest.exists() { break; }
            i += 1;
        }
    }

    std::fs::write(&dest, &bytes)
        .map_err(|e| format!("Write error: {}", e))?;

    // Reveal file selected in Windows Explorer
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", dest.display()))
        .spawn();

    Ok(dest.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&safe_filename)
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        gmail_get_with_retry, gmail_retry_delay, gmail_trash_request, is_retryable_gmail_status,
        mailbox_failure_status, parse_retry_after_delay, safe_attachment_filename, GmailLabelStats,
        GMAIL_GET_MAX_RETRY_AFTER_SECS,
    };
    use reqwest::{Client, StatusCode};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn gmail_trash_post_has_explicit_zero_content_length() {
        let request = gmail_trash_request(
            &Client::new(),
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/test/trash",
            "test-token",
        )
        .build()
        .expect("build trash request");

        assert_eq!(
            request.headers().get(reqwest::header::CONTENT_LENGTH).unwrap(),
            "0"
        );
    }

    #[tokio::test]
    async fn gmail_get_retries_a_transient_response_then_succeeds() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake Gmail endpoint");
        let address = listener.local_addr().expect("read fake endpoint address");
        let server = tokio::spawn(async move {
            for status_line in [
                "HTTP/1.1 503 Service Unavailable",
                "HTTP/1.1 200 OK",
            ] {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let mut request = [0_u8; 1024];
                socket.read(&mut request).await.expect("read request");
                let response = format!(
                    "{status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write response");
            }
        });

        let response = gmail_get_with_retry(
            &Client::new(),
            "test-token",
            format!("http://{address}/gmail/v1/users/me/profile"),
            "Fake Gmail fetch error",
        )
        .await
        .expect("retry fake Gmail request");

        assert_eq!(response.status(), StatusCode::OK);
        server.await.expect("finish fake Gmail endpoint");
    }

    #[test]
    fn gmail_get_retries_only_rate_limits_and_server_failures() {
        assert!(is_retryable_gmail_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_gmail_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable_gmail_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!is_retryable_gmail_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_gmail_status(StatusCode::NOT_FOUND));
    }

    #[test]
    fn gmail_get_backoff_is_exponential_with_equal_jitter() {
        let first = gmail_retry_delay(0, None);
        assert!(first.as_millis() >= 200 && first.as_millis() <= 400);

        let second = gmail_retry_delay(1, None);
        assert!(second.as_millis() >= 400 && second.as_millis() <= 800);
    }

    #[test]
    fn gmail_get_honors_and_caps_numeric_retry_after() {
        assert_eq!(parse_retry_after_delay("7").unwrap().as_secs(), 7);
        assert_eq!(
            parse_retry_after_delay("999").unwrap().as_secs(),
            GMAIL_GET_MAX_RETRY_AFTER_SECS
        );
        assert!(parse_retry_after_delay("Wed, 21 Oct 2015 07:28:00 GMT").is_none());

        let delayed = gmail_retry_delay(0, parse_retry_after_delay("7"));
        assert_eq!(delayed.as_secs(), 7);
    }

    #[test]
    fn mailbox_failures_distinguish_rate_limits_and_relogin() {
        let (rate_limited, retry_after) = mailbox_failure_status("Gmail API Error: 429 rateLimitExceeded");
        assert_eq!(rate_limited, "rate_limited");
        assert!(retry_after.is_some());

        let (relogin_required, retry_after) = mailbox_failure_status("Gmail API Error: 401 unauthenticated");
        assert_eq!(relogin_required, "relogin_required");
        assert_eq!(retry_after, None);

        let (error, retry_after) = mailbox_failure_status("List fetch error: network unavailable");
        assert_eq!(error, "error");
        assert!(retry_after.is_some());
    }

    #[test]
    fn inbox_label_stats_keep_message_and_thread_counts_distinct() {
        let stats: GmailLabelStats = serde_json::from_str(
            r#"{"messagesUnread": 1046, "threadsUnread": 810}"#,
        )
        .expect("parse Gmail inbox label stats");

        assert_eq!(stats.messages_unread, 1046);
        assert_eq!(stats.threads_unread, 810);
    }

    #[test]
    fn attachment_filename_drops_path_components() {
        assert_eq!(safe_attachment_filename(r"..\..\Desktop\report.pdf"), "report.pdf");
        assert_eq!(safe_attachment_filename(r"C:\Windows\System32\hosts"), "hosts");
    }

    #[test]
    fn attachment_filename_replaces_windows_unsafe_characters() {
        assert_eq!(safe_attachment_filename("invoice:2026?.pdf"), "invoice_2026_.pdf");
        assert_eq!(safe_attachment_filename("NUL.txt"), "NUL_file.txt");
        assert_eq!(safe_attachment_filename("..."), "attachment");
    }
}

/// Returns raw base64 data — used for image thumbnail preview in the frontend.
#[tauri::command]
pub async fn fetch_attachment_data(
    app: tauri::AppHandle,
    email_id: String,
    account_id: String,
    attachment_db_id: String,
    access_token: String,
) -> Result<String, String> {
    let (bytes, _filename, _mime) =
        get_attachment_bytes(&app, &email_id, &account_id, &attachment_db_id, &access_token).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
