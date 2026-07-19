# macOS 构建

客户端支持 macOS 12 及以上版本，并分别生成 Intel (`x86_64`) 与 Apple Silicon
(`arm64`) 安装包。BLE 使用系统 CoreBluetooth，首次扫描时 macOS 会请求蓝牙权限。

## 本机构建

在目标架构的 Mac 上安装 Xcode Command Line Tools、Node.js 22、Rust 和 Python 3.12，
然后运行：

```bash
npm ci
bash scripts/build-macos.sh
```

脚本会生成当前 Mac 架构对应的离线睡眠算法服务，再构建 `.app` 和 `.dmg`。PyInstaller
不能跨 CPU 架构构建，因此 Intel 与 Apple Silicon 需要分别在对应架构的 Mac 上运行。

输出目录：

```text
src-tauri/target/<target>/release/bundle/macos/
src-tauri/target/<target>/release/bundle/dmg/
```

## 签名与公证

未签名 DMG 适合内部测试。正式分发前需要 Apple Developer ID，并配置 Tauri 支持的
Apple 签名、公证环境变量。`APPLE_SIGNING_IDENTITY` 存在时，构建脚本会先签名内置
算法服务，随后由 Tauri 签名应用包。

仓库中的 `.github/workflows/build-macos.yml` 提供 Intel 与 Apple Silicon 双架构构建；
其中 ARM 作业使用 `macos-14`（GitHub 标准 Apple Silicon runner，公开仓库免费）。
