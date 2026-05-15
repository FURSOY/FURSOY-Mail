use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
const STARTUP_VALUE_NAME: &str = "FURSOY Mail";

#[cfg(target_os = "windows")]
const STARTUP_REG_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

const APP_CONTROLS_FILE: &str = "app-controls.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppControls {
    pub notifications_muted: bool,
    pub mail_sync_paused: bool,
    pub quiet_hours_enabled: bool,
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
}

impl Default for AppControls {
    fn default() -> Self {
        Self {
            notifications_muted: false,
            mail_sync_paused: false,
            quiet_hours_enabled: false,
            quiet_hours_start: "22:00".into(),
            quiet_hours_end: "08:00".into(),
        }
    }
}

fn controls_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Ayar klasoru bulunamadi: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Ayar klasoru olusturulamadi: {e}"))?;
    Ok(dir.join(APP_CONTROLS_FILE))
}

pub fn read_app_controls(app: &AppHandle) -> AppControls {
    let Ok(path) = controls_path(app) else {
        return AppControls::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return AppControls::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn write_app_controls(app: &AppHandle, controls: &AppControls) -> Result<(), String> {
    let path = controls_path(app)?;
    let json = serde_json::to_string_pretty(controls).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Ayarlar kaydedilemedi: {e}"))
}

#[tauri::command]
pub fn get_app_controls(app: AppHandle) -> AppControls {
    read_app_controls(&app)
}

#[tauri::command]
pub fn set_app_controls(app: AppHandle, controls: AppControls) -> Result<AppControls, String> {
    write_app_controls(&app, &controls)?;
    Ok(controls)
}

#[tauri::command]
pub fn set_notifications_muted(app: AppHandle, muted: bool) -> Result<AppControls, String> {
    let mut controls = read_app_controls(&app);
    controls.notifications_muted = muted;
    write_app_controls(&app, &controls)?;
    Ok(controls)
}

#[tauri::command]
pub fn set_mail_sync_paused(app: AppHandle, paused: bool) -> Result<AppControls, String> {
    let mut controls = read_app_controls(&app);
    controls.mail_sync_paused = paused;
    write_app_controls(&app, &controls)?;
    Ok(controls)
}

#[cfg(target_os = "windows")]
fn app_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| format!("Uygulama yolu okunamadi: {e}"))
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn startup_command() -> Result<String, String> {
    Ok(format!("\"{}\" --background", app_exe_path()?))
}

#[cfg(target_os = "windows")]
fn startup_value_matches_current_app(value: &str) -> Result<bool, String> {
    let exe = app_exe_path()?;
    let trimmed = value.trim();
    Ok(trimmed.trim_matches('"') == exe || trimmed.starts_with(&format!("\"{exe}\"")))
}

#[cfg(target_os = "windows")]
fn read_startup_value() -> Result<Option<String>, String> {
    let output = std::process::Command::new("reg")
        .args(["query", STARTUP_REG_PATH, "/v", STARTUP_VALUE_NAME])
        .output()
        .map_err(|e| format!("Baslangic kaydi okunamadi: {e}"))?;

    if !output.status.success() {
        return Ok(None);
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let value = text
        .lines()
        .find(|line| line.contains(STARTUP_VALUE_NAME))
        .and_then(|line| line.split("REG_SZ").nth(1))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Ok(value)
}

#[tauri::command]
pub fn get_launch_at_startup() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let registered = read_startup_value()?.unwrap_or_default();
        startup_value_matches_current_app(&registered)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn set_launch_at_startup(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let command = startup_command()?;
            let status = std::process::Command::new("reg")
                .args([
                    "add",
                    STARTUP_REG_PATH,
                    "/v",
                    STARTUP_VALUE_NAME,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &command,
                    "/f",
                ])
                .status()
                .map_err(|e| format!("Baslangic kaydi eklenemedi: {e}"))?;

            if !status.success() {
                return Err("Baslangic kaydi eklenemedi.".into());
            }
        } else {
            let status = std::process::Command::new("reg")
                .args(["delete", STARTUP_REG_PATH, "/v", STARTUP_VALUE_NAME, "/f"])
                .status()
                .map_err(|e| format!("Baslangic kaydi silinemedi: {e}"))?;

            if !status.success() && read_startup_value()?.is_some() {
                return Err("Baslangic kaydi silinemedi.".into());
            }
        }

        get_launch_at_startup()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("Otomatik baslatma bu platformda desteklenmiyor.".into())
    }
}
