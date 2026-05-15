// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn focus_existing_instance() {
    use windows::{
        core::w,
        Win32::UI::WindowsAndMessaging::{
            FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
        },
    };

    unsafe {
        if let Ok(hwnd) = FindWindowW(None, w!("FURSOY Mail")) {
            if hwnd.0 != std::ptr::null_mut() {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                } else {
                    let _ = ShowWindow(hwnd, SW_SHOW);
                }
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn another_instance_is_running() -> bool {
    use windows::{
        core::w,
        Win32::{
            Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
            System::Threading::CreateMutexW,
        },
    };

    unsafe {
        match CreateMutexW(None, true, w!("Local\\FURSOYMailSingleInstance")) {
            Ok(_mutex) => GetLastError() == ERROR_ALREADY_EXISTS,
            Err(_) => false,
        }
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    if another_instance_is_running() {
        focus_existing_instance();
        return;
    }

    fursoy_mail_lib::run()
}
