# Text Cache (文本缓存)

[中文](text_cache.zh-CN.md) | [Back to README](../README.md)

Node that buffers the text output of upstream LLM nodes (prompt expansion / translation, etc.), so you don't have to re-run the LLM every time you want to reuse a good result.

**Category:** `0DAYE`

## Modes (`mode`)

| Mode | Behavior |
|---|---|
| `自动` (auto, default) | Priority: ① `override_text` non-empty → output & record it; ② upstream `text` non-empty → pass through & record; ③ otherwise (upstream muted / unconnected) → output `history[history_index]` |
| `上游` (upstream) | Always output upstream `text` (recorded when non-empty) |
| `历史` (history) | Always output `history[history_index]` — reuse the last result |

## Inputs / Outputs

| Input | Description |
|---|---|
| `text` | Connect the upstream LLM output — a socket-only input port (green dot, no textbox; sits below the widgets as it is optional). When the upstream group is **muted (Ctrl+M)**, this receives empty → `自动` falls back to history automatically |
| `override_text` | Manual override text (widget only, not linkable). Highest priority in `自动` mode; output & recorded. Clear it to return to live passthrough |
| `history_key` | `-1` = auto (each node instance gets its own isolated history via its instance id). Set the same number on multiple nodes to share one history |
| `history_index` | Which history entry to output: `0` = latest, up to `49` |

Outputs: `text` (result), `history_list` (numbered history with full text, `⏎` = newline placeholder).

## History

- Keeps the latest **50** entries per key, de-duplicated (same text as the newest entry is not re-added)
- In-memory only — **cleared on ComfyUI restart**
- The node's built-in panel lists the entries with hover-to-read-full-text, plus `复制` (copy to clipboard) and `回填` (fill back into `override_text`) per row; refreshes automatically after each run

## Tips

- To freeze the last good result: **mute (Ctrl+M) the upstream LLM group** — `自动` mode will keep outputting the previous text. **Bypass (Ctrl+B) does NOT trigger this**: bypass passes data through unprocessed, which is indistinguishable from live output, so use the explicit `历史` mode or fill `override_text` instead.
- `回填` writes the selected entry into `override_text` and switches `mode` back to `自动`, so the filled text takes effect immediately.
- UI: `text` is a socket-only port (no textbox); the history panel has its own drag handle at the bottom edge that **adjusts only the panel height (80–1000px)** without affecting the prompt box or other controls above; dragging the node's bottom-right corner only stretches the `override_text` area (native front-end behavior). Panel height persists with the workflow.
