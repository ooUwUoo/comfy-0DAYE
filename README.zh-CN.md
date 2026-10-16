# comfy_0DAYE

ComfyUI 自定义节点插件。分类：`0DAYE`

[English](README.md) | **中文**

## 节点

- **蒙版分块重绘（Split Inpaint）** —— 多区域切分重绘：按蒙版连通域自动切分，每块独立裁剪→编码→采样→颜色匹配→贴回。支持编辑模式（Qwen Image 2.1 / Krea2 上下文参考）与图生图模式（SDXL 等），内置画质预设。
- **文本缓存（Text Cache）** —— 接住上游 LLM 输出的文本：好结果一次跑定后静音 LLM 组即可复用，支持手动覆盖与每节点独立的 50 条历史，节点内面板可直接复制/回填。
- **元数据存图（Save Image Metadata）** —— 保存主 PNG 及可选附带 JPEG/WEBP（最多两种格式、无预览窗口），写入 CivitAI 可识别的 A1111 元数据：提示词、采样参数、模型、LoRA 自动从工作流追溯（模型哈希经 `.sha256` 边车缓存，只算一次）。参数串/LoRA/工作流嵌入/脱敏各开关，支持原生 ComfyUI 模式、文件名占位符（`%seed% %steps% %model% %prompt%` 等）与节点 ID / 手动覆盖兜底。

## 文档

全部节点详细说明：[docs/README.zh-CN.md](docs/README.zh-CN.md)

## 安装

- ComfyUI Manager：用 git 地址安装 `https://github.com/ooUwUoo/comfy-0DAYE.git`
- 手动：`cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`，然后重启 ComfyUI。

依赖：ComfyUI 0.39+、opencv-python、PyTorch。
