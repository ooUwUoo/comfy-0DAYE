# comfy_0DAYE

ComfyUI custom nodes. Category: `0DAYE`

**English** | [中文](README.zh-CN.md)

## Nodes

- **Split Inpaint (蒙版分块重绘)** — Multi-region inpainting: automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Edit mode (Qwen Image 2.1 / Krea2 reference_latents) and img2img mode (SDXL etc.), with quality presets.
- **Text Cache (文本缓存)** — Buffers upstream LLM output text: freeze the last good result (mute the LLM group and keep outputting it), manual override, and per-node isolated history (50 entries) with an in-node panel (copy / fill-back).

## Documentation

All detailed node docs: [docs/README.md](docs/README.md)

## Installation

- ComfyUI Manager: install via git URL `https://github.com/ooUwUoo/comfy-0DAYE.git`
- Manual: `cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`, then restart ComfyUI.

Requirements: ComfyUI 0.39+, opencv-python, PyTorch.
