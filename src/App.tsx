import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

interface TrustedPrefix { prefix: string; count: number; source: string; }
interface ProcessResult { success: boolean; message: string; output_path: string | null; }
interface AppInfo { package_name: string; app_name: string; version: string; is_system: boolean; }

type LogLevel = "info" | "success" | "error" | "warning" | "verbose";
type LogMode = "simple" | "verbose";
type Theme = "light" | "dark";
type View = "disguise" | "apps" | "settings";

function App() {
  // Theme
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("apk-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  // State
  const [activeView, setActiveView] = useState<View>("disguise");
  const [adbConnected, setAdbConnected] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [apkPath, setApkPath] = useState("");
  const [apkName, setApkName] = useState("");
  const [packagePrefix, setPackagePrefix] = useState("cn.chinapost");
  const [trustedPrefixes, setTrustedPrefixes] = useState<TrustedPrefix[]>([
    { prefix: "cn.chinapost", count: 999, source: "recommended" },
    { prefix: "com.nlscan", count: 10, source: "recommended" },
  ]);
  const [installAfter, setInstallAfter] = useState(true);
  const [logs, setLogs] = useState<{ text: string; level: LogLevel; id: number }[]>([]);
  const [logMode, setLogMode] = useState<LogMode>("simple");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const logIdRef = useRef(0);

  // 高级设置
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customSuffix, setCustomSuffix] = useState("");
  const [useCustomSuffix, setUseCustomSuffix] = useState(false);

  // Apps
  const [installedApps, setInstalledApps] = useState<AppInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadingApps, setLoadingApps] = useState(false);
  const [showSystemApps, setShowSystemApps] = useState(false);

  // 删除确认
  const [deleteConfirm, setDeleteConfirm] = useState<{ app: AppInfo | null; step: number; inputValue: string }>({
    app: null, step: 0, inputValue: ""
  });

  // Settings
  const [javaPath, setJavaPath] = useState("java"); // 默认尝试从 PATH 使用
  const [apktoolPath, setApktoolPath] = useState("");
  const [zipalignPath, setZipalignPath] = useState("");
  const [apksignerPath, setApksignerPath] = useState("");
  const [keystorePath, setKeystorePath] = useState("");

  // 自动检测工具路径
  useEffect(() => {
    invoke<any>("resolve_tool_paths").then(paths => {
      if (paths.apktool) setApktoolPath(paths.apktool);
      if (paths.zipalign) setZipalignPath(paths.zipalign);
      if (paths.apksigner) setApksignerPath(paths.apksigner);
      if (paths.keystore) setKeystorePath(paths.keystore);
      console.log("Resolved tools:", paths);
    }).catch(e => console.error("Found tool resolution error:", e));
  }, []);

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("apk-theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme(p => p === "dark" ? "light" : "dark");

  const addLog = useCallback((text: string, level: LogLevel = "info") => {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const id = ++logIdRef.current;
    setLogs(prev => [...prev.slice(-100), { text: `${ts}  ${text}`, level, id }]);
  }, []);

  // ADB
  const checkAdb = useCallback(async () => {
    try {
      const connected = await invoke<boolean>("check_adb");
      setAdbConnected(connected);
      if (connected) {
        const list = await invoke<string[]>("get_devices");
        setDevices(list);
        if (list.length > 0 && !selectedDevice) {
          setSelectedDevice(list[0]);
          addLog(`已连接 ${list.length} 个设备`, "success");
        }
      }
    } catch (e) { addLog(`ADB 错误: ${e}`, "error"); }
  }, [selectedDevice, addLog]);

  const scanPrefixes = useCallback(async () => {
    if (!selectedDevice) return;
    try {
      const prefixes = await invoke<TrustedPrefix[]>("scan_trusted_prefixes", { deviceId: selectedDevice });
      setTrustedPrefixes(prefixes);
    } catch (e) { addLog(`扫描失败: ${e}`, "error"); }
  }, [selectedDevice, addLog]);

  // Load Apps
  const loadApps = useCallback(async () => {
    if (!selectedDevice) {
      addLog("请先连接设备", "warning");
      return;
    }
    setLoadingApps(true);
    addLog("正在加载应用列表...", "info");

    try {
      const apps = await invoke<AppInfo[]>("get_installed_apps", { deviceId: selectedDevice });
      setInstalledApps(apps);
      const userApps = apps.filter(a => !a.is_system).length;
      const sysApps = apps.filter(a => a.is_system).length;
      addLog(`已加载 ${apps.length} 个应用 (用户: ${userApps}, 系统: ${sysApps})`, "success");
    } catch (e) {
      addLog(`加载失败: ${e}`, "error");
    } finally {
      setLoadingApps(false);
    }
  }, [selectedDevice, addLog]);

  // 开始删除流程
  const startUninstall = (app: AppInfo) => {
    setDeleteConfirm({ app, step: 1, inputValue: "" });
  };

  // 确认删除
  const confirmUninstall = async () => {
    const { app, step, inputValue } = deleteConfirm;
    if (!app) return;

    if (app.is_system) {
      // 系统应用需要两步确认
      if (step === 1) {
        // 第一步：输入包名
        setDeleteConfirm({ ...deleteConfirm, step: 2 });
      } else if (step === 2) {
        // 检查输入的包名是否正确
        if (inputValue !== app.package_name) {
          addLog("包名输入错误，取消删除", "error");
          setDeleteConfirm({ app: null, step: 0, inputValue: "" });
          return;
        }
        setDeleteConfirm({ ...deleteConfirm, step: 3 });
      } else if (step === 3) {
        // 最终确认
        await doUninstall(app);
      }
    } else {
      // 用户应用只需一步确认
      if (step === 1) {
        setDeleteConfirm({ ...deleteConfirm, step: 2 });
      } else {
        await doUninstall(app);
      }
    }
  };

  const doUninstall = async (app: AppInfo) => {
    addLog(`正在卸载 ${app.package_name}...`, "info");
    try {
      const success = await invoke<boolean>("uninstall_app", { deviceId: selectedDevice, packageName: app.package_name });
      if (success) {
        addLog(`${app.app_name} 卸载成功`, "success");
        setInstalledApps(prev => prev.filter(a => a.package_name !== app.package_name));
      } else {
        addLog(`卸载失败`, "error");
      }
    } catch (e) {
      addLog(`卸载失败: ${e}`, "error");
    }
    setDeleteConfirm({ app: null, step: 0, inputValue: "" });
  };

  const cancelUninstall = () => {
    setDeleteConfirm({ app: null, step: 0, inputValue: "" });
  };

  useEffect(() => { checkAdb(); }, [checkAdb]);
  useEffect(() => { if (selectedDevice) scanPrefixes(); }, [selectedDevice, scanPrefixes]);

  // 当选择 APK 时，自动生成默认后缀
  useEffect(() => {
    if (apkName && !useCustomSuffix) {
      const stem = apkName.replace(/\.apk$/i, "");
      const clean = stem.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
      setCustomSuffix(clean || "app");
    }
  }, [apkName, useCustomSuffix]);

  // File
  const handleSelectFile = async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: "APK", extensions: ["apk"] }] });
      if (selected && typeof selected === "string") {
        setApkPath(selected);
        const name = selected.split(/[/\\]/).pop() || "unknown.apk";
        setApkName(name);
        addLog(`已选择: ${name}`, "success");
      }
    } catch (e) { addLog(`选择失败: ${e}`, "error"); }
  };

  // Process
  const handleProcess = async () => {
    if (!apkPath) { addLog("请先选择 APK 文件", "error"); return; }
    setProcessing(true);
    setProgress(0);

    const finalSuffix = useCustomSuffix && customSuffix ? customSuffix : null;

    addLog("━━━━━━━━ 开始处理 ━━━━━━━━", "info");
    addLog(`源文件: ${apkName}`, "verbose");
    addLog(`目标前缀: ${packagePrefix}`, "verbose");
    if (finalSuffix) {
      addLog(`自定义后缀: ${finalSuffix}`, "verbose");
      addLog(`完整包名: ${packagePrefix}.${finalSuffix}`, "info");
    }

    try {
      setProgress(10);
      addLog("[1/6] 反编译 APK...", "verbose");

      const result = await invoke<ProcessResult>("process_apk_full", {
        apkPath,
        newPrefix: packagePrefix,
        customSuffix: finalSuffix,
        deviceId: installAfter && selectedDevice ? selectedDevice : null,
        installAfter,
        javaPath,
        apktoolPath,
        zipalignPath,
        apksignerPath,
        keystorePath,
      });
      setProgress(100);
      addLog(result.message, result.success ? "success" : "error");
      if (result.output_path) addLog(`输出: ${result.output_path}`, "verbose");
    } catch (e) { addLog(`失败: ${e}`, "error"); }
    finally {
      setProcessing(false);
      addLog("━━━━━━━━ 处理完成 ━━━━━━━━", "info");
    }
  };

  // 过滤日志 - 修复版本
  const displayLogs = logMode === "verbose"
    ? logs
    : logs.filter(l => l.level !== "verbose");

  // 过滤应用列表
  const filteredApps = installedApps
    .filter(a => showSystemApps || !a.is_system)
    .filter(a =>
      a.app_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.package_name.toLowerCase().includes(searchQuery.toLowerCase())
    );

  const userAppsCount = installedApps.filter(a => !a.is_system).length;
  const systemAppsCount = installedApps.filter(a => a.is_system).length;

  const viewTitles: Record<View, string> = {
    disguise: "APK 伪装",
    apps: "应用管理",
    settings: "设置",
  };

  return (
    <div className="desktop-app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-icon">📦</div>
            <div className="brand-text">
              <h1>APK Disguise</h1>
              <span>Pro v2.0</span>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">
            <div className="nav-section-title">工具</div>
            <button className={`nav-item ${activeView === "disguise" ? "active" : ""}`} onClick={() => setActiveView("disguise")}>
              <span className="nav-icon">🎭</span>
              <span className="nav-label">APK 伪装</span>
            </button>
            <button className={`nav-item ${activeView === "apps" ? "active" : ""}`} onClick={() => setActiveView("apps")}>
              <span className="nav-icon">📱</span>
              <span className="nav-label">应用管理</span>
            </button>
          </div>
          <div className="nav-section" style={{ marginTop: "auto" }}>
            <button className={`nav-item ${activeView === "settings" ? "active" : ""}`} onClick={() => setActiveView("settings")}>
              <span className="nav-icon">⚙️</span>
              <span className="nav-label">设置</span>
            </button>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="device-card">
            <div className={`device-status ${adbConnected ? "connected" : ""}`}></div>
            <div className="device-info">
              <div className="device-label">当前设备</div>
              <div className="device-name">{selectedDevice || "未连接"}</div>
            </div>
            <div className="device-actions">
              <button className="icon-btn" onClick={checkAdb} title="刷新">🔄</button>
            </div>
          </div>
          <div className="theme-row">
            <span className="theme-label">深色模式</span>
            <div className={`theme-toggle ${theme === "dark" ? "dark" : ""}`} onClick={toggleTheme}></div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="main-area">
        <header className="toolbar">
          <h2 className="toolbar-title">{viewTitles[activeView]}</h2>
          {activeView === "disguise" && devices.length > 1 && (
            <div className="toolbar-actions">
              <select className="form-select" style={{ width: 180 }} value={selectedDevice} onChange={e => setSelectedDevice(e.target.value)}>
                {devices.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}
        </header>

        <div className="content">
          {/* Disguise Panel */}
          <div className={`panel ${activeView === "disguise" ? "active" : ""}`}>
            <div className="form-grid">
              <div className="card">
                <div className="card-header">
                  <span className="card-title">选择 APK 文件</span>
                </div>
                <div className={`file-drop ${apkPath ? "has-file" : ""}`} onClick={handleSelectFile}>
                  <div className="file-drop-icon">{apkPath ? "✅" : "📁"}</div>
                  <div className="file-drop-text">
                    {apkPath ? <div className="file-name">{apkName}</div> : <><h4>点击选择文件</h4><p>支持 .apk 格式</p></>}
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <span className="card-title">伪装配置</span>
                </div>
                <div className="form-group">
                  <label className="form-label">包名前缀</label>
                  <select className="form-select" value={packagePrefix} onChange={e => setPackagePrefix(e.target.value)}>
                    {trustedPrefixes.map(p => (
                      <option key={p.prefix} value={p.prefix}>{p.prefix} {p.source === "recommended" ? "⭐" : `(${p.count})`}</option>
                    ))}
                  </select>
                </div>
                <label className="form-check">
                  <input type="checkbox" checked={installAfter} onChange={e => setInstallAfter(e.target.checked)} />
                  <span>处理后自动安装到设备</span>
                </label>

                {/* 高级选项折叠 */}
                <div className="advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
                  <span>{showAdvanced ? "▼" : "▶"} 高级选项</span>
                </div>

                {showAdvanced && (
                  <div className="advanced-options">
                    <label className="form-check">
                      <input type="checkbox" checked={useCustomSuffix} onChange={e => setUseCustomSuffix(e.target.checked)} />
                      <span>自定义包名后缀</span>
                    </label>
                    {useCustomSuffix && (
                      <div className="form-group" style={{ marginTop: 8 }}>
                        <label className="form-label">包名后缀</label>
                        <div className="suffix-input">
                          <span className="suffix-prefix">{packagePrefix}.</span>
                          <input
                            className="form-input"
                            value={customSuffix}
                            onChange={e => setCustomSuffix(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                            placeholder="例如: scanner"
                          />
                        </div>
                        <div className="form-hint">完整包名: {packagePrefix}.{customSuffix || "xxx"}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="action-section">
              <button className="btn-action" onClick={handleProcess} disabled={!apkPath || processing}>
                {processing ? "⏳ 处理中..." : "🎭 开始伪装"}
              </button>
              {processing && <div className="progress-track"><div className="progress-bar" style={{ width: `${progress}%` }}></div></div>}
            </div>

            <div className="log-panel card">
              <div className="log-header">
                <span className="card-title">操作日志</span>
                <div className="log-modes">
                  <button
                    className={`log-mode-btn ${logMode === "simple" ? "active" : ""}`}
                    onClick={() => setLogMode("simple")}
                  >
                    简洁
                  </button>
                  <button
                    className={`log-mode-btn ${logMode === "verbose" ? "active" : ""}`}
                    onClick={() => setLogMode("verbose")}
                  >
                    详细
                  </button>
                </div>
              </div>
              <div className="log-area">
                {displayLogs.length === 0 ? (
                  <div className="log-line info">等待操作...</div>
                ) : (
                  displayLogs.map(l => (
                    <div key={l.id} className={`log-line ${l.level}`}>{l.text}</div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Apps Panel */}
          <div className={`panel ${activeView === "apps" ? "active" : ""}`}>
            <div className="apps-toolbar">
              <input className="search-box" placeholder="搜索应用名或包名..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
              <label className={`filter-toggle ${showSystemApps ? "active" : ""}`}>
                <input type="checkbox" checked={showSystemApps} onChange={e => setShowSystemApps(e.target.checked)} />
                <span>显示系统应用</span>
              </label>
              <button className="btn-secondary" onClick={loadApps} disabled={loadingApps || !selectedDevice}>
                {loadingApps ? "加载中..." : "🔄 刷新列表"}
              </button>
            </div>

            {installedApps.length > 0 && (
              <div className="apps-stats">
                共 {installedApps.length} 个应用 | 用户应用: {userAppsCount} | 系统应用: {systemAppsCount} | 当前显示: {filteredApps.length}
              </div>
            )}

            <div className="apps-grid">
              {filteredApps.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon">📱</div>
                  <p>{installedApps.length === 0 ? (selectedDevice ? "点击刷新加载应用列表" : "请先连接设备") : "无匹配结果"}</p>
                  {installedApps.length === 0 && selectedDevice && <button className="btn-secondary" onClick={loadApps}>加载应用</button>}
                </div>
              ) : filteredApps.map((a, i) => (
                <div key={i} className={`app-card ${a.is_system ? "system" : ""}`}>
                  <div className={`app-icon ${a.is_system ? "system" : ""}`}>{a.is_system ? "⚙️" : "📦"}</div>
                  <div className="app-meta">
                    <div className="app-name">
                      {a.app_name}
                      {a.is_system && <span className="app-badge">系统</span>}
                    </div>
                    <div className="app-pkg">{a.package_name}</div>
                  </div>
                  <div className="app-btns">
                    <button className="btn-sm danger" onClick={() => startUninstall(a)}>
                      卸载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Settings Panel */}
          <div className={`panel ${activeView === "settings" ? "active" : ""}`}>
            <div className="settings-section">
              <h3>工具路径配置</h3>
              <div className="settings-grid">
                {[
                  { label: "Java 路径", value: javaPath, set: setJavaPath },
                  { label: "Apktool 路径", value: apktoolPath, set: setApktoolPath },
                  { label: "Zipalign 路径", value: zipalignPath, set: setZipalignPath },
                  { label: "Apksigner 路径", value: apksignerPath, set: setApksignerPath },
                  { label: "Keystore 路径", value: keystorePath, set: setKeystorePath },
                ].map(f => (
                  <div className="form-group" key={f.label}>
                    <label className="form-label">{f.label}</label>
                    <input className="form-input" value={f.value} onChange={e => f.set(e.target.value)} />
                  </div>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <h3>工具获取指南</h3>
              <div className="tool-guide">
                <div className="tool-item">
                  <strong>Java JDK</strong>
                  <p>macOS: <code>brew install openjdk</code></p>
                  <p>Windows: 下载 <a href="https://adoptium.net/" target="_blank" rel="noreferrer">Adoptium JDK</a></p>
                </div>
                <div className="tool-item">
                  <strong>Apktool</strong>
                  <p>下载: <a href="https://ibotpeaches.github.io/Apktool/" target="_blank" rel="noreferrer">apktool.jar</a></p>
                  <p>放置到项目 tools 目录</p>
                </div>
                <div className="tool-item">
                  <strong>Build Tools (zipalign, apksigner)</strong>
                  <p>来自 Android SDK Build Tools</p>
                  <p>macOS: <code>brew install android-sdk</code> 或从 Android Studio 安装</p>
                  <p>路径: ~/Library/Android/sdk/build-tools/VERSION/</p>
                </div>
                <div className="tool-item">
                  <strong>Keystore 签名文件</strong>
                  <p>生成: <code>keytool -genkeypair -v -keystore my-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias my-alias</code></p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* 删除确认弹窗 */}
      {deleteConfirm.app && (
        <div className="modal-overlay" onClick={cancelUninstall}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>⚠️ 确认卸载</h3>
            </div>
            <div className="modal-body">
              {deleteConfirm.app.is_system ? (
                // 系统应用三步确认
                deleteConfirm.step === 1 ? (
                  <>
                    <p className="warning-text">⚠️ 警告：这是一个系统应用！</p>
                    <p>卸载系统应用可能导致设备不稳定或功能异常。</p>
                    <p><strong>{deleteConfirm.app.app_name}</strong></p>
                    <p className="pkg-name">{deleteConfirm.app.package_name}</p>
                    <p>确定要继续吗？</p>
                  </>
                ) : deleteConfirm.step === 2 ? (
                  <>
                    <p className="warning-text">🔴 最终确认</p>
                    <p>请手动输入要卸载的包名以确认：</p>
                    <input
                      className="form-input confirm-input"
                      value={deleteConfirm.inputValue}
                      onChange={e => setDeleteConfirm({ ...deleteConfirm, inputValue: e.target.value })}
                      placeholder={deleteConfirm.app.package_name}
                    />
                    <p className="hint">请输入: {deleteConfirm.app.package_name}</p>
                  </>
                ) : (
                  <>
                    <p className="warning-text">🔴 最后一步</p>
                    <p>点击确认将立即卸载以下系统应用：</p>
                    <p><strong>{deleteConfirm.app.package_name}</strong></p>
                    <p className="warning-text">此操作不可撤销！</p>
                  </>
                )
              ) : (
                // 用户应用两步确认
                deleteConfirm.step === 1 ? (
                  <>
                    <p>确定要卸载以下应用吗？</p>
                    <p><strong>{deleteConfirm.app.app_name}</strong></p>
                    <p className="pkg-name">{deleteConfirm.app.package_name}</p>
                  </>
                ) : (
                  <>
                    <p>⚠️ 再次确认</p>
                    <p>点击确认将立即卸载：</p>
                    <p><strong>{deleteConfirm.app.app_name}</strong></p>
                  </>
                )
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={cancelUninstall}>取消</button>
              <button
                className="btn-danger"
                onClick={confirmUninstall}
                disabled={deleteConfirm.step === 2 && deleteConfirm.app.is_system && deleteConfirm.inputValue !== deleteConfirm.app.package_name}
              >
                {deleteConfirm.step === 3 || (deleteConfirm.step === 2 && !deleteConfirm.app.is_system) ? "确认卸载" : "继续"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
