# Image Cache Preview

[中文](image_cache.zh-CN.md) | [Back to home](../README.md)

A preview node with history: every image flowing through it is archived automatically, a thumbnail strip under the main preview lets you look back, and clicking a thumbnail switches the main view. The number of visible thumbnails adapts to the node width, with page/first/last and previous/next-image buttons. The `image` output passes the input through unchanged, so the node can sit anywhere between the sampler and a save node.

**Category:** `0DAYE`

## Inputs / Outputs

| Input | Description |
|---|---|
| `image` | Image to preview (required). Every image passing through is archived into the history cache |
| `history_key` | Advanced, default `-1`. `-1` = auto: the frontend writes the current node instance id, giving each node its own history; identical numbers make multiple nodes share one history |

| Output | Description |
|---|---|
| `image` | The input image, unchanged (**original resolution**, independent of the cached preview size). Can feed a save node or any downstream node |

The node is registered as an output node: **it runs and records even when its output port is unconnected**.

## Panel layout

```
┌───────────────────────┐
│                       │
│     main preview      │  ← resizes with the node (min ~160px)
│                  3/50 │  ← corner badge: index / total
├───────────────────────┤
│ □ □ □ □ □ □ □ □       │  ← thumbnail strip: newest left, oldest right, current highlighted
├───────────────────────┤
│ ⏮ ‹ 1/5 › ⏭ │ ◀Prev Next▶ Clear │
└───────────────────────┘
```

- **Adaptive thumbnail strip**: thumbnails per page = strip width ÷ thumbnail width (56px + gap). Resizing the node recalculates it live and the page count follows.
- **Newest first**: after every run the view returns to the newest (page 1, image 1). A batch is fully archived, with the first image of the batch shown by default.
- **Click a thumbnail** to show that image in the main area; the badge updates accordingly.

## Control bar

| Button | Action |
|---|---|
| `⏮` | Jump to the newest page (page 1) and show that page's newest image |
| `‹` | Previous page (newer images) |
| `›` | Next page (older images) |
| `⏭` | Jump to the oldest page (last page) |
| `◀ Prev` | Show the next newer image; auto-flips the page when needed |
| `Next ▶` | Show the next older image; auto-flips the page when needed |
| `Clear` | Clear this node's history list (with confirmation) |

**Direction of Prev / Next**: the strip is a timeline (**newest left, oldest right**, the newest image is leftmost), so "Prev" means a newer image (to the left) and "Next" means an older image (to the right). Buttons grey out at both ends.

## Right-click menu

Right-click the **main preview** or **any thumbnail** for the same actions as the native preview node (applied to the image under the cursor):

| Item | Original available (either mode) | Original expired |
|---|---|---|
| Open Image | Open the **original** (full-resolution PNG) in a new tab | Open the 1024px preview |
| Copy Image | Copy the **original** to the clipboard | Copy the preview |
| Save PNG Original | Download the **original PNG with prompt/workflow metadata embedded (drag back into ComfyUI to restore the workflow)** | — (falls back to "Save Image" for the preview) |
| Save JPG | **Transcode the original to JPG on the fly** (quality 95, CivitAI parameter string in EXIF) | — (same fallback) |
| Reveal in Explorer | Locate and select the cache file in the file manager (prefers the original, falls back to the preview) | Same |

**Saved images are CivitAI-readable in both formats**: the PNG original uses the tEXt `parameters` block, the JPG uses EXIF UserComment — both carry the A1111-format parameter string (positive/negative prompts, Steps/Sampler/CFG/Seed/size/model/LoRA hashes), exactly CivitAI's reading points. The PNG original additionally carries prompt/workflow for workflow restore.

## Full / lightweight mode

The node has an advanced option **store_full_image** (default on):

- **On (full mode)**: each group also stores a full-resolution PNG permanently under `user/0DAYE/`; right-click save gives the original with metadata; ~1–4 MB per group
- **Off (lightweight)**: only the 1024px preview is kept in `user/0DAYE/` (still carrying the CivitAI parameter string), ~tens of KB per group; **the full-resolution original goes to ComfyUI's official `temp/` directory** — within the current session you can still right-click to save the PNG original or a JPG (transcoded on the fly), and **it is wiped automatically by ComfyUI on startup and shutdown**. After a restart those history entries can only save the preview. Ideal when you want originals on demand without long-term disk cost. **Within a session each distinct image is written only once**: the lightweight original shares one dedup index with the ImageCompare node, so the same image passing through both nodes, or a fixed image run repeatedly, never occupies `temp/` twice.

## Capacity & disk usage

Two-level capacity; disk usage is independent of node count and workflow count:

| Level | Limit | Notes |
|---|---|---|
| Per-node history (drawer) | 50 entries | A lightweight index (id + size only) per `history_key`; nodes don't affect each other |
| Global image pool | **300 groups** | Shared by all nodes; overflow evicts the oldest by LRU and removes it from every node's list |

So no matter how many preview nodes or saved workflows you have, the cache directory holds at most 300 groups.

- Full mode: three files per group — large image capped at **1024px** (in-node display), thumbnail at **160px**, and a **full-resolution PNG with workflow metadata**; lightweight mode keeps only the first two in `user/0DAYE/`, with the full-resolution PNG in the official `temp/` (session-scoped, cleared on restart, not counted here; deduplicated within the session, possibly sharing one file with ImageCompare).
- Large/thumbnail files are JPEG (quality 92) without alpha, PNG with alpha.
- Rough disk usage: full mode 300 groups ≈ **0.3–1.2 GB** (depends on output resolution); lightweight mode `user/0DAYE/` side ≈ **20–60 MB**, while the `temp/` side accumulates over the session and is released when ComfyUI closes.

## Storage location

Everything lives under `ComfyUI/user/0DAYE/`, **surviving plugin updates, reinstalls and ComfyUI restarts**:

```
ComfyUI/user/0DAYE/
├── image_cache/                     # cached images ({id}_p large / {id}_t thumb / {id}_f full-res PNG)
└── image_cache_history.json         # group size index + per-node drawer lists
```

Compared with official directories:

| Directory | Written by | Characteristics |
|---|---|---|
| `temp/` | Native preview nodes; **this node's lightweight-mode originals** (`temp/0DAYE_image_cache/`, deduplicated within the session — may reuse a file already written by ImageCompare) | Wiped on ComfyUI startup and shutdown |
| `output/` | Save nodes | Kept forever, shown in the Assets panel |
| `user/0DAYE/image_cache/` | **this node** (previews/thumbnails + full-mode originals) | Survives restarts, not shown in Assets, auto-evicted by the global 300-group cap |

**The Clear button only clears this node's list; it does not delete cached files** — files are a shared global pool that other nodes may still reference, so they are released only by LRU eviction beyond 300 groups.

## Dual-engine compatibility

The panel is pure DOM and works in both LiteGraph (legacy canvas) and Nodes 2.0 (Vue canvas), and switching engines requires no page reload. The main preview stretches with the node (min ~160px) while the thumbnail strip and control bar keep fixed heights.
