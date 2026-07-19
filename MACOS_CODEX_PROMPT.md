# macOS 端 Codex 执行提示词

你现在位于 `iFET EEG Client 0.1.1` 源码包的项目根目录。请直接执行并完成 macOS 原生构建与验证，不要只给方案，也不要在成功前停下。

## 目标

在当前 Mac 的原生架构上构建可运行的 Tauri v2 客户端，产出 `.app` 和 `.dmg`。客户端最低支持 macOS 12，包含 BLE 扫描/连接、EEG1-4 协议解析、脑电与纯波形界面、睡眠分期算法、音乐引导和设置持久化。

## 不可改变的协议与行为

- BLE EEG 数据真值是 39 字节 V8 帧。
- EEG1-4 均为无符号 24 位整数，不能改成有符号数，也不能恢复旧的 Blue 占位解析。
- 不要为通过 macOS 构建而删除睡眠算法、音乐、BLE 权限、F11/Control+Command+F 全屏或现有 UI 功能。
- 源码包故意不携带 Windows 的 `runtime/ifet-sleep-service.exe`；macOS 运行时必须由 `scripts/build-macos.sh` 在本机原生生成。
- 只修复实际发现的 macOS 兼容问题，不做无关重构。

## 执行步骤

1. 先读取 `MACOS_BUILD.md`、`scripts/build-macos.sh`、`src-tauri/tauri.macos.conf.json`、`src-tauri/Info.plist` 和本提示词。
2. 执行 `uname -m`、`sw_vers`，确认当前机器是 `arm64` 或 `x86_64`，并记录结果。
3. 如果包内存在 `SOURCE_SHA256SUMS.txt`，先运行 `shasum -a 256 -c SOURCE_SHA256SUMS.txt`；失败时停止构建并指出具体文件。
4. 检查 Xcode Command Line Tools、Node.js 22、npm、Rust/rustup 和 Python 3.12。仅安装缺失项；可使用 Homebrew。安装后重新输出各工具版本。
5. 运行以下验证：

   ```bash
   npm ci
   npm test -- --run
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

6. 运行原生打包：

   ```bash
   bash scripts/build-macos.sh
   ```

7. 找到当前架构对应的产物：

   ```text
   src-tauri/target/<target>/release/bundle/macos/*.app
   src-tauri/target/<target>/release/bundle/dmg/*.dmg
   ```

8. 对 `.app` 和 `.dmg` 计算 SHA-256；使用 `file`、`lipo -info`、`plutil -lint`、`codesign -dv --verbose=4`（未签名时如实记录）检查架构、Info.plist、最低系统版本、蓝牙权限文案和包结构。
9. 启动 `.app` 做真实冒烟测试：主窗口不能黑屏；界面必须完整；纯波形与脑电模式可切换；设置可保存；睡眠算法服务 `/health` 正常；音乐可播放。关闭应用后确认端口 `8765` 已释放且 `ifet-sleep-service` 没有残留进程。
10. 如果现场有 iFET 头带，验证首次蓝牙授权、扫描、连接、通知、EEG1-4 实时波形和断线重连。如果没有硬件，明确标记“BLE 实机未验证”，不能声称通过。
11. 若任何步骤失败，定位并修复当前项目中的 macOS 兼容问题，然后从相关测试开始重跑，直到成功或遇到确实需要用户提供证书/硬件的外部阻塞。

## 最终回复格式

用中文简洁报告：Mac 型号与架构、macOS/Node/Rust/Python 版本、测试数量、`.app`/`.dmg` 绝对路径与 SHA-256、签名状态、BLE 实机结果、算法与进程清理结果，以及仍需人工处理的签名/公证事项。不要只粘贴命令。
