use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};

const REDIRECT_URI: &str = "http://127.0.0.1:8123/callback";
const OAUTH_SCOPES: &str = "https://www.googleapis.com/auth/gmail.modify \
                           https://www.googleapis.com/auth/userinfo.profile \
                           https://www.googleapis.com/auth/userinfo.email";

// ── Helpers ──────────────────────────────────────────────────────────────────

fn generate_random_string(len: usize) -> String {
    use rand::{distributions::Alphanumeric, Rng};
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn generate_pkce_pair() -> (String, String) {
    let verifier = generate_random_string(64);
    let hash = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash);
    (verifier, challenge)
}

// ── Credentials ──────────────────────────────────────────────────────────────

fn read_credential(name: &str, embedded: Option<&str>) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .or_else(|| embedded.map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} bulunamadi. Release build almadan once src-tauri/.env dosyasini kontrol edin."))
}

fn get_client_id() -> Result<String, String> {
    read_credential("GOOGLE_CLIENT_ID", option_env!("GOOGLE_CLIENT_ID"))
}

fn get_client_secret() -> Result<String, String> {
    read_credential("GOOGLE_CLIENT_SECRET", option_env!("GOOGLE_CLIENT_SECRET"))
}

// ── OAuth URL ─────────────────────────────────────────────────────────────────

fn build_auth_url(client_id: &str, state: &str, code_challenge: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("response_type", "code")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", OAUTH_SCOPES);
    Ok(url.to_string())
}

fn open_auth_url(app: &tauri::AppHandle, auth_url: String) -> Result<(), String> {
    match app.opener().open_url(auth_url.clone(), None::<&str>) {
        Ok(_) => Ok(()),
        Err(plugin_error) => {
            #[cfg(target_os = "windows")]
            {
                std::process::Command::new("cmd")
                    .args(["/C", "start", "", &auth_url])
                    .spawn()
                    .map_err(|fallback_error| {
                        format!("Tarayici acilamadi. Opener: {plugin_error}. Fallback: {fallback_error}")
                    })?;
                return Ok(());
            }

            #[cfg(not(target_os = "windows"))]
            {
                Err(format!("Tarayici acilamadi: {plugin_error}"))
            }
        }
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i32,
    pub token_type: String,
    pub scope: String,
}

#[derive(Deserialize)]
struct UserInfo {
    email: String,
    picture: Option<String>,
}

// ── Callback HTML ─────────────────────────────────────────────────────────────

const SUCCESS_HTML: &str = "\
<html><body style='display:flex;justify-content:center;align-items:center;\
height:100vh;background:#09090b;color:#fff;font-family:sans-serif;'>\
<h2>Sign-in successful! You can close this tab.</h2>\
<script>window.close();</script></body></html>";

const CSRF_HTML: &str = "\
<html><body style='display:flex;justify-content:center;align-items:center;\
height:100vh;background:#09090b;color:#f87171;font-family:sans-serif;'>\
<h2>A security error was detected. Please close this tab and try again.</h2></body></html>";

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_google_oauth(app: tauri::AppHandle) -> Result<crate::db::AuthInfo, String> {
    let client_id = get_client_id()?;

    let expected_state = generate_random_string(32);
    let (code_verifier, code_challenge) = generate_pkce_pair();
    let auth_url = build_auth_url(&client_id, &expected_state, &code_challenge)?;

    let listener = TcpListener::bind("127.0.0.1:8123")
        .await
        .map_err(|_| "Port 8123 kullanimda. Lutfen arkada acik kalan uygulamalari kapatin.")?;

    open_auth_url(&app, auth_url)?;

    let code_result: Result<Result<String, String>, _> =
        timeout(Duration::from_secs(120), async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    continue;
                };

                let mut reader = BufReader::new(&mut stream);
                let mut request_line = String::new();

                if reader.read_line(&mut request_line).await.is_err() {
                    continue;
                }

                if !request_line.starts_with("GET /callback") {
                    let _ = stream
                        .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
                        .await;
                    continue;
                }

                let after_get = &request_line[4..];
                let path_end = after_get.find(' ').unwrap_or(after_get.len());
                let full_url = format!("http://localhost:8123{}", &after_get[..path_end]);

                let url = match reqwest::Url::parse(&full_url) {
                    Ok(u) => u,
                    Err(_) => continue,
                };

                let mut code_val = String::new();
                let mut state_val = String::new();
                for (k, v) in url.query_pairs() {
                    match k.as_ref() {
                        "code" => code_val = v.into_owned(),
                        "state" => state_val = v.into_owned(),
                        _ => {}
                    }
                }

                if code_val.is_empty() {
                    continue;
                }

                if state_val != expected_state {
                    let resp = format!(
                        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\
                         Content-Type: text/html; charset=utf-8\r\n\r\n{}",
                        CSRF_HTML
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.flush().await;
                    drop(listener);
                    return Err(
                        "Güvenlik hatası: Oturum doğrulaması başarısız. Lütfen tekrar deneyin."
                            .to_string(),
                    );
                }

                let resp = format!(
                    "HTTP/1.1 200 OK\r\nConnection: close\r\n\
                     Content-Type: text/html; charset=utf-8\r\n\r\n{}",
                    SUCCESS_HTML
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.flush().await;
                drop(listener);
                return Ok(code_val);
            }
        })
        .await;

    let code = match code_result {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => return Err(e),
        _ => return Err("Giris islemi zaman asimina ugradi.".into()),
    };

    if code.is_empty() {
        return Err("Auth code bulunamadi".into());
    }

    let auth_resp = exchange_code_for_token(&code, &code_verifier).await?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();
    let user_res = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&auth_resp.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let user_info: UserInfo = user_res.json().await.map_err(|e| e.to_string())?;
    let picture = user_info.picture.unwrap_or_default();

    // Reuse existing refresh token if Google didn't send a new one
    let existing_refresh = crate::db::load_tokens(&user_info.email)
        .map(|(_, r)| r)
        .unwrap_or_default();
    let refresh_token = auth_resp.refresh_token.unwrap_or(existing_refresh);

    // Persist tokens to keyring
    crate::db::save_tokens(&user_info.email, &auth_resp.access_token, &refresh_token)?;

    // Create or update account record
    let account = crate::db::upsert_account(&app, &user_info.email, &picture)?;

    Ok(crate::db::AuthInfo {
        access_token: auth_resp.access_token,
        refresh_token,
        email: account.email,
        picture: account.picture,
    })
}

