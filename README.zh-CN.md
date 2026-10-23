# comfy_0DAYE

ComfyUI 自定义节点插件。分类：`0DAYE`

[English](README.md) | **中文**

## 节点

- **蒙版分块重绘（Split Inpaint）** —— 多区域切分重绘：按蒙版连通域自动切分，每块独立裁剪→编码→采样→颜色匹配→贴回。支持编辑模式（Qwen Image 2.1 / Krea2 上下文参考）与图生图模式（SDXL 等），内置画质预设。
- **文本缓存（Text Cache）** —— 接住上游 LLM 输出的文本：好结果一次跑定后静音 LLM 组即可复用，支持手动覆盖、LoRA 触发词前缀拼接（手动框 + trigger_words 端口）与每节点独立的 50 条历史（持久化保存、重启保留），节点内面板可直接复制/回填/一键清空。
- **保存图像元数据（Save Image Metadata）** —— 保存主 PNG 及可选附带 JPEG/WEBP（最多两种格式、无预览窗口），写入 CivitAI 可识别的 A1111 元数据：提示词、采样参数、模型、LoRA 自动从工作流追溯（模型哈希经 `.sha256` 边车缓存，只算一次）。参数串/LoRA/工作流嵌入/独立工作流 JSON 导出/脱敏各开关，支持原生 ComfyUI 模式、JPEG/WEBP 画质控制（1–100）、文件名占位符（`%seed% %steps% %model% %prompt%` 等）与节点 ID / 手动覆盖兜底（提示词/采样器/模型/LoRA 分别可指定来源节点）。文件名前缀带「前缀助手」面板：最近使用/自定义模板一键写入 + 占位符点选追加（数据存于 `ComfyUI/user/0DAYE/`，插件更新不丢）。

- **图像对比（Image Compare）** —— 节点内 A/B 图像对比预览：划线跟随（默认，鼠标扫过分界线跟指针）、按住点击（按住显示 B 松开恢复 A）、透明度混合三种模式，A/B 可一键交换；**两个输入接任意一个（或两个）都能预览**。右键菜单把 A/B 分别复制到剪贴板或**保存为原始分辨率 PNG（含工作流元数据，可拖回 ComfyUI 恢复）**。预览图自动 GPU 下采样防卡顿（不影响输出端口），信息行显示 A/B 原始分辨率。输出 `image_a`（原样透传）与 `concat`（A|B 左右拼接）。

## 文档

全部节点详细说明：[docs/README.zh-CN.md](docs/README.zh-CN.md)

## 兼容性

- 节点基于官方 V3 DSL（`io.ComfyNode`）定义，后端自动生成 V1 兼容元数据：旧版 **LiteGraph** 画布与新版 **Nodes 2.0（Vue）** 画布均可正常加载全部节点，工作流 JSON 双向互通。
- 前端扩展（`web/*.js`）在两种渲染引擎下均可运行；历史面板、前缀助手等显示层功能异常时静默降级，不影响执行。
- 最低已验证环境：**ComfyUI 0.41.0+（前端包 1.55+，含 Nodes 2.0 开关）**。低于该版本、无法识别 V3 节点的 ComfyUI 不受支持，请升级，不要指望静默降级。

## 安装

- ComfyUI Manager：用 git 地址安装 `https://github.com/ooUwUoo/comfy-0DAYE.git`
- 手动：`cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`，然后重启 ComfyUI。

依赖：ComfyUI 0.41.0+（前端包 1.55+）、opencv-python、PyTorch。
