# TD10 头带设备 LSL 数据接口协议

| 项目 | 内容 |
| --- | --- |
| 协议标识 | `TD10-LSL/1.0` |
| 适用上位机 | iFET EEG Client Sleep LSL `0.2.27` |
| LSL 协议版本 | `1.10` |
| 内置 liblsl 版本 | `1.13` |
| 文档日期 | 2026-08-07 |
| 数据字节序 | 由 LSL/liblsl 负责序列化，接收端无需处理字节序 |

## 1. 协议用途与边界

本协议规定 TD10 头带经 iFET 上位机发布到 Lab Streaming Layer（LSL）的数据接口，供 LabRecorder、Python、MATLAB、EEGLAB、MNE、PSG 同步程序及其他 LSL Inlet 使用。

数据链路如下：

```text
TD10 头带
  └─ BLE：FFF9 通知
       └─ iFET 上位机：解析、补齐与质量标记
            ├─ LSL EEG 流
            ├─ LSL AUX 流
            ├─ LSL Quality 流
            └─ LSL Markers 流
```

本文件描述的是“上位机到 LSL 接收端”的接口，不替代 TD10 固件的 BLE 帧协议。当前 BLE 数据通道为 FFF0 服务下的 FFF9 通知特征；采样率控制等 BLE 指令不属于本协议。

## 2. 快速接口摘要

默认流名称前缀为 `iFET-TD10`，默认来源 ID 为 `ifet-td10-headset`。开启 LSL 后，上位机发布四条流：

| 完整流名 | `type` | `source_id` | 通道数 | LSL 类型 | 标称采样率 |
| --- | --- | --- | ---: | --- | ---: |
| `iFET-TD10_EEG` | `EEG` | `ifet-td10-headset:eeg` | 4 | `int32` | 125/250/500/1000 Hz |
| `iFET-TD10_AUX` | `AUX` | `ifet-td10-headset:aux` | 9 | `int32` | 同 EEG |
| `iFET-TD10_Quality` | `Quality` | `ifet-td10-headset:quality` | 3 | `int32` | 同 EEG |
| `iFET-TD10_Markers` | `Markers` | `ifet-td10-headset:markers` | 1 | `string` | 不规则事件流（0 Hz） |

接收端应优先按唯一的 `source_id` 查找流，不应只依赖可由用户修改的显示名称。

同一局域网同时使用多台头带时，每台上位机必须设置不同的来源 ID，例如：

```text
ifet-td10-subject-001
ifet-td10-subject-002
```

对应 EEG 来源 ID 分别为 `ifet-td10-subject-001:eeg` 和 `ifet-td10-subject-002:eeg`。

## 3. EEG 流

### 3.1 StreamInfo

| 字段 | 值 |
| --- | --- |
| 名称 | `<流名称前缀>_EEG` |
| 类型 | `EEG` |
| 来源 ID | `<来源ID>:eeg` |
| 通道数 | 4 |
| 通道格式 | `int32` |
| 标称采样率 | 125、250、500 或 1000 Hz |
| 数据语义 | 有符号 24 位二进制补码原始 ADC 计数 |

### 3.2 通道顺序

通道位置为固定协议字段，接收端不得重新排序：

| 索引（0 起） | 标签 | 类型 | 单位 |
| ---: | --- | --- | --- |
| 0 | `EEG1` | `EEG` | `ADC counts` |
| 1 | `EEG2` | `EEG` | `ADC counts` |
| 2 | `EEG3` | `EEG` | `ADC counts` |
| 3 | `EEG4` | `EEG` | `ADC counts` |

### 3.3 数值转换

设备帧中的 EEG 值先保留低 24 位，再按 24 位二进制补码转成 `int32`：

```text
u24 = raw & 0xFFFFFF
if u24 >= 0x800000:
    value = u24 - 0x1000000
else:
    value = u24
```

有效范围为 `-8388608` 至 `8388607`。边界示例：

| 原始 24 位值 | LSL 输出 |
| --- | ---: |
| `0x000000` | 0 |
| `0x7FFFFF` | 8388607 |
| `0x800000` | -8388608 |
| `0xFFFFFF` | -1 |

本流是 BLE 解码器输出的 ADC 计数，不经过界面中的带通、陷波、卡尔曼、IQR、眨眼或睡眠算法滤波，也不直接输出微伏。为恢复目标采样网格，TD10 解码器可能在线性插值后产生中间行；因真正缺失通知而插入的行标为 `Valid=0`。兼容旧版单样本传输格式时，正常通知间隔内的时钟恢复插值可能标为 `Valid=1`。因此“未经过算法滤波”不等于“每行都来自一次独立物理 ADC 转换”，严格原始性判断必须结合固件格式和 `_Quality` 流。

