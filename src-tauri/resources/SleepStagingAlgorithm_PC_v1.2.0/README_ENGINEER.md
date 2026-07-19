# 实时睡眠分期算法 PC SDK v1.2

> iFET 客户端安装包已内置对应平台的算法运行时，正常使用无需安装 Python。
> `setup_windows.ps1` 和 `setup_macos.sh` 仅用于 SDK 开发调试回退。

## 交付形式

请将整个 `SleepStagingAlgorithm_PC_v1.2.0` 文件夹交给 App 工程师，不要只提取其中
某个 ONNX。五个 `models/*.onnx` 是模型权重；`sdk/` 还实现了完全一致的因果滤波、
30 秒窗口、Transformer 历史、五种子融合、分期解码和声音干预门控。

推荐采用本地 sidecar 服务方式：App 和算法都运行在同一台电脑，App 通过
`127.0.0.1` 调用。这样 C#、C++、Qt、Electron、Java 或 Python App 都无需重写
算法细节。服务仅绑定本机，不对局域网开放。

## 安装与自检

Windows 独立运行时可直接启动：

```powershell
.\start_service.ps1
```

仅在需要从 Python 源码调试时执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup_windows.ps1
.\start_service.ps1
```

另开一个 PowerShell：

```powershell
.\.venv\Scripts\python.exe .\reference_client.py
```

macOS 独立运行时或 Python 调试回退：

```bash
bash ./start_service.sh
# 仅在没有内置运行时时执行：
bash ./setup_macos.sh
bash ./start_service.sh
```

另开一个终端：

```bash
./.venv/bin/python3 ./reference_client.py
```

输出 `"passed": true` 才表示工程环境、模型文件、预处理和概率结果一致。

## App 调用顺序

1. 新受试者或新夜晚开始时调用 `POST /reset`，传入新的 `session_id`。
2. 蓝牙层将数据按设备采样序号映射为 100 Hz。
3. 每累计 5 秒，调用一次 `POST /step`；不能重复提交旧数据。
4. 前五次是预热，第六次即 30 秒时首次输出有效分期，以后每 5 秒更新。
5. App 显示使用 `selected_stage` 和 `selected_sleep_probability`。
6. 声音控制只使用 `intervention_action`，不得直接使用
   `intervention_action_candidate`。当输出 `hold_previous_state` 时保持播放器原状态。

完整接口定义见 `openapi.yaml`，可直接交给支持 OpenAPI 的客户端代码生成器。

## 输入约定

`POST /step` JSON：

- `eeg_5s`: `[4,500]`，四路原始头戴 EEG，通道顺序固定 EEG1-4；24 位 ADC
  必须使用与训练预处理相同的有符号数值，不能在 App 中再次滤波、转微伏或标准化。
- `imu_5s`: `[3,500]` 或 `[6,500]`；前三路必须是 accX、accY、accZ。
- `valid_5s`: `[500]`；真实收到为 `true`，丢包补值必须为 `false`。
- 所有数组按时间从旧到新排列，采样率严格为 100 Hz。

如果连续缺口超过 2 秒或最近 30 秒覆盖率低于 60%，`decision_valid=false`，App
必须保持上一次状态并显示信号质量异常。

## 输出约定

类别编号不可更改：

| ID | 标签 | 含义 |
|---:|---|---|
| 0 | W | 清醒 |
| 1 | NREM | N1/N2/N3 合并 |
| 2 | REM | 快速眼动睡眠 |

主要字段：

- `selected_stage`: `W/NREM/REM`；
- `selected_sleep_probability`: `P(NREM)+P(REM)`；
- `decision_valid`: 当前结果是否通过数据质量门控；
- `sleep_detected`: 是否判为睡眠；
- `intervention_action`: `play_music/stop_music/hold_previous_state`；
- `autonomous_music_allowed`: 长历史是否完整，能否自动执行声音动作；
- `coverage`、`maximum_contiguous_gap_seconds`: 信号质量诊断。

## 生命周期要求

- 普通最小化、切换页面或 App 短暂进入后台不能调用 `/reset`；服务会保存因果状态。
- 更换受试者、更换夜晚、设备长时间中断时必须 `/reset`。
- App 异常退出后重启服务会尝试恢复 `runtime_state/sleep_state.npz`。
- App 必须保留人工暂停音乐、退出自动模式和信号质量报警功能。

## 模型边界

这是六名受试者数据上的研究先导模型，不替代 PSG 或医生判读，也不能作为医疗诊断。
真机发布前必须完成同步 PSG 整夜前瞻验证，并统计入睡检测延迟、W 误判为睡眠、
音乐误停/误开以及蓝牙丢包率。
