# comfy_0DAYE

ComfyUI custom node for multi-region inpainting with automatic connected-component mask splitting.

## Node

### Split Inpaint

Splits the mask into connected regions using OpenCV `connectedComponentsWithStats`. Each region is independently cropped, upscaled, encoded, sampled, and blended back.

**Category:** `0DAYE`

## Two Modes

| Mode | Models | Behavior |
|---|---|---|
| Edit mode (default) | Qwen Image 2.1, Krea2 | Zero latent + `reference_latents` in-context reference. denoise forced to 1.0. Best for content replacement. |
| Img2img mode | SDXL, Anima, Z-Image, any model | Crop latent as starting point. denoise controls change strength (0.3~0.7 recommended). |

Non-vision models in edit mode automatically fall back to img2img.

## Parameters

| Parameter | Default | Description |
|---|---|---|
| context_factor | 1.58 | Crop region expansion factor around mask bbox |
| guide_size | 768 | Target upscale size per region (long edge) |
| steps | 30 | Sampling steps |
| cfg | 1.0 | Classifier-free guidance. Qwen ~1.0, SDXL ~7 |
| sampler_name | euler | Uses ComfyUI's full sampler list |
| scheduler | simple | Uses ComfyUI's full scheduler list |
| denoise | 0.6 | Img2img denoise strength. Edit mode forces 1.0 |
| seed | 0 | Base seed, each region gets seed+idx |
| mask_expand | 0 | Dilate mask (pixels) before processing |
| mask_blur | 4.0 | Gaussian blur radius for edge feathering |
| min_area | 64 | Minimum pixel area to qualify as a region |
| process_alpha | off | Enable RGBA 4-channel processing (Qwen VAE native) |
| img2img_mode | off | Toggle between edit mode and img2img mode |

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
2. Each region's bbox is expanded by `context_factor` and upscaled to `guide_size` (aspect ratio preserved, aligned to 32px)
3. Each crop is encoded to latent, sampled, decoded, downscaled back, and blended into the original image with feathered mask edges

## Supported Models

| Model | Edit mode | Img2img mode |
|---|---|---|
| Qwen Image 2.1 | Yes (reference_latents) | Yes |
| Krea2 | Yes (reference_latents + method) | Yes |
| Anima | Auto fallback to img2img | Yes |
| Z-Image | Auto fallback to img2img | Yes |
| SDXL | Auto fallback to img2img | Yes |
