# 全柔性 SSVEP 脑机头带思维导图补全设计

日期：2026-07-10

## 1. 目标

在不修改原始附件的前提下，补全 `可穿戴科研原型机规划.emmx` 中以下分支：

`头带 -> 原型机 -> 脑机头带，通过脑电控制外设（徐陆天泽、杨尚霖）`

补全结果应能同时表达：

- SSVEP 脑机接口的完整数据链路；
- 全柔性头带的可实现工程边界；
- 由近期论文支持、但仍需原型验证的设计选择；
- 与示例分支相同的简洁导图粒度。

## 2. 已确认范围

### 范围内

1. 原位扩写目标分支现有的 6 个节点：硬件选型、原理图设计、layout 设计、电路结构设计、嵌入式、APP。
2. 在现有共享分支 `头带 -> 特性` 下新增 3 个与本项目直接相关的节点：全柔性工程边界、SSVEP 电极与控制链、原型验证指标。
3. 生成一份简短的研究依据 Markdown，记录文献、附件页码、证据边界和未验证事项；引用不堆进导图节点。
4. 输出新的 `.emmx` 副本，保留原附件不变。

### 范围外

- 不修改 `（尝试）电刺激干预+eeg检测闭环头带` 分支。
- 不把 NIRS/rSO2 作为首版 EEG 主信号链；ADPD4100 和三波长光学通道只作为未来可选扩展。
- 不宣称 AFE、MCU、射频芯片和电池本体已经实现材料级全柔性。
- 不把耳内 SpiralE、热展开、外部 10 V 驱动或 NeuroScan 采集链直接移植到头带。
- 不填写未经样机测试确认的准确率、续航、弯折寿命或阻抗达标率。

## 3. 核心设计判断

### 3.1 任务范式

第三张图中的 8/16/20 Hz 峰值表达的是视觉稳态诱发电位（SSVEP）频率响应。首版系统采用以下主链：

`视觉频率/相位编码 -> 枕区或耳后 EEG -> 低噪声 AFE -> MCU/BLE -> FBCCA/TRCA -> 指令置信度与确认 -> 外设控制`

视觉刺激频率必须按手机或显示器的实际刷新率设计和标定，不能只按理想频率填写。

### 3.2 “全柔性”的工程定义

当前证据不支持把电极、互连、封装、AFE、MCU、天线和电池全部描述为柔软器件。首版采用可制造的岛桥架构：

- 贴肤电极、长互连和包封层柔性化；
- 刚性 IC 集中在低轮廓微型器件岛；
- 控制与电池仓布置在侧后方或后脑，并设计为可拆卸；
- 器件岛边缘使用蛇形走线和应变释放，避免刚柔交界疲劳。

因此，导图使用“全柔性贴肤层/传感带 + 微型刚岛/可拆卸电子仓”的准确表述。

### 3.3 电极布局

SSVEP 首版优先验证 `O1/Oz/O2/POz` 枕区信号，耳后或乳突布置参考电极，另设 GND/BIAS。纯前额布局虽然容易佩戴，但眼电、面肌伪迹明显且 SSVEP 信噪比较弱，只作为对照方案，不作为默认方案。

## 4. 最终导图文案

以下文字写入 NodeID `140` 的现有 6 个子节点，保留原节点与父子关系。

### 4.1 硬件选型（NodeID 722）

`硬件选型：O1/Oz/O2/POz 柔性/织物干电极，ADS1299-4 24位 EEG AFE，nRF52840，6轴 IMU，BLE，锂电池及可拆卸电子仓`

### 4.2 原理图设计（NodeID 723）

`原理图设计：电极保护/人体限流/RC抗混叠/REF+BIAS/阻抗检测 -> ADS1299-4 -> SPI主控 -> BLE；低噪声电源、充电与本地缓存`

### 4.3 layout 设计（NodeID 724）

`layout设计：AFE靠近电极，模拟/数字/RF分区；差分与屏蔽走线、连续回流、蛇形应变释放，天线远离电极线和AFE`

### 4.4 电路结构设计（NodeID 725）

`电路结构设计：柔性电极与互连 + 分布式微型刚岛 + 软封装 + 可拆卸后脑控制/电池仓，采集板与无线板模块化`

### 4.5 嵌入式（NodeID 726）

`嵌入式：250-500 Hz同步采样，0.5-40 Hz带通/50 Hz陷波，阻抗/SQI/IMU伪迹检测；FBCCA免训练、TRCA个体校准，时间戳/丢包检测/OTA`

### 4.6 APP（NodeID 727）

`APP：按实际刷新率标定SSVEP刺激，实时波形/频谱/阻抗/SQI与识别置信度；外设映射、二次确认、心跳/急停、数据记录与导出`

## 5. 新增特性节点

以下 3 个节点新增到现有 `头带 -> 特性`（NodeID `112`）下，不新建重复的“特性”根节点。

### 5.1 全柔性工程边界

