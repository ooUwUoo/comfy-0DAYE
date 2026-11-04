# comfy_0DAYE — 文档

[English](README.md) | **中文**

| 节点 | 说明 |
|---|---|
| [蒙版分块重绘](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/split_inpaint.zh-CN.md) | 按蒙版连通域自动切分重绘：每块独立裁剪→编码→采样→颜色匹配→贴回。支持编辑模式与图生图模式，内置画质预设。 |
| [文本缓存](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/text_cache.zh-CN.md) | 接住上游 LLM 输出文本：固定好结果、手动覆盖、LoRA 触发词前缀拼接、每节点独立 50 条历史（持久化保存、重启保留），节点内面板可直接复制/回填/一键清空。 |
| [保存图像元数据](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/save_image_metadata.zh-CN.md) | 保存主 PNG 及可选附带 JPEG/WEBP（最多两种格式、无预览窗口），写入 CivitAI 可识别的 A1111 元数据：自动追溯提示词/采样参数/模型/LoRA，模型哈希经 `.sha256` 边车缓存；参数串/LoRA/工作流嵌入/独立工作流 JSON/脱敏各开关，支持原生 ComfyUI 模式、JPEG/WEBP 画质控制、文件名占位符与节点 ID / 手动覆盖兜底。 |
| [图像对比](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/image_compare.zh-CN.md) | 节点内 A/B 图像对比预览：划线跟随（默认）、按住点击、透明度混合，接任意一个输入即可预览；右键复制 A/B 到剪贴板或**保存为原始分辨率 PNG（含工作流元数据）**。预览图 GPU 下采样防卡顿，输出 `image_a` 原样透传与 `concat` 左右拼接图。 |
| [图像缩放](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/image_scaling.zh-CN.md) | 多功能图像缩放裁切：单一「选择比例」下拉可与三种缩放模式叠加（像素/手动宽高/边长，优先级 像素 > 手动 > 边长），边长倍数对齐绝不放大（单边只裁、双边短边基准等比缩小），400 万像素上限保护，渐进式缩放，11 种裁剪方式（中心/对齐/拉伸 + 扩展并填充五色）× 5 种缩放算法，图像/遮罩批量同步，输出宽高数值。允许空挂输出纯色底板，可兼作分辨率选择器。 |
| [图像缓存预览](https://github.com/ooUwUoo/comfy-0DAYE/blob/main/docs/image_cache.zh-CN.md) | 原生预览 + 历史回看：每张流经的图自动留档，大图下方缩略图条可翻页（每页张数随节点宽度自适应），点小图切大图，配最新/最旧页、上一张/下一张、清空按钮；新图默认显示最新。两级容量：每节点 50 条索引 + 全局 300 组图片池（LRU 淘汰），磁盘占用不随节点数增长。`image` 原样透传。 |

[← 返回仓库首页](../README.zh-CN.md)
