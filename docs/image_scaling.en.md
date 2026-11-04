# Image Scaling

[中文](image_scaling.zh-CN.md) | [Back to home](../README.md)

A multi-purpose image resize/crop node: a single aspect-ratio dropdown plus three scaling modes (side-length / megapixel / manual size), multiple-of alignment, 11 crop methods and 5 resampling filters. It can run with no image connected (outputs a solid-color canvas) and can serve as a resolution picker via its width/height outputs.

**Category:** `0DAYE`

## Inputs

| Input | Description |
|---|---|
| `image` | Optional. Image to process; when disconnected, the node outputs a solid-color canvas at the target size (1024×1024 white if no size is set) |
| `mask` | Optional. Resized/cropped in lockstep with the image; padded regions from "expand & fill" are 0 (transparent) in the mask |

## Parameters

### Ratio

Single dropdown (default "off"): 1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9 / 9:21.

- **Ratio only, no scaling mode enabled**: the input image's pixel area is re-apportioned to the new aspect ratio and the excess is center-cropped.
- **Ratio + any scaling mode**: both apply — the ratio drives the target aspect, the scaling mode drives the size.

### Base controls

| Parameter | Description |
|---|---|
| `multiple` | Aligns output width/height to a multiple of this value (default 16, matching most VAE latent grids); "off" = no constraint |
| `crop method` | How the source fits the target frame (11 methods, see below) |
| `resampling` | `area` (default, fastest, best for downscaling) / `lanczos` (highest quality) / `bicubic` / `bilinear` / `nearest-exact` (no interpolation — use for pixel art and masks) |

### Three scaling modes (priority: pixel > manual > side)

| Mode | Parameters | Description |
|---|---|---|
| 📏 Side scaling | `side to scale` (longest/shortest) + `side length` (32–4096) | Scales the chosen side to the target pixels, the other side follows proportionally; with a ratio selected, width/height are solved from that ratio instead |
| 🖼️ Pixel scaling | `megapixels` (0.01–4.0) + `resolution steps` (1–3) | Derives dimensions from a total-pixel target; steps > 1 with a target under 2 MP enables progressive scaling (cleaner quality on large downscales) |
| ✏️ Manual size | `width` / `height` (32–4096) + `🔄 swap` | Explicit target size (ratio does not participate); swap flips landscape/portrait in one click |

With all modes off and ratio "off": **pure pass-through** — the image is only aligned to the multiple, never resampled.

## Alignment semantics (crop/shrink only, never upscale)

1. Both sides already multiples → untouched;
2. Only one side non-compliant → that side is cropped down to the nearest multiple, the other side kept (e.g. 1536×2732 → 1536×2720);
3. Both non-compliant → shrink proportionally from the short side to a multiple, then align the long side (e.g. 500×300 → 480×288) — the aspect ratio is preserved.

## Crop methods

| Method | Behavior |
|---|---|
| Center / top / bottom / left / right | Scale up proportionally to cover the target frame, then crop the excess (aligned to the chosen edge) |
| Stretch | Stretch directly to the target size (aspect ratio not preserved) |
| Expand & fill white/black/green/blue/gray | Keep the full image, scale to fit inside the target frame, center it, and fill the empty area with the chosen solid color (for outpainting / chroma-key placeholders); new mask areas are 0 |

When only a ratio is active and no "expand & fill" method is chosen, center crop is enforced.

## Resolution cap

Targets above **4 megapixels** are automatically shrunk proportionally (only when you explicitly set a size/ratio; pure pass-through is never downscaled).

## Outputs

| Output | Description |
|---|---|
| `image` | Processed image (batches handled per-frame) |
| `mask` | Processed mask (all zeros when no mask input) |
| `width` / `height` | Final output dimensions — with the image output unconnected, the node works as a **resolution picker** for text-to-image |

## No-image behavior

- No size configured → 1024×1024 white image;
- Size configured → solid-color canvas at that size (white by default; the chosen "expand & fill XX" color when such a crop method is selected).

## Dual-renderer compatibility

The node is defined with the official V3 DSL (`io.ComfyNode`) and ships no frontend scripts, so it runs identically on LiteGraph (classic canvas) and Nodes 2.0 (Vue canvas), with workflow JSON interchangeable between them.
