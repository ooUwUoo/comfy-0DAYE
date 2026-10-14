# comfy_0DAYE — 文档 / Documentation

[English](#english-docs) | [中文文档](#中文文档)

---

## English Docs

| Node | Description |
|---|---|
| [Split Inpaint](split_inpaint.en.md) | Multi-region inpainting with automatic connected-component mask splitting, per-region crop → encode → sample → color-match → blend back. Supports edit mode and img2img mode with quality presets. |
| [Text Cache](text_cache.en.md) | Buffers upstream LLM output text: freeze the last good result, manual override, and per-node isolated history with in-node panel (copy / fill-back). |

---

## 中文文档

| 节点 | 说明 |
|---|---|
| [蒙版分块重绘](split_inpaint.zh-CN.md) | 按蒙版连通域自动切分重绘：每块独立裁剪→编码→采样→颜色匹配→贴回。支持编辑模式与图生图模式，内置画质预设。 |
| [文本缓存](text_cache.zh-CN.md) | 接住上游 LLM 输出文本：固定好结果、手动覆盖、每节点独立 50 条历史，节点内面板可直接复制/回填。 |

---

[← Back to repo home](../README.md)
