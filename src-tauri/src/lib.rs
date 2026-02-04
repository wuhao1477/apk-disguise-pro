use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::Path;
use std::fs;

#[derive(Debug, Serialize, Deserialize)]
pub struct TrustedPrefix {
    pub prefix: String,
    pub count: i32,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessResult {
    pub success: bool,
    pub message: String,
    pub output_path: Option<String>,
    pub step: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppInfo {
    pub package_name: String,
    pub app_name: String,
    pub version: String,
    pub is_system: bool,
}

/// 检测 ADB 是否可用
#[tauri::command]
fn check_adb() -> Result<bool, String> {
    let output = Command::new("adb").arg("version").output();
    match output {
        Ok(out) => Ok(out.status.success()),
        Err(_) => Ok(false),
    }
}

/// 获取已连接的设备列表
#[tauri::command]
fn get_devices() -> Result<Vec<String>, String> {
    let output = Command::new("adb")
        .args(["devices", "-l"])
        .output()
        .map_err(|e| e.to_string())?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let devices: Vec<String> = stdout
        .lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty() && line.contains("device"))
        .map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if !parts.is_empty() { parts[0].to_string() } else { line.to_string() }
        })
        .collect();
    
    Ok(devices)
}

/// 扫描设备上已安装应用，提取可信任的包名前缀
#[tauri::command]
fn scan_trusted_prefixes(device_id: String) -> Result<Vec<TrustedPrefix>, String> {
    let output = Command::new("adb")
        .args(["-s", &device_id, "shell", "pm", "list", "packages"])
        .output()
        .map_err(|e| e.to_string())?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut prefix_map: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
    
    for line in stdout.lines() {
        if let Some(pkg) = line.strip_prefix("package:") {
            let parts: Vec<&str> = pkg.split('.').collect();
            if parts.len() >= 2 {
                let prefix = format!("{}.{}", parts[0], parts[1]);
                *prefix_map.entry(prefix).or_insert(0) += 1;
            }
        }
    }
    
    let system_prefixes = ["com.android", "com.google", "android.hardware", "vendor.mediatek"];
    let mut trusted: Vec<TrustedPrefix> = prefix_map
        .into_iter()
        .filter(|(prefix, count)| *count >= 2 && !system_prefixes.iter().any(|sys| prefix.starts_with(sys)))
        .map(|(prefix, count)| TrustedPrefix { prefix, count, source: "device_scan".to_string() })
        .collect();
    
    trusted.sort_by(|a, b| b.count.cmp(&a.count));
    trusted.insert(0, TrustedPrefix { prefix: "cn.chinapost".to_string(), count: 999, source: "recommended".to_string() });
    trusted.insert(1, TrustedPrefix { prefix: "com.nlscan".to_string(), count: 100, source: "recommended".to_string() });
    
    Ok(trusted)
}

/// 获取设备上已安装的应用列表
#[tauri::command]
fn get_installed_apps(device_id: String) -> Result<Vec<AppInfo>, String> {
    // 获取所有应用（包括系统应用）
    let all_output = Command::new("adb")
        .args(["-s", &device_id, "shell", "pm", "list", "packages", "-f"])
        .output()
        .map_err(|e| e.to_string())?;
    
    // 获取系统应用列表
    let system_output = Command::new("adb")
        .args(["-s", &device_id, "shell", "pm", "list", "packages", "-s"])
        .output()
        .map_err(|e| e.to_string())?;
    
    let all_stdout = String::from_utf8_lossy(&all_output.stdout);
    let system_stdout = String::from_utf8_lossy(&system_output.stdout);
    
    // 解析系统应用包名
    let system_packages: std::collections::HashSet<String> = system_stdout
        .lines()
        .filter_map(|line| line.strip_prefix("package:"))
        .map(|s| s.trim().to_string())
        .collect();
    
    let mut apps: Vec<AppInfo> = Vec::new();
    
    for line in all_stdout.lines() {
        // 格式: package:/path/to/app.apk=com.example.app
        if let Some(content) = line.strip_prefix("package:") {
            if let Some(eq_pos) = content.rfind('=') {
                let package_name = content[eq_pos + 1..].trim().to_string();
                let is_system = system_packages.contains(&package_name);
                
                // 尝试获取应用名称（使用包名最后一段作为简化名称）
                let app_name = package_name
                    .split('.')
                    .last()
                    .map(|s| {
                        // 将驼峰或下划线转为可读名称
                        let mut result = String::new();
                        for (i, c) in s.chars().enumerate() {
                            if i > 0 && c.is_uppercase() {
                                result.push(' ');
                            }
                            result.push(c);
                        }
                        result.replace('_', " ")
                    })
                    .unwrap_or_else(|| package_name.clone());
                
                apps.push(AppInfo {
                    package_name: package_name.clone(),
                    app_name,
                    version: String::new(), // 版本信息需要额外命令获取，暂时留空
                    is_system,
                });
            }
        }
    }
    
    // 按名称排序
    apps.sort_by(|a, b| a.app_name.to_lowercase().cmp(&b.app_name.to_lowercase()));
    
    Ok(apps)
}

