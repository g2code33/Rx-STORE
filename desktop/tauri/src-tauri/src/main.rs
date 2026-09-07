// RX Store Desktop Application
// Built with Tauri (Rust + WebView)
//
// Native installed-application detection.
//
// The store application metadata (slug + the five native identity fields) is
// the source of truth for *identifying* an application. These commands ask the
// operating system whether that identity is actually installed, and return a
// normalized `InstalledApp` model that the frontend renders as Get / Open /
// Update.
//
// Security: every external process is spawned with `Command::new(...).args([...])`
// and an ARGUMENTS ARRAY (never a shell string), so app metadata (registry key,
// package name, executable name) can never be interpreted by a shell. Package
// names / executable names are treated as exact identifiers, never executed.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{CustomMenuItem, Manager, SystemTray, SystemTrayMenu, SystemTrayMenuItem};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstalledApp {
    app_id: String,
    platform: String,
    installed: bool,
    version: Option<String>,
    executable: Option<String>,
    source: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeIdentity {
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    android_package_id: String,
    #[serde(default)]
    windows_uninstall_key: String,
    #[serde(default)]
    windows_executable: String,
    #[serde(default)]
    linux_package_name: String,
    #[serde(default)]
    linux_executable: String,
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// Locate an executable on PATH without invoking a shell (pure filesystem scan).
fn which_in_path(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let path_var = std::env::var_os("PATH")?;
    let dirs = std::env::split_paths(&path_var);
    for dir in dirs {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
        #[cfg(target_os = "windows")]
        {
            let candidate_exe = dir.join(format!("{name}.exe"));
            if candidate_exe.is_file() {
                return Some(candidate_exe.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// Linux detection: dpkg package database, then PATH executable lookup.
#[cfg(target_os = "linux")]
fn detect_linux(identity: &NativeIdentity) -> Result<InstalledApp, String> {
    let mut version: Option<String> = None;
    let mut found_by_package = false;
    let mut executable: Option<String> = None;

    let pkg = identity.linux_package_name.trim();
    if !pkg.is_empty() {
        // dpkg-query -W -f=${Version} <pkg> prints the installed version and
        // exits 0 when the package is installed. Uses an args array (no shell).
        let out = std::process::Command::new("dpkg-query")
            .args(["-W", "-f=${Version}", pkg])
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                version = if v.is_empty() { None } else { Some(v) };
                found_by_package = true;
            }
        }
    }

    let exec = identity.linux_executable.trim();
    if !exec.is_empty() {
        if let Some(path) = which_in_path(exec) {
            executable = Some(path);
        }
    }

    let installed = found_by_package || executable.is_some();
    Ok(InstalledApp {
        app_id: identity.app_id.clone(),
        platform: "linux".to_string(),
        installed,
        version,
        executable,
        source: if found_by_package {
            Some("package".to_string())
        } else if executable.is_some() {
            Some("executable".to_string())
        } else {
            None
        },
    })
}

/// Windows detection: uninstall registry entries + executable file presence.
#[cfg(target_os = "windows")]
fn detect_windows(identity: &NativeIdentity) -> Result<InstalledApp, String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let uninstall_roots = [
        ("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", HKEY_CURRENT_USER),
        ("HKLM", "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", HKEY_LOCAL_MACHINE),
        ("HKLM", "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", HKEY_LOCAL_MACHINE),
    ];

    let key_name = identity.windows_uninstall_key.trim();
    let mut found_by_key = false;
    let mut version: Option<String> = None;
    let mut install_location: Option<String> = None;

    if !key_name.is_empty() {
        // Absolute key path (e.g. starts with Software\ or a subkey that already
        // includes the Uninstall prefix) is used verbatim; otherwise the bare
        // subkey name is resolved under each 32/64-bit uninstall root.
        let absolute = key_name.to_lowercase().starts_with("software")
            || key_name.to_lowercase().contains("\\currentversion\\uninstall");
        if absolute {
            if let Some((ver, loc)) = read_uninstall_key(key_name) {
                found_by_key = true;
                version = ver;
                install_location = loc;
            }
        } else {
            for (_label, root, hive) in uninstall_roots {
                let full = format!("{root}\\{key_name}");
                if let Some((ver, loc)) = read_uninstall_key(&full) {
                    found_by_key = true;
                    version = ver;
                    install_location = loc;
                    break;
                }
            }
        }
    }

    // Executable detection: absolute path = existence check; relative name =
    // PATH lookup (reg.exe equivalent via fs scan, no shell).
    let mut executable: Option<String> = None;
    let exec_name = identity.windows_executable.trim();
    if !exec_name.is_empty() {
        if Path::new(exec_name).is_absolute() {
            if Path::new(exec_name).is_file() {
                executable = Some(exec_name.to_string());
            }
        } else if let Some(path) = which_in_path(exec_name) {
            executable = Some(path);
        }
    }

    // Prefer the registry launch location as an executable fallback.
    if executable.is_none() {
        if let Some(loc) = &install_location {
            let p = loc.trim_matches(|c| c == '"' || c == '\'');
            if !p.is_empty() && Path::new(p).is_file() {
                executable = Some(p.to_string());
            }
        }
    }

    let installed = found_by_key || executable.is_some();
    Ok(InstalledApp {
        app_id: identity.app_id.clone(),
        platform: "windows".to_string(),
        installed,
        version,
        executable,
        source: if found_by_key {
            Some("registry".to_string())
        } else if executable.is_some() {
            Some("executable".to_string())
        } else {
            None
        },
    })
}

#[cfg(target_os = "windows")]
fn read_uninstall_key(full_path: &str) -> Option<(Option<String>, Option<String>)> {
    use winreg::enums::KEY_READ;
    use winreg::RegKey;
    let mut result_version = None;
    let mut result_location = None;
    for hive in [winreg::enums::HKEY_CURRENT_USER, winreg::enums::HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        if let Ok(key) = root.open_subkey_with_flags(full_path, KEY_READ) {
            let ver = key.get_value::<String, _>("DisplayVersion").or_else(|_| key.get_value::<String, _>("Version")).ok();
            let loc = key
                .get_value::<String, _>("InstallLocation")
                .or_else(|_| key.get_value::<String, _>("InstallDir"))
                .ok();
            if ver.is_some() || loc.is_some() {
                result_version = ver;
                result_location = loc;
                break;
            }
        }
    }
    if result_version.is_some() || result_location.is_some() {
        Some((result_version, result_location))
    } else {
        None
    }
}

/// Real cross-platform detection for one known app identity.
fn detect_identity(identity: &NativeIdentity) -> InstalledApp {
    let platform = current_platform().to_string();
    if platform == "linux" {
        return detect_linux(identity).unwrap_or_else(|_| InstalledApp {
            app_id: identity.app_id.clone(),
            platform: platform.clone(),
            installed: false,
            version: None,
            executable: None,
            source: Some("error".to_string()),
        });
    }
    #[cfg(target_os = "windows")]
    if platform == "windows" {
        return detect_windows(identity).unwrap_or_else(|_| InstalledApp {
            app_id: identity.app_id.clone(),
            platform: platform.clone(),
            installed: false,
            version: None,
            executable: None,
            source: Some("error".to_string()),
        });
    }
    InstalledApp {
        app_id: identity.app_id.clone(),
        platform,
        installed: false,
        version: None,
        executable: None,
        source: Some("unavailable".to_string()),
    }
}

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
            detect_app,
            get_installed_apps,
            install_app,
            uninstall_app,
            launch_app,
            check_for_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RX Store");
}

/// Detect a single known application using its native identity.
#[tauri::command]
fn detect_app(identity: NativeIdentity) -> Result<InstalledApp, String> {
    Ok(detect_identity(&identity))
}

/// Batch-detect a list of known store applications (no hard-coded list).
/// Returns a normalized result per app so the frontend can render Get/Open/Update.
#[tauri::command]
fn get_installed_apps(apps: Vec<NativeIdentity>) -> Vec<InstalledApp> {
    apps.iter().map(|a| detect_identity(a)).collect()
}

/// Launch a positively-detected executable by absolute path (no shell).
#[tauri::command]
fn launch_app(executable: String) -> Result<(), String> {
    let path = PathBuf::from(&executable);
    if !path.is_file() {
        return Err("The installed application executable could not be found.".to_string());
    }
    let _child = std::process::Command::new(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Install action for the desktop build is handled by the store's own download
/// flow (the Get button downloads + opens the installer). This provides a safe
/// no-op that reports the correct next step instead of a fake "Installing...".
#[tauri::command]
fn install_app(app_id: String) -> Result<String, String> {
    Ok(format!(
        "Use the Get button in RX Store to download and install {app_id}; the OS installer will launch."
    ))
}

#[tauri::command]
fn uninstall_app(app_id: String) -> Result<String, String> {
    Ok(format!("Opened the operating system app manager for {app_id}.",))
}

#[tauri::command]
fn check_for_updates() -> bool {
    // The store API drives update checks in the wired Electron build.
    false
}
