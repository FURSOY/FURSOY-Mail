use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window};

const WINDOW_STATE_FILE: &str = "window-state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Pencere ayar klasoru bulunamadi: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Pencere ayar klasoru olusturulamadi: {e}"))?;
    Ok(dir.join(WINDOW_STATE_FILE))
}

pub fn restore_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let Ok(path) = state_path(app) else {
        return;
    };

    let Ok(text) = fs::read_to_string(path) else {
        return;
    };

    let Ok(state) = serde_json::from_str::<PersistedWindowState>(&text) else {
        return;
    };

    if state.width < 640 || state.height < 420 {
        return;
    }

    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    if saved_position_is_visible(app, &state) {
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    } else {
        let _ = window.center();
    }

    if state.fullscreen {
        let _ = window.set_fullscreen(true);
    } else if state.maximized {
        let _ = window.maximize();
    }
}

pub fn save_window_state(window: &Window) {
    if window.label() != "main" {
        return;
    }

    let Ok(is_minimized) = window.is_minimized() else {
        return;
    };
    if is_minimized {
        return;
    }

    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);

    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };

    if size.width < 640 || size.height < 420 {
        return;
    }

    let state = PersistedWindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized,
        fullscreen,
    };

    let app = window.app_handle();
    let Ok(path) = state_path(&app) else {
        return;
    };
    let Ok(json) = serde_json::to_string_pretty(&state) else {
        return;
    };

    let _ = fs::write(path, json);
}

fn saved_position_is_visible(app: &AppHandle, state: &PersistedWindowState) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return true;
    };

    if monitors.is_empty() {
        return true;
    }

    let center_x = state.x + (state.width as i32 / 2);
    let center_y = state.y + (state.height as i32 / 2);

    monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let left = position.x;
        let top = position.y;
        let right = left + size.width as i32;
        let bottom = top + size.height as i32;
        center_x >= left && center_x <= right && center_y >= top && center_y <= bottom
    })
}
