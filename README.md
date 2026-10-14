# comfy_0DAYE

ComfyUI custom node for multi-region inpainting with automatic connected-component mask splitting, per-region reference conditioning, built-in color matching, and quality presets.

## Node

### Split Inpaint

Splits the mask into connected regions using OpenCV `connectedComponentsWithStats`. Each region is independently cropped, upscaled, encoded, sampled, color-matched, and blended back.

**Category:** `0DAYE`

## Two Modes

| Mode | Models | Behavior |
|---|---|---|
| Edit mode (default) | Qwen Image 2.1, Krea2 | Zero latent + `reference_latents` in-context reference (auto per-region crop + optional extra refs). Denoise forced to 1.0. Best for content replacement. |
| Img2img mode | SDXL, SD1.5, Illustrious, Anima, Z-Image, any model | Crop latent as starting point. Denoise controls change strength (0.3~0.7 recommended). |

Non-vision models in edit mode automatically fall back to img2img.

## Quality Presets (`profile`)

Sampling speed depends only on canvas size; effective mask-region resolution ≈ canvas long edge / context factor.

| Profile | Context × Long edge | Region pixels | Best for |
|---|---|---|---|
| 极速轻绘 (0.6MP) | 1.5 × 768 | ~512px | SDXL/legacy models, quick tests |
| 快速轻绘 (1.0MP) | 2.0 × 1024 | ~512px | Fast drafts |
| 日常均衡 (1.4MP) (default) | 1.6 × 1216 | ~760px | Daily use |
| 小物精修 (1.8MP) | 1.3 × 1344 | ~1030px | Small objects: jewelry, faces |
| 关联融合 (2.3MP) | 2.2 × 1536 | ~700px | Large areas: sky, backgrounds |
| 极致画质 (4.0MP) | 1.3 × 2048 | ~1575px | Qwen 2.1 native 2K (VRAM-heavy) |
| 自定义 | manual sliders | - | Full manual control |

## Crop Mode (`crop_mode`)

| Option | Behavior |
|---|---|
| 自动 (default) | Auto-detects by model class name: square crop for UNet bucket-trained models (SD1.5/SDXL/Illustrious/Pony), free aspect ratio for DiT models (Qwen 2.1/Krea2/Z-Image/Anima/Flux, etc.) |
| 自由比例 | Crop follows mask aspect ratio — highest pixel efficiency |
| 方形裁切 | Forced square crop, auto-shifted inward at image borders — safest for legacy models |

## Color Matching (`color_match`)

Each inpainted region is color-matched against the original image (masked area) before blending back:

| Algorithm | Description |
|---|---|
| Mean (default) | Mean shift per channel — most stable with masks |
| Linear | Per-channel mean+std scaling — stronger |
| MKL | Global covariance mapping |
| Wavelet | Low-frequency color transfer — most natural for same-composition fixes |
| none | Disabled |

Adjust `color_strength` (0.0~1.0) to control correction intensity.

## Extra Reference Images

Dynamic inputs `image_2` ~ `image_10` (official Autogrow style — connect one, the next empty slot appears). Only used in edit mode:

- Encoded once with the official TextEncodeQwenImage21 preprocessing (~1MP, 32-aligned) and reused across all regions
- `image_1` is always the auto per-region crop; reference your extras in the prompt via `<image2>`, `<image3>`, etc.
- Total references (crop + extras) capped at 10
- Ignored automatically in img2img mode or on non-vision models

## Parameters

| Parameter | Default | Description |
|---|---|---|
| profile | 日常均衡(1.4MP) [cf=1.6, gs=1216] | Quality preset (see table above); preset values are encoded in the option text and synced to the sliders by the frontend |
| context_factor | 1.6 | Crop expansion factor (custom profile only) |
| guide_size | 1216 | Sampling canvas long edge (custom profile only) |
| crop_mode | 自动 | Crop shape (see table above) |
| steps | 30 | Sampling steps |
| cfg | 1.0 | Classifier-free guidance. Qwen ~1.0, SDXL ~7 |
| sampler_name | euler | Uses ComfyUI's full sampler list |
| scheduler | simple | Uses ComfyUI's full scheduler list |
| denoise | 0.6 | Img2img strength. Edit mode forces 1.0 |
| seed | 0 | Base seed, each region gets seed+idx |
| mask_expand | 4 | Dilate mask (pixels) to soften seams |
| mask_blur | 4.0 | Gaussian blur radius for edge feathering |
| min_area | 64 | Minimum pixel area to qualify as a region |
| process_alpha | off | Enable RGBA 4-channel processing (Qwen VAE native) |
| img2img_mode | off | Toggle between edit mode and img2img mode |
| color_match | Mean | Per-region color matching algorithm |
| color_strength | 1.0 | Color match intensity |

