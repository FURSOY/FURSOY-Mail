use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
    Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_SZ, REG_VALUE_TYPE,
    },
};

#[cfg(target_os = "windows")]
const STARTUP_VALUE_NAME: &str = "FURSOY Mail";

const APP_CONTROLS_FILE: &str = "app-controls.json";

fn default_app_language() -> String {
    "en".into()
}

fn default_notification_mode() -> String {
    "all".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppControls {
    #[serde(default = "default_notification_mode")]
    pub notification_mode: String,
    #[serde(default, rename = "notificationsMuted", skip_serializing)]
    legacy_notifications_muted: bool,
    pub mail_sync_paused: bool,
    pub quiet_hours_enabled: bool,
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
    #[serde(default = "default_app_language")]
    pub app_language: String,
}

impl Default for AppControls {
    fn default() -> Self {
        Self {
            notification_mode: default_notification_mode(),
            legacy_notifications_muted: false,
            mail_sync_paused: false,
            quiet_hours_enabled: false,
            quiet_hours_start: "22:00".into(),
            quiet_hours_end: "08:00".into(),
            app_language: "en".into(),
        }
    }
}

impl AppControls {
    pub fn notifications_disabled(&self) -> bool {
        self.notification_mode == "off"
    }

    pub fn allows_notification(&self, kind: Option<&str>, has_code: bool) -> bool {
        match self.notification_mode.as_str() {
            "off" => false,
            "otpOnly" => kind == Some("mail") && has_code,
            _ => true,
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
    let mut controls: AppControls = serde_json::from_str(&text).unwrap_or_default();
    if controls.legacy_notifications_muted {
        controls.notification_mode = "off".into();
        controls.legacy_notifications_muted = false;
    }
    if !matches!(
        controls.notification_mode.as_str(),
        "all" | "otpOnly" | "off"
    ) {
        controls.notification_mode = default_notification_mode();
    }
    controls
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
    if !matches!(
        controls.notification_mode.as_str(),
        "all" | "otpOnly" | "off"
    ) {
        return Err("Unsupported notification mode".into());
    }
    write_app_controls(&app, &controls)?;
    Ok(controls)
}

#[tauri::command]
pub fn set_notifications_muted(app: AppHandle, muted: bool) -> Result<AppControls, String> {
    let mut controls = read_app_controls(&app);
    controls.notification_mode = if muted { "off" } else { "all" }.into();
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

#[tauri::command]
pub fn set_app_language(app: AppHandle, language: String) -> Result<AppControls, String> {
    if language != "en" && language != "tr" {
        return Err("Unsupported app language".into());
    }
    let mut controls = read_app_controls(&app);
    controls.app_language = language;
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
fn startup_value_has_background_arg(value: &str) -> bool {
    value.contains("--background") || value.contains("--hidden") || value.contains("--minimized")
}

#[cfg(target_os = "windows")]
fn startup_value_matches_current_app(value: &str) -> Result<bool, String> {
    let exe = app_exe_path()?;
    let trimmed = value.trim();
    Ok(trimmed.trim_matches('"') == exe || trimmed.starts_with(&format!("\"{exe}\"")))
}

#[cfg(target_os = "windows")]
fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn reg_open(access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Result<HKEY, String> {
    let subkey = to_wide_null(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let mut hkey = HKEY::default();
    let err = unsafe {
        RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), Some(0), access, &mut hkey)
    };
    if err == ERROR_SUCCESS {
        Ok(hkey)
    } else {
        Err(format!("Registry acilamadi: {err:?}"))
    }
}

#[cfg(target_os = "windows")]
fn write_startup_value(command: &str) -> Result<(), String> {
    let hkey = reg_open(KEY_SET_VALUE)?;
    let value_name = to_wide_null(STARTUP_VALUE_NAME);
    let data: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2) };
    let err = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            None,
            REG_SZ,
            Some(bytes),
        )
    };
    unsafe { let _ = RegCloseKey(hkey); }
    if err == ERROR_SUCCESS { Ok(()) } else { Err(format!("Baslangic kaydi eklenemedi: {err:?}")) }
}

#[cfg(target_os = "windows")]
fn delete_startup_value() -> Result<(), String> {
    let hkey = match reg_open(KEY_SET_VALUE) {
        Ok(h) => h,
        Err(_) => return Ok(()), // key doesn't exist → already not set
    };
    let value_name = to_wide_null(STARTUP_VALUE_NAME);
    let err = unsafe { RegDeleteValueW(hkey, PCWSTR(value_name.as_ptr())) };
    unsafe { let _ = RegCloseKey(hkey); }
    if err == ERROR_SUCCESS || err == ERROR_FILE_NOT_FOUND { Ok(()) }
    else { Err(format!("Baslangic kaydi silinemedi: {err:?}")) }
}

#[cfg(target_os = "windows")]
fn read_startup_value() -> Result<Option<String>, String> {
    let hkey = match reg_open(KEY_READ) {
        Ok(h) => h,
        Err(_) => return Ok(None),
    };
    let value_name = to_wide_null(STARTUP_VALUE_NAME);
    let mut data_type = REG_VALUE_TYPE::default();
    let mut size: u32 = 0;
    // First call: get required buffer size
    let size_err = unsafe {
        RegQueryValueExW(hkey, PCWSTR(value_name.as_ptr()), None, Some(&mut data_type), None, Some(&mut size))
    };
    if size_err != ERROR_SUCCESS {
        unsafe { let _ = RegCloseKey(hkey); }
        return if size_err == ERROR_FILE_NOT_FOUND {
            Ok(None)
        } else {
            Err(format!("Baslangic kaydi okunamadi: {size_err:?}"))
        };
    }
    if size == 0 {
        unsafe { let _ = RegCloseKey(hkey); }
        return Ok(None);
    }
    let mut buffer = vec![0u8; size as usize];
    let err = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut data_type),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    unsafe { let _ = RegCloseKey(hkey); }
    if err != ERROR_SUCCESS { return Ok(None); }
    let words: Vec<u16> = buffer
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = String::from_utf16_lossy(&words).trim_end_matches('\0').to_string();
    Ok(if s.is_empty() { None } else { Some(s) })
}

#[tauri::command]
pub fn get_launch_at_startup() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(registered) = read_startup_value()? else {
            return Ok(false);
        };
        let matches = startup_value_matches_current_app(&registered)?;
        if matches && !startup_value_has_background_arg(&registered) {
            let _ = write_startup_value(&startup_command()?);
        }
        Ok(matches)
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
            write_startup_value(&command)?;
        } else {
            delete_startup_value()?;
        }

        get_launch_at_startup()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("Otomatik baslatma bu platformda desteklenmiyor.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::AppControls;

    #[test]
    fn notification_modes_filter_expected_payloads() {
        let mut controls = AppControls::default();
        assert!(controls.allows_notification(Some("mail"), false));
        assert!(controls.allows_notification(Some("update"), false));

        controls.notification_mode = "otpOnly".into();
        assert!(controls.allows_notification(Some("mail"), true));
        assert!(!controls.allows_notification(Some("mail"), false));
        assert!(!controls.allows_notification(Some("update"), true));

        controls.notification_mode = "off".into();
        assert!(controls.notifications_disabled());
        assert!(!controls.allows_notification(Some("mail"), true));
    }
}
