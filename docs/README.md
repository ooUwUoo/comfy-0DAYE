# comfy_0DAYE — Documentation

**English** | [中文](README.zh-CN.md)

| Node | Description |
|---|---|
| [Split Inpaint](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/split_inpaint.en.md) | Multi-region inpainting with automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Supports edit mode and img2img mode with quality presets. |
| [Text Cache](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/text_cache.en.md) | Buffers upstream LLM output text: freeze the last good result, manual override, LoRA trigger-word prefix, and per-node isolated history (persisted across restarts) with in-node panel (copy / fill-back / one-click clear). |
| [保存图像元数据 / Save Image Metadata](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/save_image_metadata.en.md) | Saves a main PNG plus an optional sidecar JPEG/WEBP (max two formats, no preview window) with CivitAI-recognizable A1111 metadata: auto-traces prompts / sampler settings / model / LoRAs, caches model hashes via `.sha256`, with toggles for parameters / LoRA / workflow embedding / standalone workflow JSON / sanitization, a native ComfyUI mode, JPEG/WEBP quality control, filename placeholders, and node-ID / manual overrides. |
| [Image Compare](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/image_compare.en.md) | In-node A/B image comparison: hover-tracking split line (default), press-and-hold peek, and opacity blending; connect either input to preview. Right-click copies A/B to the clipboard or **saves them as full-resolution PNGs with workflow metadata**. Previews are GPU-downsampled for smoothness; outputs `image_a` pass-through and `concat` side-by-side. |

[← Back to repo home](../README.md)
