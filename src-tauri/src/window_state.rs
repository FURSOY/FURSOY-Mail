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

fn read_window_state(app: &AppHandle) -> Option<PersistedWindowState> {
    let path = state_path(app).ok()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<PersistedWindowState>(&text).ok()
}

pub fn restore_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let Some(state) = read_window_state(app) else {
        return;
    };

    if state.width < 600 || state.height < 600 {
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
    let previous_state = read_window_state(&window.app_handle());

    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };

    if size.width < 600 || size.height < 600 {
        return;
    }

    let (width, height, x, y) = if maximized || fullscreen {
        previous_state
            .map(|state| (state.width, state.height, state.x, state.y))
            .unwrap_or((size.width, size.height, position.x, position.y))
    } else {
        (size.width, size.height, position.x, position.y)
    };

    let state = PersistedWindowState {
        width,
        height,
        x,
        y,
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