若要转换为电压，必须由硬件团队确认该固件/硬件版本的参考电压、PGA 增益和模拟前端比例后再换算；接收端不能根据本协议自行猜测比例。

## 4. AUX 流

### 4.1 StreamInfo

| 字段 | 值 |
| --- | --- |
| 名称 | `<流名称前缀>_AUX` |
| 类型 | `AUX` |
| 来源 ID | `<来源ID>:aux` |
| 通道数 | 9 |
| 通道格式 | `int32` |
| 标称采样率 | 与 EEG 流相同 |
| 数据语义 | 原始 PPG 与加速度设备计数 |

### 4.2 通道顺序

| 索引（0 起） | 标签 | 类型 | 单位 |
| ---: | --- | --- | --- |
| 0 | `IR1` | `PPG` | `ADC counts` |
| 1 | `Red1` | `PPG` | `ADC counts` |
| 2 | `Green1` | `PPG` | `ADC counts` |
| 3 | `IR2` | `PPG` | `ADC counts` |
| 4 | `Red2` | `PPG` | `ADC counts` |
| 5 | `Green2` | `PPG` | `ADC counts` |
| 6 | `AccX` | `Accelerometer` | `device counts` |
| 7 | `AccY` | `Accelerometer` | `device counts` |
| 8 | `AccZ` | `Accelerometer` | `device counts` |

注意：四条 LSL 数据流使用统一的标称输出采样率。这表示 LSL 行与 EEG 样本一一对齐，不等价于证明 PPG、EEG 和加速度传感器在设备内部具有完全相同的原生采样时钟。

## 5. Quality 流

### 5.1 StreamInfo

| 字段 | 值 |
| --- | --- |
| 名称 | `<流名称前缀>_Quality` |
| 类型 | `Quality` |
| 来源 ID | `<来源ID>:quality` |
| 通道数 | 3 |
| 通道格式 | `int32` |
| 标称采样率 | 与 EEG 流相同 |
| 数据语义 | 与每行 EEG/AUX 对应的数据质量和设备字段 |

### 5.2 通道顺序和缺失值

| 索引（0 起） | 标签 | 单位 | 含义 |
| ---: | --- | --- | --- |
| 0 | `Valid` | `binary` | `1`：解码器接受为有效的行；`0`：因检测到缺失通知而插值补齐的行 |
| 1 | `DeviceSeq` | `counter` | 设备 8 位序列值；字段不存在时为 `-1` |
| 2 | `DeviceFlag` | `code` | EEG 数据帧携带的设备 Flag；字段不存在时为 `-1` |

处理要求：

- 接收端必须保留 `Valid=0` 的行，不能在入库时直接删除，否则会破坏时间轴和跨流行号对齐。
- 算法计算可屏蔽 `Valid=0` 的 EEG/PPG 值，或按具体任务进行插值并另存插值掩码。
- 兼容旧版单样本格式时，正常通知间隔内为恢复采样网格而生成的插值行可能仍为 `Valid=1`；若研究必须区分每次物理采样，需要固件提供逐样本计数器/硬件时间戳，不能只依赖此字段。
- `DeviceSeq` 是 8 位回绕计数。连续差值可按 `(curr - prev) mod 256` 计算；`delta=0` 表示重复计数，不应直接当作丢包。
- `_Quality` 是数据语义质量流；上位机界面中的“LSL 丢弃批次”是电脑端 LSL 队列指标，二者不是同一种丢失。

## 6. Markers 流

### 6.1 StreamInfo

| 字段 | 值 |
| --- | --- |
| 名称 | `<流名称前缀>_Markers` |
| 类型 | `Markers` |
| 来源 ID | `<来源ID>:markers` |
| 通道数 | 1 |
| 通道标签 | `Event` |
| 通道格式 | `string` |
| 单位 | `JSON string` |
| 标称采样率 | 0 Hz，不规则事件流 |

每个 LSL 样本只含一个 UTF-8 JSON 字符串。字段定义如下：

| JSON 字段 | 类型 | 必需 | 含义 |
| --- | --- | --- | --- |
| `label` | string | 是 | 标记名称，例如“PSG对齐连续眨眼开始” |
| `note` | string | 是 | 标记备注；没有备注时为空字符串 |
| `participantId` | string | 是 | 参与者/受试者编号；未设置时可为空字符串 |
| `sampleCount` | uint64 | 是 | 上位机发送标记时的累计 EEG 样本数 |
| `deviceFlag` | integer 或 null | 是 | 发送标记时最近的设备 Flag；未知时为 `null` |
| `algorithmAction` | string | 是 | 当时持续显示的算法动作；没有时为空字符串 |
| `wallClockUtc` | string | 是 | RFC 3339 格式 UTC 墙钟时间，仅供审计和人类查看 |

示例：

