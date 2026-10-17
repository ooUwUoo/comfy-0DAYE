# Save Image Metadata

[中文](save_image_metadata.zh-CN.md) | [Back to README](../README.md)

Saves a main PNG plus an optional sidecar JPEG/WEBP (at most two formats, **no preview window** — connect an official Preview Image node if you want a preview) with CivitAI-recognizable A1111 metadata. Prompts, sampler settings, model and LoRAs are traced statically from the workflow (without triggering execution); model hashes are cached in `.sha256` sidecar files so they are computed only once.

**Category:** `0DAYE`

## Inputs

| Input | Description |
|---|---|
| `images` | Images to save (passthrough) |
| `filename_prefix` | Filename prefix. Supports the official `%date%` / `%batch_num%` placeholders plus `%seed% %steps% %cfg% %sampler% %scheduler% %denoise% %model% %width% %height% %prompt%`. Invalid characters become `-`, missing values become `unknown` |
| `save_png` | Write the main PNG (default on) |
| `extra_format` | Sidecar format: `不保存` (none) / `JPEG` / `WEBP` (default JPEG) — at most two formats total |
| `mode` | `CivitAI 元数据` (CivitAI metadata, default) / `原生 ComfyUI` (native ComfyUI) — see below |
| `embed_parameters` | Embed the A1111 parameter string into the PNG (`tEXt parameters`) |
| `embed_lora` | Include LoRA info (inline `<lora:...>` tags + `Lora hashes:`) |
| `embed_workflow` | Embed the workflow into the PNG (default **off**) |
| `save_workflow_json` | Save a standalone workflow JSON file (default **off**): named after the image with a `.json` extension, in UI format (draggable back into ComfyUI); sanitized with the same rules as the PNG-embedded workflow |
| `sanitize` | Redact secrets and path usernames before saving (default on) |
| `quality` | JPEG/WEBP quality: an integer input (1–100, default 85; PNG lossless is unaffected). Reference tiers: ultra-high 95, high 85, normal 78 |
| `positive_node_id` / `negative_node_id` | `-1` = auto. Set a node ID to read the prompt from that node's text widget |
| `sampler_node_id` | `-1` = auto. Set a node ID to treat that node as the sampler — seed/steps/cfg/sampler/scheduler and model/LoRA are all derived from it |
| `seed_override` / `steps_override` | `-1` = keep the traced value. `seed` applies when ≥ 0, `steps` applies when > 0 |
| `model_node_id` | Model fallback node ID (-1 = auto-trace via the sampler's model chain). Set it to a node like rgthree Power Lora Loader or a Checkpoint loader to scan models/LoRAs from that node onward |
| `lora_node_id` | Independent LoRA fallback node ID (-1 = follow `model_node_id`/sampler chain). Set a node ID to additionally scan LoRAs from that node (including its `lora_stack`/`optional_lora_stack` links); results are merged with the model-chain scan and de-duplicated — useful when the LoRA loader is not on the model chain |
| `lora_override` | LoRA list, one per line; supports `name:weight` or `<lora:name:weight>` (weight defaults to 1.0) |
| `positive_text` / `negative_text` | Optional socket-only inputs that supply the prompt text directly |

Override priority: manual inputs (the overrides above plus `positive_text` / `negative_text`) > node-ID fallback (`positive/negative/sampler_node_id/model_node_id/lora_node_id`) > automatic tracing.

**Advanced options folding**: 13 inputs — `quality`, `sanitize`, `embed_parameters`, `embed_lora`, `embed_workflow`, `save_workflow_json`, `seed_override`, `steps_override`, `lora_override`, `positive_node_id`, `negative_node_id`, `sampler_node_id`, `model_node_id` — are collapsed by default behind the "Show advanced inputs" button at the bottom of the node (Nodes 2.0 canvas only; the legacy LiteGraph canvas shows everything flat, unaffected). `filename_prefix`, `save_png`, `extra_format`, `mode` and `lora_node_id` stay visible.

## Outputs

`images` (passthrough) and `parameters` (the A1111 parameter string actually written). No `ui` payload is returned, so the node has **no preview window**.

## Metadata Modes (`mode`)

| Mode | Behavior |
|---|---|
| `CivitAI 元数据` (default) | Writes the A1111 parameter string and embeds it according to the toggles below |
| `原生 ComfyUI` | Identical to the official Save Image — the PNG embeds only `prompt` + workflow (forced); the parameter string and EXIF are never written; the embedding toggles have no effect |

## Extraction Mechanism

Fully static — reads the hidden prompt graph, never triggers execution.

- **Sampler detection**: nodes whose inputs include one of `positive` / `negative` plus `cfg` plus `seed` / `noise_seed` (covers KSampler / Advanced / SamplerCustom and wrappers); a BFS upward from this node takes the nearest match.
- **Parameters** (`seed` / `steps` / `cfg` / `sampler_name` / `scheduler` / `denoise`): follow same-named input links (Seed node, KSamplerSelect) and structural links (`sampler` / `scheduler` / `sigmas` / `guider`, e.g. BasicScheduler), depth ≤ 5, falling back to the target's value widget.
- **Text**: `text`-type widgets of encoder nodes are read directly; `conditioning` / `positive` / `negative` structural links go one level deeper (FluxGuidance chains). `text` / `prompt` links only follow to Text Cache — the latest runtime-history entry (this pass's final output, including the trigger-word prefix) is read first, falling back to the static `override_text` only when history is empty; LLM nodes are not traced (the wrong widget would be read and left empty — instead set `positive_node_id` or wire `positive_text`). ConditioningZeroOut is treated as empty.
- **Model / LoRA**: walk the sampler's `model` link linearly (nearest → farthest = application reversed; reversing gives the application order); recognise `ckpt_name` / `unet_name` / `lora_name` widgets. Hash = first 10 hex chars of sha256 (AutoV2), cached in `<model file>.sha256`.

## Sanitization (`sanitize`)

- JSON key-name substring match (api_key / token / secret / password / authorization / cookie …; whitelisted names such as `max_tokens` are not touched)
- String values are additionally scanned for token formats: sk- / sk-proj- / sk-ant-, hf_, gh*_ / github_pat_, AIza, AKIA, xox?-, r8_, JWT, Bearer headers, sensitive URL query params (`?api_key=…`)
- Absolute path usernames (`C:\Users\xxx` / `/home/xxx` → `[USER]`, keeping the rest of the path)
- Applied to the embedded prompt / `extra_pnginfo` (structure preserved, still draggable back) and to the parameter string itself; replaced with `[REDACTED]`

## Written Format (what CivitAI reads)

- A1111 parameter string: positive prompt + inline ` <lora:name:weight>` tags → `Negative prompt:` line → `Steps:, Sampler:, CFG scale:, Seed:, Size: WxH, Model hash:, Model:, Denoising strength:, Lora hashes:` field lines (missing fields are skipped; `denoise=1` is omitted; both LoRA blocks are dropped when `embed_lora` is off)
- PNG: `tEXt parameters` (when `embed_parameters` is on); when `embed_workflow` is on or in native mode, `prompt` + each `extra_pnginfo` key are embedded per the official SaveImage convention (draggable back into ComfyUI to restore the workflow)
- JPEG/WEBP: EXIF UserComment (0x9286), encoded like piexif/A1111 (ASCII prefix or UNICODE prefix + UTF-16 with BOM); the ~64KB EXIF segment limit means the workflow is not embedded. Both formats of the same image share one counter.
- Standalone workflow JSON (when `save_workflow_json` is on): named after the image with `.json` extension, content taken from `extra_pnginfo.workflow` (UI format, draggable back to restore); sanitized via `_sanitize_obj` (same rules as the PNG embedding); write failures only log a warning and do not abort.

## Prefix Helper (front-end panel below `filename_prefix`)

- **One-click dropdown**: "最近使用" (recent, 5 entries recorded automatically after each actual run) + "我的模板" (my templates — click 「存」 to store the current prefix as a template; select a template and click 「删」 to remove it).
- **Placeholder chips**: click to append any of the 12 placeholders (`%seed%` etc.) to the end of the prefix — no need to memorize the rules.
- **New nodes auto-fill** the most recently used prefix (falls back to `ComfyUI_Meta` when there is no history); loading a workflow always keeps its saved value.
- Persisted to `ComfyUI/user/0DAYE/save_image_metadata_prefix.json` (survives plugin updates/reinstalls); if the backend route is unavailable the panel degrades to in-memory state and saving itself is unaffected.

## Known Limits

- Runtime-generated text (LLM, …) cannot be traced statically → set `positive_node_id`, or wire `positive_text` / `negative_text`. **Exception: the Text Cache node** — its latest runtime-history entry is read automatically (the cache runs upstream of the sampler, so the same pass already has this round's final text including the `prefix` / `trigger_text` trigger words; no second run needed); the static `override_text` is used only as a fallback when the cache did not execute in this pass
- Third-party LoRA loaders already supported (auto-traced, no config): standard `LoraLoader` / WAS `LoRA Loader`, rgthree `Power Lora Loader`, LoraManager `Lora Loader (LoraManager)` / `LoRA Text Loader` / `Lora Randomizer` / `Lora Stacker` (incl. LORA_STACK passthrough and `lora_stack` link following) — on the sampler's model chain or via LORA_STACK side links; easy-use `easy loraStack` / `easy loraSwitcher` (followed via the `optional_lora_stack` link from `easy loraStackApply` / `easy fullLoader`; stacks can be chained, upstream applies first, `toggle` off disables that level; the switcher captures only the `select`-ed slot), and the LoRA axis of easy `xyPlot` (`XY inputs: Lora` node followed via `x_values` / `y_values` links); LoraManager `Lora Cycler` / `Lora Pool` pick entries at runtime (random/cycled) with no static list — fill `lora_override` manually; for other loaders use `model_node_id` or `lora_override`
- Unusual wrappers may hide sampler settings / model / LoRA → set `sampler_node_id` (sampler), `model_node_id` (model source), or `lora_node_id` (LoRA source, when the LoRA loader is not on the model chain), or use `seed_override` / `steps_override` / `lora_override`
- With several independent sampling pipelines the sampler nearest to this node is used; `sampler_node_id` overrides that inference
- The first model-hash computation reads the whole model file (a few seconds); later runs hit the sidecar cache
