# iFET 上位机独立算法包接口 v1

## 目标

从 `0.2.28 Algorithm Lab` 起，BLE采集、记录、LSL、音频和界面保留在稳定上位机中；睡眠分期、Alpha控制、眨眼及频带占比由独立本机算法服务提供。只要 Host API 主版本保持兼容，算法升级不需要重新安装上位机。`0.2.29 Algorithm Lab` 增加 Host API 3，用于明确区分真实相对功率与状态增强视觉指数；主机同时兼容 API 2 稳定包和 API 3 实验包。

## 包格式

扩展名为 `.ifet-algorithm`，内容是 ZIP，根目录必须包含：

- `algorithm_manifest.json`
- `SHA256SUMS.txt`
- `SIGNATURE.ed25519`
- `runtime/ifet-sleep-service`（macOS）或 `runtime/ifet-sleep-service.exe`（Windows）
- `config/`、`models/` 及算法需要的其他只读资源

上位机导入时执行路径穿越、符号链接、2GB解压上限、逐文件SHA-256、未签名文件、Ed25519签名、平台运行程序及Host API兼容检查。相同 `package_id + version` 的内容不可覆盖；修改后必须提升版本。

受信任发布公钥ID为 `ifet-algorithm-update-2026-08`，公钥原始值为：

```text
1e3b21f1c0264aefc7f5ad18290ddb30db3355304c86ed0744aa54916d0a1b92
```

签名私钥只保存在构建机的：

```text
~/Library/Application Support/iFET Algorithm Signing/algorithm_update_ed25519_private.pem
```

私钥不得提交到Git、打入安装包或发送给普通测试人员。更换构建机时应通过受控加密介质迁移，或发布一次带新公钥的上位机。

## 接口兼容

清单必须声明：

```json
{
  "host_api": { "minimum": 2, "maximum": 3 },
  "calibration_schema_version": "...",
  "state_schema_version": "...",
  "capabilities": {
    "sleep_staging": true,
    "alpha_control": true,
    "blink_control": true,
    "band_share": true,
    "individual_alpha": true
  }
}
```

服务的 `GET /health` 必须返回与算法包清单一致的 `api_version`、`package_id`、`package_version`、`algorithm_profile`、`release_approved`、校准版本及能力列表。上位机拒绝连接到端口上与当前选择不一致的旧服务。

现有接口继续保留：`/step`、`/reset`、`/state/save`、`/state/load`、`/demo/reset`、`/demo/blink`、`/demo/blink-calibration`、`/demo/alpha-calibration`、`/demo/config`、`/demo/step`。

## 切换和回滚

- 算法包先完整验证并安装到独立版本目录，再原子更新 `current.json`。
- 活跃版本永不原地覆盖；稳定包始终作为 `last_known_good` 保留。
- 切换算法会停止旧sidecar。正在记录时界面禁止切换。
- 启动实验算法失败时自动选择上一稳定算法；用户也可在后台设置中手动回滚。
- 睡眠状态文件位于各算法版本自己的目录，不跨版本复用。
- `calibration_schema_version` 改变时必须重新完成睁眼、闭眼和眨眼基线，不能迁移旧基线。

## 2026-08-24实验算法边界

`com.ifet.sleep.experimental.band-alpha-20260824` 是受控实验通道。修正 2 仍使用8秒因果频带窗口、1秒步长、4秒Hann-Welch和EEG1/2质量加权，但增加固定1/f均衡、亚Delta漂移门控，并在空间参考退化时自动回退到逐通道时间去直流。Alpha继续使用7.5–13.5Hz个体峰、双通道一致性、独立启停阈值、滞回和5秒音量EMA；对外显示的阈值统一为0–1归一化占比，内部对数证据不再误显示成百分比。

该包的 `release_approved=false`。留出验证中非N3 Delta误主导和闭眼Alpha检出均未通过门槛，因此只能用于受控真机试验，不能作为正式算法结论。稳定版0.2.27随时可回滚。

修正 3 的主界面占比改为“状态增强视觉占比”：睁眼测量或未开始助眠时映射为 Beta 主导，闭眼测量或开始助眠后映射为 Alpha 主导；只有在实时分期给出有效 NREM、且校正后的 Delta 证据持续满足时，才映射为 Delta 主导的“深睡候选”。该图不是物理功率百分比，不得送入睡眠分期、Alpha音乐控制或科研统计。调试模式中的“校正后相对功率占比”才是独立的物理频带链路。Alpha闭眼/音乐状态机另用3秒因果分析窗，并要求双主通道一致的Alpha证据连续3秒高于开启阈值；任何低于阈值、丢包、运动伪迹或质量不合格窗口都会清零开启累计。

睁眼和闭眼基线均按 100 Hz 模型时间轴固定采集 2000 个时隙，即 20.0 秒。点击前已排队的数据通过时间戳拒绝；丢包时保留时隙并插值，20 秒结束时有效时隙不足 75% 则立即失败并提示重测，不再无限延长进度。对外 Alpha 阈值始终归一化到 0–1，内部可能为负的对数证据仅在调试项“Alpha证据”中显示。
