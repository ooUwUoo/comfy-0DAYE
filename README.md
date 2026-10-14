# comfy_0DAYE

ComfyUI custom nodes. Category: `0DAYE`

[English](#english) | [中文](#中文)

## English

Two nodes:

- **Split Inpaint (蒙版分块重绘)** — Multi-region inpainting: automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Edit mode (Qwen Image 2.1 / Krea2 reference_latents) and img2img mode (SDXL etc.), with quality presets.
- **Text Cache (文本缓存)** — Buffers upstream LLM output text: freeze the last good result (mute the LLM group and keep outputting it), manual override, and per-node isolated history (50 entries) with an in-node panel (copy / fill-back).

### Documentation

All detailed node docs: [docs/README.md](docs/README.md)（jump page with English / 中文 links）

### Installation

- ComfyUI Manager: install via git URL `https://github.com/ooUwUoo/comfy-0DAYE.git`
- Manual: `cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`, then restart ComfyUI.

Requirements: ComfyUI 0.39+, opencv-python, PyTorch.

## 中文

包含两个节点：

- **蒙版分块重绘（Split Inpaint）** —— 多区域切分重绘：按蒙版连通域自动切分，每块独立裁剪→编码→采样→颜色匹配→贴回。支持编辑模式（Qwen Image 2.1 / Krea2 上下文参考）与图生图模式（SDXL 等），内置画质预设。
- **文本缓存（Text Cache）** —— 接住上游 LLM 输出的文本：好结果一次跑定后静音 LLM 组即可复用，支持手动覆盖与每节点独立的 50 条历史，节点内面板可直接复制/回填。

详细使用说明见上方文档表格。安装：ComfyUI Manager 用 git 地址安装，或手动 clone 到 `ComfyUI/custom_nodes` 后重启。依赖：ComfyUI 0.39+、opencv-python、PyTorch。
