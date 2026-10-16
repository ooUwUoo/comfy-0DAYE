# 蒙版分块重绘（Split Inpaint）

[English](split_inpaint.en.md) | [返回首页](../README.zh-CN.md)

按蒙版连通域自动切分（OpenCV `connectedComponentsWithStats`），每个区域独立裁剪 → 放大 → 编码 → 采样 → 颜色匹配 → 羽化贴回。

**分类：** `0DAYE`

## 两种模式

| 模式 | 适用模型 | 行为 |
|---|---|---|
| 编辑模式（默认） | Qwen Image 2.1、Krea2 | 零潜变量 + `reference_latents` 上下文参考（自动逐区域裁剪图 + 可选额外参考图）。denoise 强制 1.0。最适合内容替换。 |
| 图生图模式 | SDXL、SD1.5、Illustrious、Anima、Z-Image 等任意模型 | 以裁剪区域潜变量为起点，denoise 控制改动强度（建议 0.3~0.7）。 |

非视觉模型选择编辑模式时自动回退图生图。

## 画质预设（`profile`）

采样速度只取决于画布大小；蒙版区域有效分辨率 ≈ 画布长边 ÷ context factor。

| 预设 | 扩展系数 × 长边 | 区域像素 | 适用场景 |
|---|---|---|---|
| 极速轻绘 (0.6MP) | 1.5 × 768 | ~512px | SDXL/老模型、快速测试 |
| 快速轻绘 (1.0MP) | 2.0 × 1024 | ~512px | 快速草稿 |
| 日常均衡 (1.4MP)（默认） | 1.6 × 1216 | ~760px | 日常使用 |
| 小物精修 (1.8MP) | 1.3 × 1344 | ~1030px | 小物件：首饰、脸部 |
| 关联融合 (2.3MP) | 2.2 × 1536 | ~700px | 大面积：天空、背景 |
| 极致画质 (4.0MP) | 1.3 × 2048 | ~1575px | Qwen 2.1 原生 2K（显存占用高） |
| 自定义 | 手动滑条 | - | 完全手动控制 |

## 裁切模式（`crop_mode`）

| 选项 | 行为 |
|---|---|
| 自动（默认） | 按模型类名自动判定：UNet 桶训练模型（SD1.5/SDXL/Illustrious/Pony）用方形裁切，DiT 模型（Qwen 2.1/Krea2/Z-Image/Anima/Flux 等）用自由比例 |
| 自由比例 | 裁切跟随蒙版长宽比——像素利用率最高 |
| 方形裁切 | 强制方形裁切，图像边缘处自动内移——老模型最稳 |

## 颜色匹配（`color_match`）

每块重绘区域贴回前，先对原图（蒙版区域）做颜色匹配：

| 算法 | 说明 |
|---|---|
| Mean（默认） | 逐通道均值平移——带蒙版最稳定 |
| Linear | 逐通道均值+方差缩放——力度更强 |
| MKL | 全局协方差映射 |
| Wavelet | 低频颜色迁移——同构图修复最自然 |
| none | 关闭 |

用 `color_strength`（0.0~1.0）控制校正强度。

## 额外参考图

动态输入 `image_2` ~ `image_10`（官方 Autogrow 风格——接一条线自动出现下一个空槽）。仅编辑模式生效：

- 用官方 TextEncodeQwenImage21 同款预处理（约 1MP、32 对齐）编码一次，所有区域复用
- `image_1` 始终是自动逐区域裁剪图；额外参考图在提示词里用 `<image2>`、`<image3>` 等引用
- 参考总数（裁剪图 + 额外图）上限 10
- 图生图模式或非视觉模型下自动忽略

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| profile | 日常均衡(1.4MP) [cf=1.6, gs=1216] | 画质预设（见上表）；预设数值编码在选项文本里，由前端同步到滑条 |
| context_factor | 1.6 | 裁剪扩展系数（仅自定义预设） |
| guide_size | 1216 | 采样画布长边（仅自定义预设） |
| crop_mode | 自动 | 裁切形状（见上表） |
| steps | 30 | 采样步数 |
| cfg | 1.0 | CFG。Qwen 约 1.0，SDXL 约 7 |
| sampler_name | euler | 使用 ComfyUI 完整采样器列表 |
| scheduler | simple | 使用 ComfyUI 完整调度器列表 |
| denoise | 0.6 | 图生图强度。编辑模式强制 1.0 |
| seed | 0 | 基础种子，每个区域为 seed+序号 |
| mask_expand | 4 | 蒙版扩张（像素），软化接缝 |
| mask_blur | 4.0 | 高斯模糊半径，边缘羽化 |
| min_area | 64 | 区域认定的最小像素面积 |
| process_alpha | off | 启用 RGBA 四通道处理（Qwen VAE 原生） |
| img2img_mode | off | 编辑模式 / 图生图模式切换 |
| color_match | Mean | 逐区域颜色匹配算法 |
| color_strength | 1.0 | 颜色匹配强度 |

## 工作原理

1. 蒙版经 8 连通域 `connectedComponentsWithStats` 分析切分
2. 每块 bbox 按 `context_factor` 扩展（方形或自由比例取决于 `crop_mode`），等比放大到长边 = `guide_size`（保持长宽比、32 对齐）
3. 编辑模式下裁剪图按约 1MP 编码为 `reference_latents[0]`（加上额外参考图），在裁剪画布尺寸的零潜变量上采样
4. 每块结果先对原区域做颜色匹配，再解码、缩回原尺寸、羽化边缘贴回

## 已验证模型

| 模型 | 编辑模式 | 图生图模式 | 自动裁切 |
|---|---|---|---|
| Qwen Image 2.1 / 2.5 | 支持（reference_latents） | 支持 | 自由比例 |
| Krea2 | 支持（reference_latents + method） | 支持 | 自由比例 |
| Anima | 自动回退图生图 | 支持 | 自由比例 |
| Z-Image | 自动回退图生图 | 支持 | 自由比例 |
| Flux / Flux2 | 自动回退图生图 | 支持 | 自由比例 |
| SDXL / SD1.5 / Illustrious / Pony | 自动回退图生图 | 支持 | 方形 |
