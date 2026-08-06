// RX Store Desktop Application
// Built with Tauri (Rust + WebView)

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::{Manager, SystemTray, SystemTrayMenu, SystemTrayMenuItem, CustomMenuItem};

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("open".to_string(), "Open RX Store"))
        .add_item(CustomMenuItem::new("check_updates".to_string(), "Check for Updates"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("quit".to_string(), "Quit"));

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            tauri::SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "open" => {
                    if let Some(window) = app.get_window("main") {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                    }
                }
                "check_updates" => {
                    // Trigger update check
                    println!("Checking for updates...");
                }
                "quit" => {
                    std::process::exit(0);
                }
                _ => {}
            },
            tauri::SystemTrayEvent::LeftClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_installed_apps,
            install_app,
            uninstall_app,
            launch_app,
            check_for_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RX Store");
}

#[tauri::command]
fn get_installed_apps() -> Vec<String> {
    // Read installed apps from local storage
    vec!["clinical-rx".to_string(), "curelink".to_string()]
}

#[tauri::command]
fn install_app(app_id: String) -> Result<String, String> {
    // Download and install application
    Ok(format!("Installing {}...", app_id))
}

#[tauri::command]
fn uninstall_app(app_id: String) -> Result<String, String> {
    Ok(format!("Uninstalled {}", app_id))
}

#[tauri::command]
fn launch_app(app_id: String) -> Result<String, String> {
    Ok(format!("Launching {}...", app_id))
}

#[tauri::command]
fn check_for_updates() -> bool {
    // Check API for available updates
    false
}
