# comfy_0DAYE

ComfyUI custom nodes. Category: `0DAYE`

**English** | [中文](README.zh-CN.md)

## Nodes

- **Split Inpaint** — Multi-region inpainting: automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Edit mode (Qwen Image 2.1 / Krea2 reference_latents) and img2img mode (SDXL etc.), with quality presets.
- **Text Cache** — Buffers upstream LLM output text: freeze the last good result (mute the LLM group and keep outputting it), manual override, LoRA trigger-word prefix (manual widget + trigger_words port), and per-node isolated history (50 entries, persisted across restarts) with an in-node panel (copy / fill-back / one-click clear).
- **Save Image Metadata** — Saves a main PNG plus an optional sidecar JPEG/WEBP (max two formats, no preview window) with CivitAI-recognizable A1111 metadata: auto-traces prompts / sampler settings / model / LoRAs from the workflow (model hash cached via `.sha256` sidecars). Individual toggles for parameters / LoRA / workflow embedding / pre-save sanitization (API keys, tokens, path usernames → `[REDACTED]`), a native ComfyUI mode identical to the official Save Image, filename placeholders (`%seed% %steps% %cfg% %sampler% %model% %prompt%` …), node-ID prompt/sampler fallback (`positive/negative/sampler_node_id`) plus manual overrides for prompts, seed, steps, model and LoRA. A prefix-helper panel below the filename field offers one-click recent/custom templates and placeholder chips (persisted under `ComfyUI/user/0DAYE/`, survives plugin updates).

## Documentation

All detailed node docs: [docs/README.md](docs/README.md)

## Installation

- ComfyUI Manager: install via git URL `https://github.com/ooUwUoo/comfy-0DAYE.git`
- Manual: `cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`, then restart ComfyUI.

Requirements: ComfyUI 0.39+, opencv-python, PyTorch.
