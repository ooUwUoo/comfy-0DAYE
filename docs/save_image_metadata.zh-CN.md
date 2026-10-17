# 元数据存图（Save Image Metadata）

[English](save_image_metadata.en.md) | [返回首页](../README.zh-CN.md)

保存主 PNG 及可选附带 JPEG/WEBP（最多两种格式，**无预览窗口**——需要预览请接官方 Preview Image）。写入 CivitAI 可识别的 A1111 元数据：提示词、采样参数、模型、LoRA 全部静态追溯自工作流（不触发执行）；模型哈希经 `.sha256` 边车缓存，只算一次。

**分类：** `0DAYE`

## 输入

| 输入 | 说明 |
|---|---|
| `images` | 待保存的图像（透传） |
| `filename_prefix` | 文件名前缀。支持官方 `%date%` / `%batch_num%` 占位符，另加 `%seed% %steps% %cfg% %sampler% %scheduler% %denoise% %model% %width% %height% %prompt%`。非法字符转 `-`，缺值补 `unknown` |
| `save_png` | 是否保存主 PNG（默认开） |
| `extra_format` | 附带格式：`不保存` / `JPEG` / `WEBP`（默认 JPEG），一次最多两种格式 |
| `mode` | `CivitAI 元数据`（默认）/ `原生 ComfyUI`——见下文 |
| `embed_parameters` | 把 A1111 参数串嵌入 PNG（`tEXt parameters`） |
| `embed_lora` | 是否包含 LoRA 信息（内联 `<lora:...>` 标签 + `Lora hashes:`） |
| `embed_workflow` | 是否把工作流嵌入 PNG（默认**关**） |
| `sanitize` | 保存前对密钥与路径用户名脱敏（默认开） |
| `quality` | JPEG/WEBP 画质：可输入下拉框，预设 `95` / `85`（默认）/ `78`，也可直接键入 1–100 任意数值 |
| `positive_node_id` / `negative_node_id` | `-1` = 自动。填节点 ID 则从该节点的文本控件抓提示词 |
| `sampler_node_id` | `-1` = 自动。填节点 ID 则把该节点当采样器解析——seed/steps/cfg/采样器/调度器与模型、LoRA 全部从它派生 |
| `seed_override` / `steps_override` | `-1` = 不覆盖。`seed` 为 ≥0 生效，`steps` 为 >0 生效 |
| `model_node_id` | 模型/LoRA 兜底节点 ID（-1=自动沿采样器 model 链）。填 rgthree Power Lora Loader / Checkpoint 加载器等节点 ID，从该节点起扫模型与 LoRA |
| `lora_override` | LoRA 列表，每行一项；支持「名称:权重」或 `<lora:名称:权重>`（省略权重记 1.0） |
| `positive_text` / `negative_text` | optional 纯连线输入，直接提供提示词文本 |

覆盖优先级：手动输入（上述各 override 与 `positive_text` / `negative_text`）> 节点 ID 兜底（`positive/negative/sampler_node_id/model_node_id`）> 自动追溯。

## 输出

`images`（透传）与 `parameters`（实际写入的 A1111 参数串）。**不返回 `ui` 数据 → 节点无预览图片窗口**。

## 元数据模式（`mode`）

| 模式 | 行为 |
|---|---|
| `CivitAI 元数据`（默认） | 写入 A1111 参数串，并按下方各开关嵌入 |
| `原生 ComfyUI` | 与官方 Save Image 一致——PNG 只嵌 `prompt` + workflow（强制）；参数串与 EXIF 全不写；各嵌入开关在原生模式下无效 |

## 提取机制

全静态——读 hidden prompt 图，不触发执行。

- **采样器识别**：inputs 同时有 `positive` / `negative` 之一 + `cfg` + `seed` / `noise_seed`（覆盖 KSampler / Advanced / SamplerCustom 及封包装）；从本节点向上 BFS，取最近一个。
- **参数**（`seed` / `steps` / `cfg` / `sampler_name` / `scheduler` / `denoise`）：同名输入是链接就跟进（Seed 节点、KSamplerSelect），另沿 `sampler` / `scheduler` / `sigmas` / `guider` 结构链接跟进（BasicScheduler 等），深度 ≤ 5，跟进目标兜底读 value 控件。
- **文本**：编码节点的 `text` 类控件直读；`conditioning` / `positive` / `negative` 结构链接可再深入一层（FluxGuidance 链）。`text` / `prompt` 载体链接只通往 Text Cache——优先读其运行时历史最新一条（同遍最终输出，含触发词前缀），历史为空再退回静态 `override_text`；LLM 节点不深挖（会读到错误控件而留空——请用 `positive_node_id` 填 ID 或 `positive_text` 接线）。ConditioningZeroOut 判空。
- **模型 / LoRA**：沿采样器 `model` 链接线性走链（近→远 = 应用倒序，反转后 = 应用顺序）；认 `ckpt_name` / `unet_name` / `lora_name` 控件。哈希 = sha256 前 10 位（AutoV2），写 `<模型文件>.sha256` 边车缓存只算一次。

