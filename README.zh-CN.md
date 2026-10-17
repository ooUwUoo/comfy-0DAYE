# comfy_0DAYE

ComfyUI 自定义节点插件。分类：`0DAYE`

[English](README.md) | **中文**

## 节点

- **蒙版分块重绘（Split Inpaint）** —— 多区域切分重绘：按蒙版连通域自动切分，每块独立裁剪→编码→采样→颜色匹配→贴回。支持编辑模式（Qwen Image 2.1 / Krea2 上下文参考）与图生图模式（SDXL 等），内置画质预设。
- **文本缓存（Text Cache）** —— 接住上游 LLM 输出的文本：好结果一次跑定后静音 LLM 组即可复用，支持手动覆盖、LoRA 触发词前缀拼接（手动框 + trigger_words 端口）与每节点独立的 50 条历史（持久化保存、重启保留），节点内面板可直接复制/回填/一键清空。
- **保存图像元数据（Save Image Metadata）** —— 保存主 PNG 及可选附带 JPEG/WEBP（最多两种格式、无预览窗口），写入 CivitAI 可识别的 A1111 元数据：提示词、采样参数、模型、LoRA 自动从工作流追溯（模型哈希经 `.sha256` 边车缓存，只算一次）。参数串/LoRA/工作流嵌入/独立工作流 JSON 导出/脱敏各开关，支持原生 ComfyUI 模式、JPEG/WEBP 画质控制（1–100）、文件名占位符（`%seed% %steps% %model% %prompt%` 等）与节点 ID / 手动覆盖兜底（提示词/采样器/模型/LoRA 分别可指定来源节点）。文件名前缀带「前缀助手」面板：最近使用/自定义模板一键写入 + 占位符点选追加（数据存于 `ComfyUI/user/0DAYE/`，插件更新不丢）。

## 文档

全部节点详细说明：[docs/README.zh-CN.md](docs/README.zh-CN.md)

## 安装

- ComfyUI Manager：用 git 地址安装 `https://github.com/ooUwUoo/comfy-0DAYE.git`
- 手动：`cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`，然后重启 ComfyUI。

依赖：ComfyUI 0.39+、opencv-python、PyTorch。