`全柔性工程边界：贴肤电极/互连/包封柔性，AFE/MCU/射频/电池采用低轮廓刚岛或可拆卸电子仓`

### 5.2 SSVEP 电极与控制链

`SSVEP电极与控制链：O1/Oz/O2/POz + 耳后REF/GND；刷新率约束的频率/相位编码 -> FBCCA/TRCA -> 指令确认`

### 5.3 原型验证指标

`原型验证：皮肤阻抗/输入噪声/CMRR、弯折与汗液漂移、运动伪迹/舒适度、丢包/续航、科研级EEG对照、在线准确率/ITR/误触发`

## 6. 文献与附件的使用边界

### 6.1 直接依据

1. Wang et al. (2023), *Conformal in-ear bioelectronics for visual and auditory brain-computer interfaces*. https://doi.org/10.1038/s41467-023-39814-6
2. Kaveh et al. (2024), *Wireless ear EEG to monitor drowsiness*. https://doi.org/10.1038/s41467-024-48682-7
3. Kwon et al. (2023), *At-home wireless sleep monitoring patches for the clinical assessment of sleep quality and sleep apnea*. https://doi.org/10.1126/sciadv.adg9671
4. Lopez-Larraz et al. (2023), *A garment that measures brain activity: proof of concept of an EEG sensor layer fully implemented with smart textiles*. https://doi.org/10.3389/fnhum.2023.1135153
5. Paul et al. (2023), *A Versatile In-Ear Biosensing System and Body-Area Network for Unobtrusive Continuous Health Monitoring*. https://doi.org/10.1109/TBCAS.2023.3272649
6. Mascia et al. (2023), *Wearable System Based on Ultra-Thin Parylene C Tattoo Electrodes for EEG Recording*. https://doi.org/10.3390/s23020766
7. Hou et al. (2023), *Flexible Gel-Free Multi-Modal Wireless Sensors With Edge Deep Learning for Detecting and Alerting Freezing of Gait Symptom*. https://doi.org/10.1109/TBCAS.2023.3281596
8. Mai et al. (2023), *Real-Time On-Chip Machine-Learning-Based Wearable Behind-The-Ear Electroencephalogram Device for Emotion Recognition*. https://doi.org/10.1109/ACCESS.2023.3276244

### 6.2 辩证参照

- Nature Communications 论文证明柔性耳内电极可记录视觉和听觉脑电，但其采集仍依赖外部科研级放大器、外接参考/地和约 10 V 驱动，不能作为全柔性无线头带整机证据。
- 样机方案初稿是 NIRS/rSO2 链路，包含 ADPD4100、三波长 LED、PD 和刚性主板。可复用其分区、时间戳、BLE 和模块化思路，但 EEG 必须增加独立生物电 AFE、参考/偏置、保护、阻抗检测和低噪声电源。
- 织物、纹身和干电极提高舒适性，但接触阻抗、运动伪迹、汗液漂移和跨头发稳定性仍需样机验证。

## 7. 文件编辑方案

1. 将原附件复制到 `output/mindmap/可穿戴科研原型机规划_全柔性SSVEP脑机头带完善版_20260710.emmx`。
2. 使用本机 MindMaster 编辑副本，原位替换 NodeID `722-727` 的标题。
3. 在 NodeID `112` 下新增 3 个特性节点，继承现有分支风格。
4. 让 MindMaster 自动重排分支、重算文本边界和 ZIP CRC，不直接修改 `mmpage/page.bin`。
5. 将研究依据写入 `output/mindmap/全柔性SSVEP脑机头带_导图补全依据_20260710.md`。

## 8. 可视与格式要求

- 保留现有绿色分支、字体和整体主题，不改变其他团队内容。
- 6 个扩写节点沿用示例中“类别：具体方案”的写法。
- 文本允许自动换行，但不得与相邻分支重叠。
- 新增特性节点置于现有特性分支末尾，避免挤压原有 NIRS、织物电极和波束成形节点。
- 导图节点不放 DOI 和长篇解释，详细依据留在 Markdown。

## 9. 验收标准

1. 原始 `.emmx` 的 SHA-256 保持 `68608C8B1A436D3280F2D6CF604EE4546139BD8C5B2959028E686B6745253CD5`。
2. 输出 `.emmx` 可通过 ZIP/CRC 与 XML 结构检查。
3. MindMaster 关闭后二次打开输出文件，无损坏、自动修复或缺失字体提示。
4. NodeID `140` 仍只有原 6 个实现节点；标题已全部替换，父子关系不变。
5. NodeID `112` 新增且仅新增上述 3 个特性节点。
6. NodeID `863` 的电刺激分支及工作区现有前端文件完全不变。
7. 视觉检查中无文字遮挡、截断或分支交叉，目标分支可一屏阅读。
8. Markdown 依据中的论文题名、年份和 DOI 均可追溯；明确区分论文实证、工程推断和待验证目标。