## Text Cache / History (`文本缓存(历史50)`)

Node that buffers the text output of upstream LLM nodes (prompt expansion / translation, etc.), so you don't have to re-run the LLM every time you want to reuse a good result.

**Category:** `0DAYE`

### Modes (`mode`)

| Mode | Behavior |
|---|---|
| `auto` (default) | Priority: ① `override_text` non-empty → output & record it; ② upstream `text` non-empty → pass through & record; ③ otherwise (upstream muted / unconnected) → output `history[history_index]` |
| `直通` (passthrough) | Always output upstream `text` (recorded when non-empty) |
| `历史` (history) | Always output `history[history_index]` — reuse the last result |
| `手动` (manual) | Always output `override_text` (recorded when non-empty) |

### Inputs / Outputs

| Input | Description |
|---|---|
| `text` | Connect the upstream LLM output. When the upstream group is **muted (Ctrl+M)**, this receives empty → `auto` falls back to history automatically |
| `override_text` | Manual override text (widget only, not linkable). Highest priority in `auto` mode; output & recorded. Clear it to return to live passthrough |
| `history_key` | `-1` = auto (each node instance gets its own isolated history via its instance id). Set the same number on multiple nodes to share one history |
| `history_index` | Which history entry to output: `0` = latest, up to `49` |

Outputs: `text` (result), `history_list` (numbered history with full text, `⏎` = newline placeholder).

### History

- Keeps the latest **50** entries per key, de-duplicated (same text as the newest entry is not re-added)
- In-memory only — **cleared on ComfyUI restart**
- The node's built-in panel lists the entries with hover-to-read-full-text, plus `复制` (copy to clipboard) and `回填` (fill back into `override_text`) per row; refreshes automatically after each run

### Tips

- To freeze the last good result: **mute (Ctrl+M) the upstream LLM group** — `auto` mode will keep outputting the previous text. **Bypass (Ctrl+B) does NOT trigger this**: bypass passes data through unprocessed, which is indistinguishable from live output, so use the explicit `历史` / `手动` mode instead.
- `回填` writes the selected entry into `override_text` and switches `mode` back to `auto`, so the filled text takes effect immediately.

## Installation

### Via ComfyUI Manager
1. Open ComfyUI Manager
2. Install via git URL: `https://github.com/ooUwUoo/comfy-0DAYE.git`

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ooUwUoo/comfy-0DAYE.git
```
Restart ComfyUI.

## Requirements

- ComfyUI (tested on 0.39+)
- opencv-python (cv2)
- PyTorch

## How It Works

1. Mask is analyzed via 8-connectivity `connectedComponentsWithStats`
2. Each region's bbox is expanded by `context_factor` (square or free-ratio depending on `crop_mode`) and upscaled so the long edge = `guide_size` (aspect ratio preserved, aligned to 32px)
3. In edit mode, the crop is encoded at ~1MP as `reference_latents[0]` (plus any extras), and sampling runs on a zero latent at the crop's canvas size
4. Each result is color-matched to the original region, decoded, downscaled back, and blended with feathered mask edges

## Supported Models

| Model | Edit mode | Img2img mode | Auto crop |
|---|---|---|---|
| Qwen Image 2.1 / 2.5 | Yes (reference_latents) | Yes | Free ratio |
| Krea2 | Yes (reference_latents + method) | Yes | Free ratio |
| Anima | Auto fallback to img2img | Yes | Free ratio |
| Z-Image | Auto fallback to img2img | Yes | Free ratio |
| Flux / Flux2 | Auto fallback to img2img | Yes | Free ratio |
| SDXL / SD1.5 / Illustrious / Pony | Auto fallback to img2img | Yes | Square |
