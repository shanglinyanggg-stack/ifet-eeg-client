# Alpha 与双通道眨眼算法接入说明

当前实现由睡眠分期 v1.2.0 与眨眼算法 v1.0.9 组合，输出协议为
`headset-demo-flags/v6`。完整门控、参数和验收要求见：

- `BLINK_ALGORITHM_v1.0.9.md`
- `BLINK_ACCEPTANCE_v1.0.9.md`
- `config/blink_algorithm_config_v1.0.9.json`

## 固定约束

- 输入固定为 100 Hz、`eeg[4][N]`、可选 `imu[3][N]` 和 `valid[N]`。
- EEG1、EEG2 用于 Alpha 与眨眼判定；EEG3、EEG4 只显示和记录。
- 无效样本使用上一有效原始 EEG 补齐，再进入因果滤波器。
- 眨眼必须通过 EEG1+EEG2 同峰硬门控，不提供单通道降级路径。
- 三次眨眼降低音量 10%，五次眨眼提高音量 10%；五次具有优先级。
- 该功能仅用于交互演示，不属于医疗诊断。

## 校准流程

Alpha 睁眼基线在数据流开始后的 20 秒建立。眨眼基线不会自动启动，App 必须提供
独立入口调用 `begin_blink_calibration()`，并连续发送 10 秒数据。测量期间提示用户保持
头部和下颌静止，每 0.5-1 秒自然眨眼一次。

成功条件：至少 5 个 EEG1+EEG2 双通道峰，且双通道峰占全部候选峰至少 45%。失败时
App 必须显示原因并允许重新测量。更换用户、重新佩戴、明显移动电极或长时间断连后需
重新测量。

## 事件

| 事件 | App 动作 |
| --- | --- |
| `PLAY_MUSIC_ALPHA` | 开始播放音乐 |
| `LOWER_VOLUME_ALPHA_DECAY` | 按 Alpha 推荐值渐弱 |
| `BLINK_3` / `VOLUME_DOWN_3_BLINKS` | 当前音量降低 10% |
| `BLINK_5` / `VOLUME_UP_5_BLINKS` | 当前音量提高 10% |
| `BLINK_CALIBRATION_COMPLETE` | 将校准状态显示为就绪 |
| `BLINK_CALIBRATION_FAILED` | 显示失败原因并禁止眨眼控制生效 |

`BLINK`、`ALPHA_PRESENT` 和 `BLINK_INTERACTION_ENABLED` 是状态/诊断事件。

## 本地 HTTP API

- `POST /demo/reset`：重置会话状态。
- `POST /demo/blink`：启用或停用眨眼交互。
- `POST /demo/blink-calibration`：`action=start|restart`，开始 10 秒测量。
- `POST /demo/config`：同步 `alpha_volume_mode` 和 `session_active`。
- `POST /demo/step`：提交连续 EEG/IMU/valid 数据块。

诊断字段包括校准峰数、双通道候选比例、融合强度、峰宽、自适应更新次数和单通道拒绝
次数。JSON 约束见 `demo_signal_flags_contract.schema.json`。
