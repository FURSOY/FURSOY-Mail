#[cfg(target_os = "windows")]
const STARTUP_VALUE_NAME: &str = "FURSOY Mail";

#[cfg(target_os = "windows")]
const STARTUP_REG_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(target_os = "windows")]
fn app_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| format!("Uygulama yolu okunamadi: {e}"))
        .map(|path| path.to_string_lossy().to_string())
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
        let expected = app_exe_path()?;
        let registered = read_startup_value()?.unwrap_or_default();
        Ok(registered.trim_matches('"') == expected)
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
            let exe = app_exe_path()?;
            let quoted_exe = format!("\"{exe}\"");
            let status = std::process::Command::new("reg")
                .args([
                    "add",
                    STARTUP_REG_PATH,
                    "/v",
                    STARTUP_VALUE_NAME,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &quoted_exe,
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