async fn exchange_code_for_token(code: &str, code_verifier: &str) -> Result<AuthResponse, String> {
    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();
    let params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT_URI),
        ("code_verifier", code_verifier),
    ];

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        let auth_resp: AuthResponse = res.json().await.map_err(|e| e.to_string())?;
        Ok(auth_resp)
    } else {
        let text = res.text().await.unwrap_or_default();
        Err(format!("Token alinamadi: {}", text))
    }
}

async fn refresh_access_token_once(
    app: tauri::AppHandle,
    account_id: &str,
) -> Result<crate::db::AuthInfo, String> {
    let (_, refresh_token) = crate::db::load_tokens(account_id)
        .ok_or_else(|| "Oturum bilgisi bulunamadı. Lütfen tekrar giriş yapın.".to_string())?;

    if refresh_token.is_empty() {
        return Err("No refresh token available. Please login again.".into());
    }

    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();
    let params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("refresh_token", refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed: {}", text));
    }

    let token_resp: AuthResponse = res.json().await.map_err(|e| e.to_string())?;
    let new_refresh = token_resp.refresh_token.unwrap_or(refresh_token);

    crate::db::save_tokens(account_id, &token_resp.access_token, &new_refresh)?;

    let picture = crate::db::get_account_picture(&app, account_id);

    Ok(crate::db::AuthInfo {
        access_token: token_resp.access_token,
        refresh_token: new_refresh,
        email: account_id.to_string(),
        picture,
    })
}

#[tauri::command]
pub async fn refresh_access_token(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<crate::db::AuthInfo, String> {
    let flights = app.state::<crate::TokenRefreshFlights>();
    if let Some(waiter) = flights.join_or_start(&account_id) {
        return waiter
            .await
            .map_err(|_| "Token refresh was interrupted".to_string())?;
    }

    let result = refresh_access_token_once(app.clone(), &account_id).await;
    flights.finish(&account_id, result.clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_requests_only_the_required_scopes() {
        let url = build_auth_url("client-id", "state", "challenge").expect("auth URL");
        let parsed = reqwest::Url::parse(&url).expect("valid auth URL");
        let scope = parsed
            .query_pairs()
            .find_map(|(key, value)| (key == "scope").then(|| value.into_owned()))
            .expect("scope query parameter");
        let scopes: Vec<_> = scope.split_whitespace().collect();

        assert_eq!(
            scopes,
            vec![
                "https://www.googleapis.com/auth/gmail.modify",
                "https://www.googleapis.com/auth/userinfo.profile",
                "https://www.googleapis.com/auth/userinfo.email",
            ]
        );
        assert!(!scope.contains("gmail.send"));
    }
}
