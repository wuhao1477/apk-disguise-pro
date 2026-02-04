# 🎭 APK Disguise Pro

> **专为工业级 Android 设备打造的一键化 APK 伪装与安装工具**

![Build Status](https://img.shields.io/github/actions/workflow/status/wuhao/apk-disguise-pro/release.yml?style=flat-square)
![Version](https://img.shields.io/github/v/release/wuhao/apk-disguise-pro?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)

**APK Disguise Pro** 是一款基于 Tauri 2.0 构建的现代化桌面应用，旨在解决特定工业级 Android 设备（如 Newland MT90）因系统白名单限制无法安装第三方 APK 的问题。

通过自动化的**反编译**、**包名修改**、**重签名**与**对齐**流程，本工具能一键将任意 APK "伪装"成系统受信任的包名（如 `cn.chinapost.*`），从而绕过安装拦截。

---

## 🛑 背景与痛点

在某些工业级手持终端（如 Newland MT90 / Android 8.1）上，系统固件内置了严格的安装拦截策略：

1.  **包名白名单**：非 `cn.chinapost.*` 或 `com.nlscan.*` 等特定前缀的 APK 会被直接拦截 (`INSTALL_FAILED_INVALID_APK`)。
2.  **SELinux 限制**：标准流式安装 (`adb install`) 常因权限问题失败。
3.  **签名校验**：修改包名后必须进行严格的 Zip 对齐和正确的 V1 签名。

**APK Disguise Pro 将这一复杂的 6 步手动流程封装为简单的"一键操作"。**

---

## ✨ 核心特性

- **🚀 极速一键处理**：拖入 APK -> 点击开始，全自动完成反编译、改名、回编译、对齐、签名、安装。
- **🔌 设备直连管理**：内置 ADB 客户端，实时显示连接设备，支持一键安装到手机。
- **📱 应用深度管理**：
    - 读取设备实际应用列表（区分用户/系统应用）
    - 提供应用搜索与**一键卸载**功能
    - 智能识别系统级应用并提供卸载保护
- **🔍 智能前缀扫描**：自动扫描设备上现存应用，推荐可用的受信任包名前缀。
- **🛠️ 工具链内置**：**无需配置环境**！发布版本已内置 Java 运行时环境（部分）、Apktool、Zipalign、Apksigner 和签名证书。
- **⚙️ 高级自定义**：支持自定义包名后缀，支持深色/浅色模式切换。
- **📦 自动化构建**：集成 GitHub Actions，自动构建多平台发布版本。

---

## 🛠️ 技术架构

本项目采用现代化技术栈构建，确保高性能与跨平台体验：

- **Frontend**: [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vitejs.dev/)
- **Backend**: [Tauri 2.0](https://tauri.app/) + [Rust](https://www.rust-lang.org/)
- **Core Tools**:
    - [Apktool](https://ibotpeaches.github.io/Apktool/) (反编译核心)
    - [Android Build Tools](https://developer.android.com/studio/command-line/build-tools) (zipalign, apksigner)
    - [ADB](https://developer.android.com/studio/command-line/adb) (设备通信)

---

## 📖 使用指南

### 对于普通用户

1.  前往 [Releases](https://github.com/wuhao/apk-disguise-pro/releases) 页面下载最新安装包：
    - macOS: `.dmg`
    - Windows: `.exe`
2.  安装并启动应用。
3.  通过 USB 连接 Android 设备（确保开启 USB 调试）。
4.  将目标 APK 文件拖入应用窗口。
5.  选择推荐的包名前缀（如 `cn.chinapost`）。
6.  点击 **"🎭 开始伪装"**。

### 对于开发者 (构建源码)

#### 环境要求
- Node.js (v20+)
- Rust (Stable)
- Java JDK 11+
- Android SDK (用于获取 build-tools)

#### 本地开发
```bash
# 1. 克隆项目
git clone https://github.com/wuhao/apk-disguise-pro.git
cd apk-disguise-pro

# 2. 安装依赖
npm install

# 3. 准备工具 (重要)
# 需手动下载 apktool.jar, zipalign, apksigner.jar 等放置到 src-tauri/resources/tools/
# 或参考 .github/workflows/release.yml 中的下载脚本

# 4. 启动开发环境
npm run tauri dev
```

#### 构建发布包
```bash
npm run tauri build
```
构建产物将位于 `src-tauri/target/release/bundle/`。

---

## 🔧 详细处理流程 (SOP)

本工具在后台严格遵循以下 SOP 执行：

1.  **Decompile**: `java -jar apktool.jar d source.apk -o temp_dir`
2.  **Modify Manifest**: 正则替换 `AndroidManifest.xml` 中的 `package` 属性，并注入必要的 `<uses-sdk>`。
3.  **Rebuild**: `java -jar apktool.jar b temp_dir -o rebuilt.apk`
4.  **Align**: `zipalign -f -v 4 rebuilt.apk aligned.apk` (4字节对齐)
5.  **Sign**: `apksigner sign --ks key.jks --v1-signing-enabled true ...` (兼容性签名)
6.  **Install**: `adb install -r -t -g final.apk`

---

## 🤝 贡献与反馈

欢迎提交 Issue 反馈 Bug 或建议新功能。Pull Requests 也非常欢迎！

## 📄 License

MIT © [wuhao](./LICENSE)
