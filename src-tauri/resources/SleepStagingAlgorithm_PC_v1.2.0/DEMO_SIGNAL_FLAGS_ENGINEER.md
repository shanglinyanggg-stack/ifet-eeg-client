# 睡眠音乐引导与眨眼控制接入说明

当前交付由睡眠分期 v1.2.0、眨眼算法 v1.0.21 和输出协议
`headset-demo-flags/v9` 组成。Python sidecar 是正式判定路径；前端 TypeScript
检测器仅用于服务不可用时的保守降级，App 必须明确显示当前路径。

配套文件：

- `BLINK_ALGORITHM_v1.0.21.md`：眨眼算法、基线恢复和验证边界；
- `BLINK_ACCEPTANCE_v1.0.21.md`：App 侧验收用例；
- `config/blink_algorithm_config_v1.0.21.json`：可机读眨眼参数；
- `config/online_pipeline_config.json`：在线睡眠分期和音乐控制参数；
- `demo_signal_flags_contract.schema.json`：完整 JSON 输出约束；
- `validation/adaptive_blink_v121_report.json` 与
  `validation/latest_headset_replay_v121_report.json`：逐类回放结果。

## 输入、时序与连接要求

1. 输入固定为 100 Hz、同一时间轴的 `eeg[4][N]`、`imu[3|6][N]` 和
   `valid[N]`。EEG、IMU、valid 的 N 必须相同。
2. BLE 层必须保留包序号和真实时间顺序；丢包样本标为 `valid=false`。不得复制上一
   样本并把它标为有效，否则滤波、Alpha 功率和眨眼节律都会被污染。
3. EEG1+EEG2 是 Alpha、睡眠分期和眨眼的主判通道；EEG3+EEG4 参与眨眼形态
   佐证，但信号质量差时不能脱离 EEG1+EEG2 独立触发命令。
4. App 必须显示当前连接的蓝牙设备名称/标识、数据到达状态、丢包率、正式算法或
   降级路径。更换设备、用户、佩戴位置或会话时必须使用新的 `session_id` 并重置状态。

## Alpha 音乐开启与音量阶梯

- 首先采集 20 秒清醒、睁眼、安静基线。4 秒窗每 0.25 秒更新 Alpha 占比。
- 开启阈值为睁眼基线中心、75% 分位数和绝对下限共同确定：
  `max(0.18, center + min(2*robust_scale, 0.12), q75 + 0.01)`。
- EEG1、EEG2 需同时支持；融合 Alpha 占比连续 1 秒超过开启阈值后发送
  `PLAY_MUSIC_ALPHA`。开启后至少保持 5 秒，随后 Alpha 连续 3 秒衰减至关闭门限
  才发送 `LOWER_VOLUME_ALPHA_DECAY`。
- 音量依据“当前 Alpha 相对个体睁眼基线与闭眼参考的归一化水平”计算，不是固定
  Alpha 频带占比。App 可选择 3 阶、10 阶、20 阶或平滑模式，并执行
  `telemetry.recommended_volume`。
- 睁眼基线只在未进入引导会话、未检测到闭眼 Alpha、信号质量合格且无明显伪迹时
  以 300 秒时间常数慢速更新。闭眼、Alpha 已出现或助眠会话进行中必须冻结；否则
  会把闭眼 Alpha 学进基线，导致音乐不能及时开启。
- UI 必须在 Alpha 实时占比条标出 `alpha_on_threshold`，并显示
  `open_eye_alpha_baseline` 相对 `alpha_initial_baseline` 的变化。
- App 应提供独立的睁眼、闭眼和眨眼测量按钮与进度条。睁眼重测只能重置 Alpha
  参考，必须保留已经验证的个人眨眼模板；闭眼测量必须等睁眼基线完成后才允许启动。

## 睡眠检测与停止音乐

- 睡眠模型每 5 秒输出一次；首次有效判断需要 30 秒数据。研究分期状态采用
  睡眠概率 EMA 0.25、开启阈值 0.75，但它不能直接停止音乐。
- 自动音乐干预使用独立保守控制器：睡眠概率 EMA 0.25，睡眠开启阈值 0.80，
  清醒返回阈值 0.65，返回清醒需连续 3 次更新。
- App 只可使用 `music_sleep_state`/`sleep_detected` 和 `intervention_action` 控制
  音乐，不得用单次模型 argmax 或 0.75 的研究分期候选替代。
- 状态不可恢复的冷启动期间，完整 Transformer 上下文需 240 秒重建；此时
  `autonomous_music_allowed=false`，必须保持之前的音乐状态而不是自动切换。
- 睡眠结果是六受试者研究性试验输出，不是医疗诊断；正式发布前仍需同步 PSG
  的前瞻验证。