```json
{
  "label": "PSG对齐连续眨眼开始",
  "note": "持续时间=10s; 接下来10秒持续、均匀连续眨眼",
  "participantId": "S001",
  "sampleCount": 184250,
  "deviceFlag": 14,
  "algorithmAction": "等待连续眨眼结束",
  "wallClockUtc": "2026-08-07T03:15:42.126Z"
}
```

连续眨眼对齐事件会分别发布“开始”和“结束”标记。接收端应按 `label` 区分事件，并使用 LSL 样本时间戳作为跨 LSL 流对齐的主时间；`wallClockUtc` 不应替代 LSL 时间戳进行亚秒级同步。

## 7. 行对齐和采样批次

同一个上位机解析事件会产生一行 EEG、一行 AUX 和一行 Quality：

```text
EEG[n] ↔ AUX[n] ↔ Quality[n]
```

其行号和批内顺序一致。但三个数值 Outlet 是独立流，上位机依次调用 EEG、AUX、Quality 的批量发送，因此接收端不应要求三条流的浮点 LSL 时间戳逐位相等。

推荐关联顺序：

1. 分别使用每条流自己的 LSL 时间戳和时钟校正信息。
2. 以同一连续段内的样本序号/采样率建立规则时间网格。
3. 使用 `_Quality` 的 `Valid`、`DeviceSeq` 和 `DeviceFlag` 检查缺失与边界。
4. 与 PSG 或非 LSL 设备联合时，再使用连续眨眼等共同生理事件进行精细对齐。

“一包多数据”只影响 BLE/上位机内部的批量传输效率；对 LSL 接收端而言，每一行仍表示一个采样点。

## 8. 时间戳和同步约定

### 8.1 当前 0.2.27 的时间戳实现

- EEG、AUX、Quality 以 LSL chunk 发布，未传入设备硬件时间戳。
- liblsl 使用上位机的 `local_clock()` 给该批最后一个样本标时，批内前序样本按标称采样率反推。
- Marker 使用事件发布时的 LSL `local_clock()` 时间戳。
- LSL 时间戳来自单调时钟，不是 Unix 时间或本地日历时间；Marker 中的 `wallClockUtc` 才是用于审计的墙钟时间。
- LSL 的时钟校正可估计 Outlet 电脑与 Inlet 电脑之间的时钟偏移，但不能恢复设备内部未发送的硬件采样时刻，也不能完全消除 BLE 到达抖动。

### 8.2 记录建议

- 多电脑/多设备正式实验优先使用 LabRecorder 保存 XDF。XDF 同时保存样本时间戳和时钟偏移信息，之后使用 pyxdf、xdf-Matlab、MNE 或 EEGLAB 的正规导入路径进行离线校正。
- 在线闭环若只订阅单流，优先保证低延迟；若必须在线对齐多个流，接收端需启用适当的 LSL clock-sync/dejitter 后处理，并验证其延迟影响。
- 与非 LSL PSG 对齐时，仅靠电脑 UTC 时间不够。应在两套系统中共同记录“连续眨眼 10 秒”或硬件触发信号，再通过标记或波形相关进行离线配准。

## 9. 采样率切换和流生命周期

支持的标称采样率为：

```text
125 Hz / 250 Hz / 500 Hz / 1000 Hz
```

当上位机活动采样率改变时，当前数值 Outlet 会被重建，新的 StreamInfo 携带新的 `nominal_srate`。已有 Inlet 可能经历流中断；接收程序应允许重新发现并重新连接相同 `source_id` 的新流。不要在一个文件的同一连续段内默认采样率永不变化。

若实验要求固定采样率，应在开始记录前设置采样率、确认设备 ACK/实际接收速率，并在记录过程中禁止切换。

## 10. LSL 元数据

每条流的 `desc` 中包含：

```xml
<desc>
  <manufacturer>iFET</manufacturer>
  <model>TD10</model>
  <transport>BLE FFF9 to desktop LSL outlet</transport>
  <data_description>...</data_description>
  <host_software>iFET EEG Client Sleep LSL 0.2.27</host_software>
  <channels>
    <channel>
      <label>...</label>
      <type>...</type>
      <unit>...</unit>
    </channel>
  </channels>
  <synchronization>
    <offset_mean>0</offset_mean>
    <can_drop_samples>true</can_drop_samples>
  </synchronization>
</desc>
```

接收端应解析 `channels/channel` 元数据做通道校验，但仍应以本协议版本固定的顺序作为兼容性合同。

## 11. 缓冲、背压和丢弃约定

- 数值 Outlet 的 liblsl 缓冲上限配置为 60 秒。
- Marker Outlet 的 liblsl 缓冲上限配置为 360 秒。
- 上位机 BLE 线程到 LSL 工作线程之间使用最多 256 个数据批次的有界队列。
- 队列满时，上位机会丢弃待发布到 LSL 的整个批次并增加“LSL 丢弃批次”，不会阻塞 BLE 接收或本地 CSV 写盘。
- 因此正式采集应同时监控：设备/BLE 丢包、`Valid=0` 比例、LSL 丢弃批次和接收端/XDF 实收样本数。

