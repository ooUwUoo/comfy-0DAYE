# comfy_0DAYE

ComfyUI custom nodes. Category: `0DAYE`

**English** | [中文](README.zh-CN.md)

## Nodes

- **Split Inpaint** — Multi-region inpainting: automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Edit mode (Qwen Image 2.1 / Krea2 reference_latents) and img2img mode (SDXL etc.), with quality presets.
- **Text Cache** — Buffers upstream LLM output text: freeze the last good result (mute the LLM group and keep outputting it), manual override, LoRA trigger-word prefix (manual widget + trigger_words port), and per-node isolated history (50 entries, persisted across restarts) with an in-node panel (copy / fill-back / one-click clear).
- **Save Image Metadata** — Saves a main PNG plus an optional sidecar JPEG/WEBP (max two formats, no preview window) with CivitAI-recognizable A1111 metadata: auto-traces prompts / sampler settings / model / LoRAs from the workflow (model hash cached via `.sha256` sidecars). Individual toggles for parameters / LoRA / workflow embedding / standalone workflow JSON export / pre-save sanitization (API keys, tokens, path usernames → `[REDACTED]`), a native ComfyUI mode identical to the official Save Image, JPEG/WEBP quality control (1–100), filename placeholders (`%seed% %steps% %cfg% %sampler% %model% %prompt%` …), node-ID fallback for prompts / sampler / model / LoRA (`positive/negative/sampler/model/lora_node_id`) plus manual overrides for prompts, seed, steps, model and LoRA. A path-label panel sits below the filename field: collapsed it is just two dropdowns ("recent" / "my templates") where one pick writes straight into the filename box; expanded it shows the draft editor first and puts the "labels" dropdown on the same row as the apply / save-template buttons below it — built-in placeholders and custom labels merged into one ordered list you can drag to reorder, rename or delete individually inside the popup (with a restore-defaults button), one click on a label inserts it into the draft and closes the popup, then apply with one click or save it as a template (persisted under `ComfyUI/user/0DAYE/`, survives plugin updates).
- **Image Compare** — A/B image comparison in-node: a hover-tracking split line (default), press-and-hold peek, and opacity blending, with A/B swap. **Connect either (or both) inputs for preview.** Right-click menu copies A/B to the clipboard or **saves them as full-resolution PNGs with workflow metadata (drag back into ComfyUI to restore)**. Previews are GPU-downsampled for smooth transfers (output ports are unaffected); an info line shows the original resolution of each image. Outputs `image_a` (pass-through) and `concat` (A|B side-by-side).
- **Image Scaling** — Multi-purpose resize/crop: a single aspect-ratio dropdown (1:1 … 21:9) that can combine with three scaling modes — megapixel target / manual size (with one-click width↔height swap) / side-length — priority pixel > manual > side. Multiple-of alignment never upscales (crops one side, or shrinks proportionally from the short side), a 4 MP resolution cap, progressive scaling for cleaner large downscales, 11 crop methods (center/edge-aligned/stretch + expand-and-fill in five colors), 5 resampling filters, batch + mask lockstep, and width/height number outputs. Runs with no image connected (solid-color canvas; 1024×1024 white by default), so it doubles as a resolution picker for text-to-image.
- **Image Cache Preview** — Native preview plus history: every image flowing through is archived, and a thumbnail strip under the main preview pages through past results (thumbnails per page adapt live to the node width). Click a thumbnail to switch the main view; newest/oldest page, previous/next-image and clear buttons included; new images show the newest by default. **Two capacity levels**: 50 lightweight index entries per node plus a global 300-group image pool with LRU eviction, so disk usage does not grow with node or workflow count. Data lives in `ComfyUI/user/0DAYE/` and survives restarts and plugin updates. `image` passes through at original resolution, so the node fits between the sampler and a save node.

## Documentation

All detailed node docs: [docs/README.md](docs/README.md)

## Compatibility

- Nodes are defined with the official V3 DSL (`io.ComfyNode`); the backend auto-generates V1-compatible metadata, so both canvas renderers — classic **LiteGraph** and **Nodes 2.0 (Vue)** — load every node, and workflow JSON is interchangeable between them.
- Frontend extensions (`web/*.js`) run on both renderers; display-layer panels (history panel, path-label panel) degrade gracefully without affecting execution.
- Minimum verified environment: **ComfyUI 0.41.0+ with frontend package 1.55+** (includes the Nodes 2.0 toggle). Older ComfyUI versions that cannot parse V3 nodes are not supported — upgrade instead of expecting a silent fallback.

## Installation

- ComfyUI Manager: install via git URL `https://github.com/ooUwUoo/comfy-0DAYE.git`
- Manual: `cd ComfyUI/custom_nodes && git clone https://github.com/ooUwUoo/comfy-0DAYE.git`, then restart ComfyUI.

Requirements: ComfyUI 0.41.0+ (frontend package 1.55+), opencv-python, PyTorch.