/// 卸载应用
#[tauri::command]
fn uninstall_app(device_id: String, package_name: String) -> Result<bool, String> {
    let output = Command::new("adb")
        .args(["-s", &device_id, "shell", "pm", "uninstall", &package_name])
        .output()
        .map_err(|e| e.to_string())?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.contains("Success"))
}

/// 完整的 APK 处理流程
#[tauri::command]
async fn process_apk_full(
    apk_path: String,
    new_prefix: String,
    custom_suffix: Option<String>,
    device_id: Option<String>,
    install_after: bool,
    java_path: String,
    apktool_path: String,
    zipalign_path: String,
    apksigner_path: String,
    keystore_path: String,
) -> Result<ProcessResult, String> {
    let path = Path::new(&apk_path);
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("apk");
    let parent_dir = path.parent().unwrap_or(Path::new("."));
    let work_dir = std::env::temp_dir().join(format!("apk_disguise_{}", file_stem));
    let rebuilt_apk = parent_dir.join(format!("{}_rebuilt.apk", file_stem));
    let aligned_apk = parent_dir.join(format!("{}_aligned.apk", file_stem));
    let final_apk = parent_dir.join(format!("{}_fixed.apk", file_stem));
    
    let _ = fs::remove_dir_all(&work_dir);
    
    // 第一步：反编译
    let decompile = Command::new(&java_path)
        .args(["-jar", &apktool_path, "d", &apk_path, "-o", work_dir.to_str().unwrap(), "-f", "-s"])
        .output()
        .map_err(|e| format!("反编译命令执行失败: {}", e))?;
    
    if !decompile.status.success() {
        let stderr = String::from_utf8_lossy(&decompile.stderr);
        let stdout = String::from_utf8_lossy(&decompile.stdout);
        return Ok(ProcessResult {
            success: false,
            message: format!("反编译失败: {} {}", stderr, stdout),
            output_path: None,
            step: Some("decompile".to_string()),
        });
    }
    
    // 第二步：修改包名
    let manifest_path = work_dir.join("AndroidManifest.xml");
    let manifest_content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取 Manifest 失败: {}", e))?;
    
    // 使用自定义后缀或从文件名生成
    let suffix = match &custom_suffix {
        Some(s) if !s.is_empty() => s.clone(),
        _ => {
            let clean: String = file_stem.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
            if clean.len() > 12 { clean[..12].to_string() } else { clean }
        }
    };
    let new_package = format!("{}.{}", new_prefix, suffix);
    
    let re = regex::Regex::new(r#"package="[^"]+""#).unwrap();
    let mut new_manifest = re.replace(&manifest_content, &format!("package=\"{}\"", new_package)).to_string();
    
    if !new_manifest.contains("<uses-sdk") {
        if let Some(pos) = new_manifest.find("<application") {
            new_manifest.insert_str(pos, "    <uses-sdk android:minSdkVersion=\"19\" android:targetSdkVersion=\"27\"/>\n    ");
        }
    }
    
    fs::write(&manifest_path, &new_manifest).map_err(|e| format!("写入 Manifest 失败: {}", e))?;
    
    // 第三步：回编译
    let rebuild = Command::new(&java_path)
        .args(["-jar", &apktool_path, "b", work_dir.to_str().unwrap(), "-o", rebuilt_apk.to_str().unwrap()])
        .output()
        .map_err(|e| format!("回编译命令执行失败: {}", e))?;
    
    if !rebuild.status.success() {
        let stderr = String::from_utf8_lossy(&rebuild.stderr);
        let stdout = String::from_utf8_lossy(&rebuild.stdout);
        return Ok(ProcessResult {
            success: false,
            message: format!("回编译失败: {} {}", stderr, stdout),
            output_path: None,
            step: Some("rebuild".to_string()),
        });
    }
    
    // 第四步：对齐
    let align = Command::new(&zipalign_path)
        .args(["-f", "-v", "4", rebuilt_apk.to_str().unwrap(), aligned_apk.to_str().unwrap()])
        .output()
        .map_err(|e| format!("对齐命令执行失败: {}", e))?;
    
    if !align.status.success() {
        let stderr = String::from_utf8_lossy(&align.stderr);
        return Ok(ProcessResult {
            success: false,
            message: format!("对齐失败: {}", stderr),
            output_path: Some(rebuilt_apk.to_string_lossy().to_string()),
            step: Some("zipalign".to_string()),
        });
    }
    
    // 第五步：签名
    let sign = Command::new(&java_path)
        .args([
            "-jar", &apksigner_path, "sign",
            "--ks", &keystore_path,
            "--ks-pass", "pass:123456",
            "--ks-key-alias", "my-alias",
            "--key-pass", "pass:123456",
            "--v1-signing-enabled", "true",
            "--v2-signing-enabled", "false",
            "--out", final_apk.to_str().unwrap(),
            aligned_apk.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("签名命令执行失败: {}", e))?;
    
    if !sign.status.success() {
        let stderr = String::from_utf8_lossy(&sign.stderr);
        return Ok(ProcessResult {
            success: false,
            message: format!("签名失败: {}", stderr),
            output_path: Some(aligned_apk.to_string_lossy().to_string()),
            step: Some("sign".to_string()),
        });
    }
    
    let _ = fs::remove_file(&rebuilt_apk);
    let _ = fs::remove_file(&aligned_apk);
    let _ = fs::remove_dir_all(&work_dir);
    
    // 第六步：安装
    if install_after {
        if let Some(device) = device_id {
            let install = Command::new("adb")
                .args(["-s", &device, "install", "-r", "-t", "-g", final_apk.to_str().unwrap()])
                .output();
            
            match install {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    if out.status.success() && stdout.contains("Success") {
                        return Ok(ProcessResult {
                            success: true,
                            message: format!("✅ 安装成功! 新包名: {}", new_package),
                            output_path: Some(final_apk.to_string_lossy().to_string()),
                            step: Some("install".to_string()),
                        });
                    } else {
                        return Ok(ProcessResult {
                            success: false,
                            message: format!("安装失败: {}", stdout),
                            output_path: Some(final_apk.to_string_lossy().to_string()),
                            step: Some("install".to_string()),
                        });
                    }
                }
                Err(e) => {
                    return Ok(ProcessResult {
                        success: false,
                        message: format!("安装命令执行失败: {}", e),
                        output_path: Some(final_apk.to_string_lossy().to_string()),
                        step: Some("install".to_string()),
                    });
                }
            }
        }
    }
    
    Ok(ProcessResult {
        success: true,
        message: format!("✅ 处理完成! 新包名: {}", new_package),
        output_path: Some(final_apk.to_string_lossy().to_string()),
        step: Some("complete".to_string()),
    })
}

#[tauri::command]
fn resolve_tool_paths(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let tools_dir = resource_dir.join("tools");
    
    let mut paths = serde_json::Map::new();
    
    // Apktool
    let apktool = tools_dir.join("apktool.jar");
    if apktool.exists() {
        paths.insert("apktool".to_string(), serde_json::Value::String(apktool.to_string_lossy().to_string()));
    }
    
    // Zipalign
    #[cfg(target_os = "windows")]
    let zipalign = tools_dir.join("zipalign.exe");
    #[cfg(not(target_os = "windows"))]
    let zipalign = tools_dir.join("zipalign");
    
    if zipalign.exists() {
        paths.insert("zipalign".to_string(), serde_json::Value::String(zipalign.to_string_lossy().to_string()));
    }
    
    // Apksigner
    let apksigner = tools_dir.join("apksigner.jar");
    if apksigner.exists() {
        paths.insert("apksigner".to_string(), serde_json::Value::String(apksigner.to_string_lossy().to_string()));
    }
    
    // Keystore (Release key)
    let keystore = tools_dir.join("release-key.jks");
    if keystore.exists() {
        paths.insert("keystore".to_string(), serde_json::Value::String(keystore.to_string_lossy().to_string()));
    }

    Ok(serde_json::Value::Object(paths))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())  // 使用 fs 插件
        .invoke_handler(tauri::generate_handler![
            check_adb,
            get_devices,
            scan_trusted_prefixes,
            get_installed_apps,
            uninstall_app,
            process_apk_full,
            resolve_tool_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
