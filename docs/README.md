# comfy_0DAYE — Documentation

**English** | [中文](README.zh-CN.md)

| Node | Description |
|---|---|
| [Split Inpaint](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/split_inpaint.en.md) | Multi-region inpainting with automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Supports edit mode and img2img mode with quality presets. |
| [Text Cache](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/text_cache.en.md) | Buffers upstream LLM output text: freeze the last good result, manual override, and per-node isolated history with in-node panel (copy / fill-back). |
| [Save Image Metadata](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/save_image_metadata.en.md) | Saves a main PNG plus an optional sidecar JPEG/WEBP (max two formats, no preview window) with CivitAI-recognizable A1111 metadata: auto-traces prompts / sampler settings / model / LoRAs, caches model hashes via `.sha256`, with toggles for parameters / LoRA / workflow embedding / sanitization, a native ComfyUI mode, filename placeholders, and node-ID / manual overrides. |

[← Back to repo home](../README.md)