## 3/5 次眨眼音量控制

1. 每次佩戴先测量：3 秒睁眼安静且不眨眼，再用 10 秒连续自然眨眼获取个人模板。
   建议间隔 0.5-1 秒，头部、下颌和电极保持不动。
2. 成功条件：至少 5 个成对有效峰、双通道一致率至少 65%、中位强度至少
   3 robust-z。失败必须禁止音量动作并提示重测。
3. 眨眼支路采用因果 2 阶 0.7-15 Hz Butterworth，结合固定配对同步响应、IMU、
   丢包边界、峰宽/难应期、模板相关性和 8 秒 3/5 次群组节律。
4. 模板相关系数下限为 0.65。无模板或恢复审计使用 2.5 robust-z 保守峰；已经有
   至少 3 个保守峰时，才允许用 1.8 robust-z 搜索弱的第 4/5 峰，而且扩展到
   5 次必须至少 80% 峰得到个人模板支持。低阈值不能自行创建命令。
5. EEG3+EEG4 噪声超过校准尺度 1.75 倍且超过 EEG1+EEG2 相对尺度 1.5 倍时，
   自动切换为 EEG1+EEG2 主导。辅助配对只能补充同一时刻的主配对响应。
6. 连续异常会隔离对应配对。算法用最近 8 秒安静背景和最近模板确认峰快速恢复；
   普通漂移连续 3 次健康检查、burst 隔离连续 5 次检查通过后自动重新启用。恢复
   期间 App 不得执行音量 flag，但应显示进度和暂停配对。
7. `BLINK_3`/`VOLUME_DOWN_3_BLINKS` 降低一个 App 配置步长；
   `BLINK_5`/`VOLUME_UP_5_BLINKS` 提高一个步长，5 次在结束等待窗内优先。

## App 状态机与事件

App 只有在 `blink_control_ready=true`、`blink_baseline_stale=false`、当前配对可用且
输入有效时执行眨眼动作。推荐展示：校准状态、模板相关性、群组候选数、暂停配对、
自动恢复进度、Alpha 基线变化、睡眠概率和自动干预许可。

| 事件 | App 动作 |
| --- | --- |
| `PLAY_MUSIC_ALPHA` | 开始播放所选助眠音乐 |
| `LOWER_VOLUME_ALPHA_DECAY` | 按 Alpha 推荐值渐弱 |
| `BLINK_3` / `VOLUME_DOWN_3_BLINKS` | 音量降低一个步长 |
| `BLINK_5` / `VOLUME_UP_5_BLINKS` | 音量提高一个步长 |
| `BLINK_CALIBRATION_COMPLETE` | 显示模板和基线已就绪 |
| `BLINK_CALIBRATION_FAILED` | 显示原因、禁止眨眼动作并允许重测 |
| `BLINK_PAIR_DISABLED` | 显示暂停配对和恢复进度 |
| `BLINK_PAIR_RECOVERED` / `BLINK_BASELINE_RECOVERED` | 自动恢复控制并通知用户 |

`BLINK`、`ALPHA_PRESENT` 和 `BLINK_INTERACTION_ENABLED` 仅是状态/诊断事件，
不能重复当作音量命令。

## 本地 HTTP API 与状态持久化

- `POST /demo/reset`：更换会话或设备时重置；
- `POST /demo/blink`：启用/停用眨眼交互；
- `POST /demo/blink-calibration`：`action=start|restart`；
- `POST /demo/alpha-calibration`：`kind=open-eye|closed-eye`。`open-eye` 重建 Alpha
  基线且保留眨眼模板，`closed-eye` 需要睁眼基线先就绪；
- `POST /demo/config`：同步 Alpha 音量模式和会话状态；
- `POST /demo/step`：提交连续 EEG/IMU/valid 数据块。

App 进入后台或普通短断连时应保存并恢复：因果滤波器状态、滚动窗、Alpha/眨眼
基线、个人模板、睡眠模型六相位上下文、EMA 和音乐控制状态。不能把普通后台切换
当作新会话冷启动。

## 当前验证边界

- 历史单佩戴者标注回放：126/136（92.65%）；无动作 11/12、3 次 47/52、
  5 次 68/72。
- 最新三次真机记录在恢复会话末保存模板的确定性复放中：保守路径 15/23，模板
  补峰后 19/23；无动作 2/2、3 次 6/7、5 次 11/14。
- 以上均为开发验证。App 工程师应在不同佩戴者、松紧度、快速/慢速眨眼、头动、
  低质量与丢包场景开展前瞻测试，报告 0/3/5 混淆矩阵、每小时误触发数、恢复时间、
  丢包率和 Wilson 95% 置信区间。
