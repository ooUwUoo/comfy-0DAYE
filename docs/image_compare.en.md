# Image Compare

[中文](image_compare.zh-CN.md) | [Back to index](../README.md)

In-node A/B image comparison: compare images directly on the canvas via a hover-tracking split line (default), press-and-hold peek, or opacity blending — and right-click save gives you a full-resolution PNG with workflow metadata, so you can archive outputs without wiring a save node.

**Category:** `0DAYE`

## Inputs

| Input | Description |
|---|---|
| `image_a` | Optional. Comparison base (left/bottom); connecting only this turns the node into a plain previewer |
| `image_b` | Optional. Comparison target (right/top); **B alone also previews** (both outputs = B); add A later to compare |

**Either one (or both) can be connected for preview**; connecting none raises a clear error.

## Comparison modes (button bar above the preview)

| Mode | Interaction |
|---|---|
| **Split** (default) | Move the mouse across the image area: the divider follows the pointer — left shows A, right shows B; leave the area and the full A returns |
| **Click** | **Press and hold** on the image area to show B, **release** to return to A (quick peek) |
| **Blend** | Drag the opacity slider to overlay B onto A at 0–100% opacity (100% = pure B, 0% = pure A) |

- **Swap A/B**: one click swaps the two images' roles (reverses the comparison direction); the info line notes the swap.
- Mode / blend value are session-level state and are not serialized into workflow JSON; they persist across image refreshes.

## Right-click menu

Right-click anywhere on the node (including the preview):

| Menu item | Action |
|---|---|
| Copy A to clipboard | Writes image A (preview resolution) to the system clipboard (PNG, paste into WeChat/PS/etc.) |
| Save A image | Browser-downloads image A: **full-resolution PNG with native SaveImage-style `prompt`/`workflow` metadata — drag it back into ComfyUI to restore the workflow** (archive outputs without a save node) |
| Copy B to clipboard | Same, for image B |
| Save B image | Same, for image B (full resolution + metadata) |

Menu items for an image that has not been produced yet are omitted; after a swap the A/B labels follow the current display roles.

## Inputs / Outputs

| Input | Description |
|---|---|
| `image_a` | Image A (comparison base: left/bottom; also passed through unchanged by the `image_a` output) |
| `image_b` | Image B (comparison target: right/top). **Optional**: with only A connected it works as a plain previewer — connect B later when you want to compare |

| Output | Description |
|---|---|
| `image_a` | Image A, pass-through (original-resolution tensor) |
| `concat` | A\|B side-by-side concat: B is scaled to A's height (bicubic), channels unified to RGB; equals A when B is absent |

## Smooth preview (anti-lag)

Preview images sent to the frontend are automatically **GPU bicubic-downsampled (only when the long side exceeds 2048) and encoded as lossless PNG**, delivered via the official temp-preview channel (auto-cleaned on restart) — cutting websocket transfer and browser decode cost by an order of magnitude for large images. **The downsampling only affects the panel display and clipboard copy**; right-click "Save image" writes a separate **full-resolution** PNG (with workflow metadata); both output ports always carry the full original-resolution tensors.

## Info line

The line below the preview shows each image's **original resolution** (e.g. `A: 1024×1536   B: 1024×1536`), independent of preview scaling.

## Dual-engine compatibility

The preview is pure DOM, working identically on LiteGraph (legacy canvas) and Nodes 2.0 (Vue canvas). The image area **scales with the node**: dragging the node's bottom-right corner enlarges/shrinks the image area along with it (minimum ~120px); width follows node width.
