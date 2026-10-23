# comfy_0DAYE — 文档

[English](README.md) | **中文**

| 节点 | 说明 |
|---|---|
| [蒙版分块重绘](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/split_inpaint.zh-CN.md) | 按蒙版连通域自动切分重绘：每块独立裁剪→编码→采样→颜色匹配→贴回。支持编辑模式与图生图模式，内置画质预设。 |
| [文本缓存](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/text_cache.zh-CN.md) | 接住上游 LLM 输出文本：固定好结果、手动覆盖、LoRA 触发词前缀拼接、每节点独立 50 条历史（持久化保存、重启保留），节点内面板可直接复制/回填/一键清空。 |
| [保存图像元数据](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/save_image_metadata.zh-CN.md) | 保存主 PNG 及可选附带 JPEG/WEBP（最多两种格式、无预览窗口），写入 CivitAI 可识别的 A1111 元数据：自动追溯提示词/采样参数/模型/LoRA，模型哈希经 `.sha256` 边车缓存；参数串/LoRA/工作流嵌入/独立工作流 JSON/脱敏各开关，支持原生 ComfyUI 模式、JPEG/WEBP 画质控制、文件名占位符与节点 ID / 手动覆盖兜底。 |
| [图像对比](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/image_compare.zh-CN.md) | 节点内 A/B 图像对比预览：划线跟随（默认）、按住点击、透明度混合，接任意一个输入即可预览；右键复制 A/B 到剪贴板或**保存为原始分辨率 PNG（含工作流元数据）**。预览图 GPU 下采样防卡顿，输出 `image_a` 原样透传与 `concat` 左右拼接图。 |

[← 返回仓库首页](../README.zh-CN.md)
