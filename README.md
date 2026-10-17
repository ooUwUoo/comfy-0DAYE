# comfy_0DAYE

ComfyUI custom nodes. Category: `0DAYE`

**English** | [中文](README.zh-CN.md)

## Nodes

- **Split Inpaint** — Multi-region inpainting: automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Edit mode (Qwen Image 2.1 / Krea2 reference_latents) and img2img mode (SDXL etc.), with quality presets.
- **Text Cache** — Buffers upstream LLM output text: freeze the last good result (mute the LLM group and keep outputting it), manual override, LoRA trigger-word prefix (manual widget + trigger_words port), and per-node isolated history (50 entries, persisted across restarts) with an in-node panel (copy / fill-back / one-click clear).
- **保存图像元数据（Save Image Metadata）** — Saves a main PNG plus an optional sidecar JPEG/WEBP (max two formats, no preview window) with CivitAI-recognizable A1111 metadata: auto-traces prompts / sampler settings / model / LoRAs from the workflow (model hash cached via `.sha256` sidecars). Individual toggles for parameters / LoRA / workflow embedding / standalone workflow JSON export / pre-save sanitization (API keys, tokens, path usernames → `[REDACTED]`), a native ComfyUI mode identical to the official Save Image, JPEG/WEBP quality control (1–100), filename placeholders (`%seed% %steps% %cfg% %sampler% %model% %prompt%` …), node-ID fallback for prompts / sampler / model / LoRA (`positive/negative/sampler/model/lora_node_id`) plus manual overrides for prompts, seed, steps, model and LoRA. A prefix-helper panel below the filename field offers one-click recent/custom templates and placeholder chips (persisted under `ComfyUI/user/0DAYE/`, survives plugin updates).

## Documentation

All detailed node docs: [docs/README.md](docs/README.md)

## Compatibility

- Nodes are defined with the official V3 DSL (`io.ComfyNode`); the backend auto-generates V1-compatible metadata, so both canvas renderers — classic **LiteGraph** and **Nodes 2.0 (Vue)** — load every node, and workflow JSON is interchangeable between them.
- Frontend extensions (`web/*.js`) run on both renderers; display-layer panels (history panel, prefix helper) degrade gracefully without affecting execution.
- Minimum verified environment: **ComfyUI 0.41.0+ with frontend package 1.55+** (includes the Nodes 2.0 toggle). Older ComfyUI versions that cannot parse V3 nodes are not supported — upgrade instead of expecting a silent fallback.

## Installation

- ComfyUI Manager: install via git URL `https://github.com/ooUwUoo/comfy-0DAYE.git`
- Manual: `cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`, then restart ComfyUI.

Requirements: ComfyUI 0.41.0+ (frontend package 1.55+), opencv-python, PyTorch.