## 12. 当前未发布的字段

`TD10-LSL/1.0` 当前不包含以下独立 LSL 数据：

- 电池电压、充电状态和估算电量；这些信息仅在上位机界面/可选电压记录中处理。
- 已滤波 EEG、Delta/Theta/Alpha/Beta 波形或频谱。
- 困意值、睡眠分期、Alpha 音乐控制状态和眨眼识别结果的连续数值流。
- 头带硬件绝对时间戳或每个物理 ADC 转换的独立时间戳。

如果以后增加上述内容，应新增独立流或升级协议版本，不能改变现有四条流的通道含义。

## 13. Python 接收示例

以下示例按唯一来源 ID 接收 EEG 和 Quality。生产程序应增加重连、超时、XDF 记录和数据完整性检查。

```python
from pylsl import StreamInlet, resolve_byprop

BASE_ID = "ifet-td10-headset"

def open_inlet(source_id: str) -> StreamInlet:
    streams = resolve_byprop("source_id", source_id, timeout=5.0)
    if not streams:
        raise RuntimeError(f"未发现 LSL 流: {source_id}")
    return StreamInlet(streams[0])

eeg_inlet = open_inlet(f"{BASE_ID}:eeg")
quality_inlet = open_inlet(f"{BASE_ID}:quality")

while True:
    eeg, eeg_ts = eeg_inlet.pull_sample(timeout=1.0)
    quality, quality_ts = quality_inlet.pull_sample(timeout=1.0)
    if eeg is None or quality is None:
        continue

    valid, device_seq, device_flag = map(int, quality)
    if valid == 1:
        eeg1, eeg2, eeg3, eeg4 = map(int, eeg)
        # 在此处理原始 EEG ADC counts
```

简单地逐次分别调用两个 `pull_sample()` 只适合连通性演示。正式多流同步程序应各自批量读取、保留各流时间戳，然后按校正后的时间轴匹配，不能假定两次 `pull_sample()` 返回的是同一行。

## 14. 接收端验收清单

集成工程师至少应完成以下测试：

1. 能发现四条流，流名、`type`、`source_id`、通道数和格式与本协议一致。
2. EEG 通道顺序固定为 EEG1、EEG2、EEG3、EEG4，且 24 位符号边界转换正确。
3. AUX 通道顺序和 PPG/ACC 单位元数据正确。
4. EEG、AUX、Quality 在同一连续采集段中的样本行数一致。
5. `Valid=0` 行保留，`DeviceSeq=-1` 和 `DeviceFlag=-1` 能被正确识别为缺失。
6. Marker JSON 可解析，所有必需字段均存在，`deviceFlag` 同时兼容整数和 `null`。
7. “发送 LSL 测试标记”能被接收；连续眨眼对齐操作能收到开始和结束两个事件。
8. 10 秒窗口实收样本数与目标采样率相符，并分别核对设备/BLE 丢包与 LSL 丢弃批次。
9. 切换 125/250/500/1000 Hz 后能够重新发现新流，并读取正确的 `nominal_srate`。
10. 整夜压力测试中 LSL 丢弃批次保持为 0，接收端和 XDF 文件没有非预期中断。

## 15. 版本兼容规则

以下变化属于破坏性变更，必须升级主版本，例如 `TD10-LSL/2.0`：

- 改变现有流的通道顺序、通道数量、数据类型或单位；
- 改变 EEG 原始计数的符号解释；
- 改变 `-1` 缺失值或 `Valid` 语义；
- 改变现有来源 ID 后缀；
- 删除或重命名 Marker 必需字段。

增加可选 XML 元数据、增加新的独立流或增加 Marker 可选字段可作为向后兼容的小版本更新，但接收端必须忽略未知可选字段。

## 16. 网络和安全注意事项

- LSL 通过局域网发现和传输。上位机与接收端应位于允许组播/广播发现的同一可信网络。
- 当前上位机没有为 LSL 数据增加应用层身份认证或加密，不应直接暴露到不可信公网。
- Windows 首次运行时应允许应用访问“专用网络”；公共网络规则应按实验室安全策略决定。
- 正式实验前应使用测试标记验证发现、传输、时钟校正和落盘的完整链路。

## 17. 参考资料

- LSL User's Guide：<https://labstreaminglayer.readthedocs.io/info/user_guide.html>
- liblsl Stream Outlets：<https://labstreaminglayer.readthedocs.io/projects/liblsl/ref/outlet.html>
- LSL Time Synchronization：<https://labstreaminglayer.readthedocs.io/info/time_synchronization.html>