## 脱敏（`sanitize`）

- JSON 键名子串匹配（api_key / token / secret / password / authorization / cookie 等；`max_tokens` 等白名单不误伤）
- 字符串值再扫令牌格式：sk- / sk-proj- / sk-ant-、hf_、gh*_ / github_pat_、AIza、AKIA、xox?-、r8_、JWT、Bearer 头、URL 查询串敏感参数（`?api_key=…` 等）
- 绝对路径用户名遮蔽（`C:\Users\xxx` / `/home/xxx` → `[USER]`，保留其余路径段）
- 作用对象：嵌入的 prompt / `extra_pnginfo`（结构不变，仍可拖回恢复）+ 参数串本身；替换为 `[REDACTED]`

## 写入格式（CivitAI 读取点）

- A1111 参数串：正面提示词 + ` <lora:名:权重>` 内联标签 → `Negative prompt:` 行 → `Steps:, Sampler:, CFG scale:, Seed:, Size: WxH, Model hash:, Model:, Denoising strength:, Lora hashes:` 字段行（缺字段跳过；denoise=1 不写；`embed_lora` 关则 LoRA 两块都省略）
- PNG：`tEXt parameters`（`embed_parameters` 开时）；`embed_workflow` 开或原生模式再按官方 SaveImage 约定嵌 `prompt` + `extra_pnginfo` 各键（可拖回 ComfyUI 恢复工作流）
- JPEG/WEBP：EXIF UserComment（0x9286），编码与 piexif/A1111 同约定（ASCII 前缀或 UNICODE 前缀 + UTF-16 带 BOM）；EXIF 单段约 64KB 限制，故不嵌工作流。同一张图的两种格式共用计数器编号。

## 前缀助手（`filename_prefix` 下方的前端面板）

- **下拉一键写入**：「最近使用」5 条（每次实际执行后自动记录）+「我的模板」（点「存」把当前前缀存为模板；下拉选中某条模板后点「删」移除）。
- **占位符 chips**：点击即把 `%seed%` 等 12 个占位符追加到前缀末尾，免背规则。
- **新建节点自动填入**最近使用的第一条（无历史时保持 `ComfyUI_Meta`）；加载工作流时以保存值为准，不自动填。
- 数据持久化在 `ComfyUI/user/0DAYE/save_image_metadata_prefix.json`（插件更新/重装不丢）；后端路由不可用时面板退化为内存态，不影响保存功能本身。

## 已知边界

- LLM 等运行时生成文本静态追溯不到 → `positive_node_id` 填节点 ID，或 `positive_text` / `negative_text` 手动接线。**文本缓存节点例外**：自动读其运行时历史最新一条（文本缓存在采样链上游、必先于本节点执行，同一遍运行即可读到本轮最终文本，含 `prefix` / `trigger_text` 触发词前缀，无需跑两遍）；该节点本遍未执行时才退回静态 `override_text`
- 已适配的第三方 LoRA 加载器（自动追溯，无需配置）：标准 `LoraLoader` / WAS `LoRA Loader`、rgthree `Power Lora Loader`、LoraManager `Lora Loader (LoraManager)` / `LoRA Text Loader` / `Lora Randomizer` / `Lora Stacker`（含 LORA_STACK 堆栈透传与 `lora_stack` 链接跟进）——以上在采样器 model 链上或经 LORA_STACK 侧链；easy-use `easy loraStack` / `easy loraSwitcher`（经 `optional_lora_stack` 链接从 `easy loraStackApply` / `easy fullLoader` 跟进，堆栈可串联、上游先应用，`toggle` 关时本级停用；switcher 只收 `select` 选中槽）、easy `xyPlot` 的 LoRA 轴（`XY inputs: Lora` 节点经 `x_values`/`y_values` 链接跟进）；LoraManager `Lora Cycler` / `Lora Pool` 的实际条目靠运行时随机/轮选，静态拿不到——请用 `lora_override` 手动填；其它冷门加载器用 `model_node_id` 指定，或 `lora_override` 手动填
- 冷门封装导致采样参数 / 模型 / LoRA 追溯不到 → `sampler_node_id` 指定采样器解析、`model_node_id` 指定模型/LoRA 来源节点，或直接用 `seed_override` / `steps_override` / `lora_override` 手动覆盖
- 多条独立采样流水线时取离本节点最近的采样器；`sampler_node_id` 可显式指定，绕过该推断
- 模型哈希首次计算读完整模型文件（数秒），之后命中边车缓存
