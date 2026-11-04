# -*- coding: utf-8 -*-
"""
0DAYE 图像缩放节点（Image Scaling）—— comfy_0DAYE

功能（完整复刻 Josia 图像缩放，V3 API 改写）：
1. 单一「选择比例」下拉：默认关；含 1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9 等比例
   - 选定比例且未开启任何缩放模式 → 按接入图片分辨率适配新比例，多余部分中心裁切
   - 选定比例且开启了缩放模式 → 二者同时生效：比例决定「目标宽高比」，
     缩放模式决定「尺寸量级」（边长缩放=某边指定像素 / 像素缩放=总像素百万像素）
2. 多维度缩放控制：边长缩放 / 像素缩放 / 手动宽高缩放（优先级：像素 > 手动 > 边长）
3. 渐进式缩放（低分辨率优化）、分辨率上限保护、边长倍数对齐
   （对齐语义：仅一边不合规 → 只裁切该边；两边都不合规 → 以短边为基准等比缩小后对齐；绝不放大）
4. 多裁剪方式（居中/对齐/拉伸 + 「扩展并填充」白/黑/绿/蓝/灰）+ 多缩放算法（BOX/BICUBIC 等）
5. 支持图像/遮罩输入输出，批量处理，输出宽度和高度数值
6. 允许空挂（不接图像）→ 未设尺寸时输出 1024×1024 白色图片；
   裁剪方式选「扩展并填充XX色」时输出对应纯色底板

本地文件名：image_scaling.py
节点标识：0DAYE_ImageScaling（英文基准显示名 Image Scaling；中文名「图像缩放」由 locales/zh 提供）
依赖：torch、numpy、PIL.Image、math、gc
"""

import math
import gc

import torch
import numpy as np
from PIL import Image

from comfy_api.latest import io

# ==================== 常量配置（复刻自 Josia node_properties.py，自包含） ====================

# 比例选项（单一「选择比例」下拉；列表顺序即下拉展示顺序；"关" 为默认（不锁定比例））
RATIO_OPTIONS = [
    "关",
    "1:1 正方形",
    "2:3 竖屏",
    "3:2 横屏",
    "3:4 竖屏",
    "4:3 横屏",
    "9:16 竖屏",
    "16:9 横屏",
    "21:9 超宽屏",
    "9:21 竖超宽",
]
# 各比例对应的宽高比 (宽/高)
RATIO_ASPECT = {
    "1:1 正方形": 1.0,
    "2:3 竖屏": 2.0 / 3.0,
    "3:2 横屏": 3.0 / 2.0,
    "3:4 竖屏": 3.0 / 4.0,
    "4:3 横屏": 4.0 / 3.0,
    "9:16 竖屏": 9.0 / 16.0,
    "16:9 横屏": 16.0 / 9.0,
    "21:9 超宽屏": 21.0 / 9.0,
    "9:21 竖超宽": 9.0 / 21.0,
}

# 边长倍数下拉选项（把输出宽高对齐到该倍数的整数倍；关=不对齐）
LOCK_MULTIPLE_CHOICES = ["关", "2", "4", "8", "16", "32", "64", "128"]

# 裁剪方式选项
# 前 6 项为「裁切/拉伸」：按目标尺寸裁掉多余部分或拉伸变形；
# 后 5 项为「扩展并填充」：保留完整图像、按目标尺寸居中贴合，空白区填充指定纯色
#   （用于图像扩展/外补绘，白/黑为常用底板，绿/蓝为 chroma key 占位，灰为中性底板）。
CROP_METHODS = [
    "中心裁剪", "对齐上边", "对齐下边", "对齐左边", "对齐右边", "拉伸缩放",
    "扩展并填充白色", "扩展并填充黑色", "扩展并填充绿色", "扩展并填充蓝色", "扩展并填充灰色",
]

# 缩放算法映射（area 对应最快的 BOX 滤波）
RESAMPLE_FILTERS = {
    "nearest-exact": Image.Resampling.NEAREST,
    "bilinear": Image.Resampling.BILINEAR,
    "area": Image.Resampling.BOX,
    "bicubic": Image.Resampling.BICUBIC,
    "lanczos": Image.Resampling.LANCZOS,
}

# 数值参数默认值与范围限制
DEFAULT_PARAMS = {
    "scale_length": 1024,
    "pixel_million": 1.00,
    "lock_multiple": "16",
    "resolution_steps": 1,
    "min_scale_length": 32,
    "max_scale_length": 4096,
    "min_pixel_million": 0.01,
    "max_pixel_million": 4.0,
    "min_steps": 1,
    "max_steps": 3,
    "manual_width": 1024,
    "manual_height": 1024,
    "min_manual_size": 32,
    "max_manual_size": 4096,
    "swap_wh": False,
    "default_base_width": 1024,
    "default_base_height": 1024,
    "max_total_pixels": 4_000_000,  # 400 万像素封顶
    "default_resample_algo": "area",  # 默认缩放算法：最快的 area
}

# 「扩展并填充」裁切方式 → 填充色 (R, G, B)
# 用于图像扩展/外补绘：保留完整图像、按目标尺寸居中贴合，空白区填充指定纯色。
# 白/黑为常用底板，绿/蓝为 chroma key 占位，灰为中性底板。
_EXPAND_FILL_COLORS = {
    "扩展并填充白色": (255, 255, 255),
    "扩展并填充黑色": (0, 0, 0),
    "扩展并填充绿色": (0, 255, 0),
    "扩展并填充蓝色": (0, 0, 255),
    "扩展并填充灰色": (128, 128, 128),
}


# ==================== 尺寸计算（模块级辅助函数，逻辑 1:1 复刻） ====================

def _align_to_multiple(width, height, multiple):
    """
    把 (width, height) 对齐到「边长倍数」multiple 的整数倍。
    语义（只裁切 / 只缩小，绝不放大）：
      1) 两边都已是倍数   → 原样返回、零改动。
      2) 只有一边不是倍数 → 该边「裁切」到最近的倍数（向下取整，裁掉不足一格的余数），
                            另一边保持不动。
                            例：1536×2732、倍数16 → 宽已合规，高 2732→2720，输出 1536×2720。
      3) 两边都不是倍数   → 以「短边」为基准等比缩小到最近的倍数，长边按同一比例缩小后
                            再向下对齐（等效于把缩放后多出的余数裁掉），保证宽高比不走形。
                            例：500×300、倍数16 → 短边 300→288，长边 500×0.96=480，输出 480×288。
    短边本身不足一格（< multiple）时，无法在不放大的前提下对齐 ⇒ 直接返回原尺寸。
    :return: (对齐后的宽, 对齐后的高)
    """
    m = int(multiple)
    if m <= 1:
        return width, height

    w_ok = (width % m == 0)
    h_ok = (height % m == 0)

    # 1) 两边都合规 → 零改动
    if w_ok and h_ok:
        return width, height

    # 2) 仅一边不合规 → 只裁切那一边，绝不缩放（保住另一边的原始像素）
    if w_ok or h_ok:
        if w_ok:
            return width, max(m, (height // m) * m)
        return max(m, (width // m) * m), height

    # 3) 两边都不合规 → 以短边为基准等比缩小，长边缩后对齐
    short_side, long_side = (width, height) if width <= height else (height, width)
    new_short = (short_side // m) * m
    if new_short < m:
        return width, height          # 短边不足一格：对齐只能靠放大 ⇒ 放弃对齐
    scale = new_short / short_side
    new_long = max(m, (int(long_side * scale) // m) * m)
    if width <= height:
        return new_short, new_long
    return new_long, new_short


def _check_resolution_limit(width, height, multiple=1):
    """
    分辨率上限保护：超过最大像素数时自动等比缩小（沿用同一套倍数对齐逻辑）。
    :param width: 目标宽度
    :param height: 目标高度
    :param multiple: 当前「边长倍数」取值（缩小后按它对齐；1 = 不对齐）
    :return: 调整后的宽高（符合最大像素限制）
    """
    total_pixels = width * height
    max_pixels = DEFAULT_PARAMS["max_total_pixels"]
    if total_pixels > max_pixels:
        scale_ratio = math.sqrt(max_pixels / total_pixels)
        new_w = max(1, int(width * scale_ratio))
        new_h = max(1, int(height * scale_ratio))
        new_w, new_h = _align_to_multiple(new_w, new_h, multiple)
        print(f"[Image Scaling] ⚠️ 分辨率超限（{width}×{height} = {total_pixels / 1e6:.2f}MP 超过 "
              f"{max_pixels / 1e6:.0f}MP 上限），已自动缩放到 {new_w}×{new_h}")
        return new_w, new_h
    return width, height


def _size_from_ratio_and_edge(aspect, side_len, side_type):
    """
    按选定比例 aspect(=宽/高) 与「最长边/最短边 = side_len」求解目标尺寸 (w, h)。
    示例：aspect=2/3(竖屏)，最长边=512 ⇒ 高=512、宽=round(512*2/3)=341；
          aspect=3/2(横屏)，最长边=512 ⇒ 宽=512、高=round(512*2/3)=341。
    """
    if side_type == "最长边":
        if aspect >= 1:          # 宽为最长边
            w = side_len
            h = int(round(side_len / aspect))
        else:                    # 高为最长边
            h = side_len
            w = int(round(side_len * aspect))
    else:  # 最短边
        if aspect >= 1:          # 高为最短边
            h = side_len
            w = int(round(side_len * aspect))
        else:                    # 宽为最短边
            w = side_len
            h = int(round(side_len / aspect))
    return max(1, w), max(1, h)


def _calculate_target_size(orig_w, orig_h, ratio_choice, ratio_enabled,
                           enable_side, side_type, side_len, enable_pixel, pixel_mill,
                           enable_manual, manual_w, manual_h, ratio_drives_aspect=False):
    """
    计算「未对齐的原始目标尺寸」（根据不同缩放模式）
    优先级：像素缩放 > 手动宽高 > 边长缩放 > 选择比例（按接入图分辨率适配新比例）> 原图透传

    注：本函数只负责算出尺寸，**不做「边长倍数」对齐** —— 对齐统一由
    `_align_to_multiple` 在 execute 中执行一次，避免两处对齐语义不一致。

    ratio_drives_aspect: 当「已选比例 + 任一缩放模式」同时成立时为真 —— 此时边长/像素缩放的
        目标宽高比应由「选定比例」决定，而非原图宽高比（否则无图退化为 1:1、
        有图按原图边作为参考系，比例形同失效）。与裁剪方式无关。
    :return: (目标宽度, 目标高度)
    """
    selected_aspect = RATIO_ASPECT.get(ratio_choice) if ratio_choice in RATIO_ASPECT else None

    # 像素缩放模式
    if enable_pixel:
        total_pixels = pixel_mill * 1_000_000
        # 默认使用原始图像的宽高比；选中比例时改用「选定比例」
        aspect_ratio = (selected_aspect if (ratio_drives_aspect and selected_aspect)
                        else (orig_w / orig_h if orig_h > 0 else 1.0))
        # 总像素 = w * h, 宽高比 = w / h ⇒ w^2 = total_pixels * aspect_ratio
        target_w = math.sqrt(total_pixels * aspect_ratio)
        target_h = target_w / aspect_ratio
        target_w, target_h = int(round(target_w)), int(round(target_h))
        return (max(32, target_w), max(32, target_h))

    # 手动宽高模式（用户显式指定，比例不干预）
    if enable_manual:
        return (max(32, manual_w), max(32, manual_h))

    # 边长缩放模式
    if enable_side:
        if ratio_drives_aspect and selected_aspect:
            # 以「选择的比例」为基准计算目标长宽（而非原图比例）：
            # 选定比例 aspect = 宽/高；按最长边/最短边 = side_len 解出 (w, h)。
            target_w, target_h = _size_from_ratio_and_edge(selected_aspect, side_len, side_type)
        elif orig_w > 0 and orig_h > 0:
            orig_max = max(orig_w, orig_h)
            orig_min = min(orig_w, orig_h)
            # 计算缩放比例：目标边长 / 原始对应边长
            if side_type == "最长边":
                scale = side_len / orig_max
            else:  # 最短边
                scale = side_len / orig_min
            # 应用等比例缩放
            target_w = int(orig_w * scale)
            target_h = int(orig_h * scale)
        else:
            # 无有效原始尺寸时，使用目标边长作为正方形
            target_w = target_h = side_len
        return (max(32, target_w), max(32, target_h))

    # 选择比例模式：按接入图片分辨率（像素面积）适配新比例，多余部分由调用方中心裁切
    if ratio_enabled and selected_aspect:
        area = max(1, orig_w) * max(1, orig_h)
        # area = w * h，w = aspect * h  ⇒  h = sqrt(area / aspect)，w = h * aspect
        target_h = int(round(math.sqrt(area / selected_aspect)))
        target_w = int(round(target_h * selected_aspect))
        return (max(32, target_w), max(32, target_h))

    # 默认返回原始尺寸（无任何尺寸设置时，原封不动透传；倍数对齐由调用方处理）
    return (max(32, orig_w), max(32, orig_h))


# ==================== 缩放与裁切执行 ====================

def _progressive_scale(img_pil, mask_pil, target_w, target_h, steps, algo, crop_method):
    """
    渐进式缩放（低分辨率优化）
    :return: (缩放后图像, 缩放后遮罩)
    """
    orig_w, orig_h = img_pil.size
    current_img, current_mask = img_pil, mask_pil
    resample = RESAMPLE_FILTERS.get(algo, Image.Resampling.BOX)

    for step in range(1, steps + 1):
        ratio = step / steps
        step_w = int(orig_w + (target_w - orig_w) * ratio)
        step_h = int(orig_h + (target_h - orig_h) * ratio)
        if step == steps:
            step_w, step_h = target_w, target_h

        current_img, current_mask = _apply_crop_or_stretch(
            current_img, current_mask, step_w, step_h,
            "拉伸缩放" if step < steps else crop_method, resample
        )
        gc.collect()

    return current_img, current_mask


def _single_scale(img_pil, mask_pil, target_w, target_h, algo, crop_method):
    """
    单步缩放（常规模式）
    :return: (缩放后图像, 缩放后遮罩)
    """
    resample = RESAMPLE_FILTERS.get(algo, Image.Resampling.BOX)
    return _apply_crop_or_stretch(img_pil, mask_pil, target_w, target_h, crop_method, resample)


def _is_expand_method(crop_method):
    """判断裁切方式是否为「扩展并填充」类（保留完整图像、空白区填充纯色）"""
    return crop_method in _EXPAND_FILL_COLORS


def _expand_and_fill(img, mask, target_w, target_h, fill_color, resample):
    """
    「扩展并填充」核心逻辑：
    保留完整图像，按目标框等比缩放居中贴合，空白区填充指定纯色 (R,G,B)。
    用于图像扩展 / 外补绘：当设定比例与原图不同时，不裁切画面，而是扩展并填充。
    :return: (处理后图像, 处理后遮罩)
    """
    orig_w, orig_h = img.size
    if orig_w <= 0 or orig_h <= 0:
        # 异常兜底：直接返回纯色底板
        canvas = Image.new("RGB", (target_w, target_h), fill_color)
        mcanvas = Image.new("L", (target_w, target_h), 0) if mask is not None else None
        return canvas, mcanvas

    # 等比缩放：取能完整放入目标框的最大尺寸（保持原图比例，绝不裁切）
    scale = min(target_w / orig_w, target_h / orig_h)
    new_w = max(1, int(round(orig_w * scale)))
    new_h = max(1, int(round(orig_h * scale)))
    resized = img.resize((new_w, new_h), resample)

    # 创建纯色底板并居中贴合
    canvas = Image.new("RGB", (target_w, target_h), fill_color)
    left = (target_w - new_w) // 2
    top = (target_h - new_h) // 2
    canvas.paste(resized, (left, top))

    # 遮罩同步：填充区为透明（黑），图像区保留
    mcanvas = None
    if mask is not None:
        mresized = mask.resize((new_w, new_h), resample)
        mcanvas = Image.new("L", (target_w, target_h), 0)
        mcanvas.paste(mresized, (left, top))

    del img, mask, resized
    gc.collect()
    return canvas, mcanvas


def _apply_crop_or_stretch(img, mask, target_w, target_h, method, resample):
    """
    裁切/拉伸缩放核心逻辑
    :param method: 裁剪方式（拉伸缩放/居中/左/右/上/下/扩展并填充XX色）
    :return: (处理后图像, 处理后遮罩)
    """
    # 扩展并填充：保留完整图像、按目标尺寸居中贴合，空白区填充指定纯色
    #   用于图像扩展/外补绘：当设定比例与原图不同时，不裁切画面，而是扩展图像并填充特定颜色。
    if method in _EXPAND_FILL_COLORS:
        return _expand_and_fill(img, mask, target_w, target_h, _EXPAND_FILL_COLORS[method], resample)

    orig_w, orig_h = img.size
    orig_aspect = orig_w / orig_h
    target_aspect = target_w / target_h

    temp_img = None
    temp_mask = None

    # 拉伸缩放（不保持比例）
    if method == "拉伸缩放":
        new_img = img.resize((target_w, target_h), resample)
        new_mask = mask.resize((target_w, target_h), resample) if mask is not None else None

    # 宽高比大于目标：水平裁剪
    elif orig_aspect > target_aspect:
        temp_h = target_h
        temp_w = int(temp_h * orig_aspect)
        temp_img = img.resize((temp_w, temp_h), resample)
        temp_mask = mask.resize((temp_w, temp_h), resample) if mask is not None else None

        # 确定裁剪左边界
        if method == "对齐左边":
            left = 0
        elif method == "对齐右边":
            left = temp_w - target_w
        else:  # 居中
            left = (temp_w - target_w) // 2

        new_img = temp_img.crop((left, 0, left + target_w, target_h))
        new_mask = temp_mask.crop((left, 0, left + target_w, target_h)) if temp_mask is not None else None

    # 宽高比小于目标：垂直裁剪
    elif orig_aspect < target_aspect:
        temp_w = target_w
        temp_h = int(temp_w / orig_aspect)
        temp_img = img.resize((temp_w, temp_h), resample)
        temp_mask = mask.resize((temp_w, temp_h), resample) if mask is not None else None

        # 确定裁剪上边界
        if method == "对齐上边":
            top = 0
        elif method == "对齐下边":
            top = temp_h - target_h
        else:  # 居中
            top = (temp_h - target_h) // 2

        new_img = temp_img.crop((0, top, target_w, top + target_h))
        new_mask = temp_mask.crop((0, top, target_w, top + target_h)) if temp_mask is not None else None

    # 宽高比一致：直接缩放
    else:
        new_img = img.resize((target_w, target_h), resample)
        new_mask = mask.resize((target_w, target_h), resample) if mask is not None else None

    # 释放临时变量
    if temp_img is not None:
        del temp_img
    if temp_mask is not None:
        del temp_mask
    del img, mask
    gc.collect()

    return new_img, new_mask


# ==================== 节点定义 ====================

class ImageScaling(io.ComfyNode):
    """图像缩放：选择比例 + 像素/手动宽高/边长三种缩放模式 + 边长倍数对齐 + 多裁剪方式，支持空挂纯色底板。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="0DAYE_ImageScaling",
            display_name="Image Scaling",
            category="0DAYE",
            inputs=[
                # 1. 选择比例（单一下拉，默认关）
                io.Combo.Input(
                    "ratio",
                    options=RATIO_OPTIONS,
                    default="关",
                    display_name="选择比例",
                    tooltip="目标宽高比。未开启任何缩放模式时，按接入图的像素面积适配该比例并裁掉多余部分；"
                            "与任一缩放模式同时开启时，比例决定「输出框形状」，缩放模式决定「尺寸大小」，"
                            "二者叠加生效、互不覆盖。",
                ),

                # 2. 基础控制参数
                io.Combo.Input(
                    "lock_multiple",
                    options=LOCK_MULTIPLE_CHOICES,
                    default=DEFAULT_PARAMS["lock_multiple"],
                    display_name="边长倍数",
                    tooltip="把输出宽高对齐到该倍数的整数倍（16 适配绝大多数 VAE 潜空间）。"
                            "对齐规则：仅一边不合规时只裁切那一边、不做缩放（如 1536×2732 → 1536×2720）；"
                            "两边都不合规时以短边为基准等比缩小后再对齐。全程只裁切或缩小、绝不放大。「关」= 不限制。",
                ),
                io.Combo.Input(
                    "crop_method",
                    options=CROP_METHODS,
                    default=CROP_METHODS[0],
                    display_name="裁剪方式",
                    tooltip="原图如何贴合目标尺寸。中心/上下左右裁切＝等比放大到铺满目标框后裁掉多余部分；"
                            "拉伸缩放＝直接拉伸变形到目标尺寸；"
                            "扩展并填充白/黑/绿/蓝/灰＝保留完整画面、空白处填对应纯色底板（适合图像外扩、抠像占位）。",
                ),
                io.Combo.Input(
                    "resample_algo",
                    options=list(RESAMPLE_FILTERS.keys()),
                    default=DEFAULT_PARAMS["default_resample_algo"],
                    display_name="缩放算法",
                    tooltip="重采样滤镜。area 最快（默认，缩小首选）；lanczos 质量最高但最慢；bicubic 平滑锐利；"
                            "bilinear 折中；nearest-exact 不插值（像素画、遮罩请选它）。",
                ),

                # 3. 边长缩放（带开关符号 📏）
                io.Boolean.Input(
                    "enable_side_scale",
                    default=False, label_on="true", label_off="false",
                    display_name="📏 启用边长缩放",
                    tooltip="按「缩放至边」指定的那条边缩放到「缩放长度」，另一边等比跟随。"
                            "若同时选了比例，则按选定比例解算宽高，而不是沿用原图比例。",
                ),
                io.Combo.Input(
                    "side_to_scale",
                    options=["最长边", "最短边"],
                    default="最长边",
                    display_name="缩放至边",
                    tooltip="让最长边还是最短边去匹配「缩放长度」（仅在边长缩放开启时生效）。",
                ),
                io.Int.Input(
                    "side_length",
                    default=DEFAULT_PARAMS["scale_length"],
                    min=DEFAULT_PARAMS["min_scale_length"],
                    max=DEFAULT_PARAMS["max_scale_length"],
                    step=1,
                    display_name="缩放长度",
                    tooltip="目标边长像素值，范围 32~4096（仅在边长缩放开启时生效）。",
                ),

                # 4. 像素缩放（带开关符号 🖼️）
                io.Boolean.Input(
                    "enable_pixel_scale",
                    default=False, label_on="true", label_off="false",
                    display_name="🖼️ 启用像素缩放",
                    tooltip="按「像素数量（百万）」控制总像素数（宽×高），优先级高于手动宽高与边长缩放。"
                            "若同时选了比例，则按选定比例的宽高比来分配这些像素。",
                ),
                io.Float.Input(
                    "pixel_million",
                    default=DEFAULT_PARAMS["pixel_million"],
                    min=DEFAULT_PARAMS["min_pixel_million"],
                    max=DEFAULT_PARAMS["max_pixel_million"],
                    step=0.01,
                    display_name="像素数量（百万）",
                    tooltip="目标总像素（百万像素）。1.0 ≈ 100 万像素（约 1024×1024）；0.25 ≈ 50 万像素。"
                            "上限 4.0（仅在像素缩放开启时生效）。",
                ),
                io.Int.Input(
                    "resolution_steps",
                    default=DEFAULT_PARAMS["resolution_steps"],
                    min=DEFAULT_PARAMS["min_steps"],
                    max=DEFAULT_PARAMS["max_steps"],
                    step=1,
                    display_name="分辨率步数",
                    tooltip="渐进式缩放步数：分几步逐步缩到目标尺寸。步数越多，大幅缩小时的画质越干净，但耗时更长。"
                            "1 = 一步到位；仅在目标小于 200 万像素的常规缩放路径生效。",
                ),

                # 5. 手动宽高（带开关符号 ✏️/🔄）
                io.Boolean.Input(
                    "enable_manual_size",
                    default=False, label_on="true", label_off="false",
                    display_name="✏️ 启用手动宽高",
                    tooltip="由「宽度 / 高度」直接指定目标尺寸，比例不再参与尺寸计算（可配合「切换宽高」一键转横竖）。",
                ),
                io.Boolean.Input(
                    "swap_wh",
                    default=DEFAULT_PARAMS["swap_wh"],
                    label_on="开启（宽↔高）",
                    label_off="关闭（原尺寸）",
                    display_name="🔄 切换宽高",
                    tooltip="把「宽度」「高度」两个值对调后使用，便于把横图一键改成竖图（仅手动宽高开启时生效）。",
                ),
                io.Int.Input(
                    "width",
                    default=DEFAULT_PARAMS["manual_width"],
                    min=DEFAULT_PARAMS["min_manual_size"],
                    max=DEFAULT_PARAMS["max_manual_size"],
                    step=1,
                    display_name="宽度",
                    tooltip="目标宽度像素值，范围 32~4096（仅手动宽高开启时生效；最终仍会按「边长倍数」对齐）。",
                ),
                io.Int.Input(
                    "height",
                    default=DEFAULT_PARAMS["manual_height"],
                    min=DEFAULT_PARAMS["min_manual_size"],
                    max=DEFAULT_PARAMS["max_manual_size"],
                    step=1,
                    display_name="高度",
                    tooltip="目标高度像素值，范围 32~4096（仅手动宽高开启时生效；最终仍会按「边长倍数」对齐）。",
                ),

                # 6. 可选图像/遮罩输入（允许空挂；optional 组渲染在其它控件下方）
                io.Image.Input(
                    "image",
                    optional=True,
                    display_name="图像",
                    tooltip="待处理图像（可选）。不接图且有尺寸设置时，输出该尺寸的纯色底板；"
                            "不接图且未设尺寸时输出 1024×1024 白色图。裁剪方式选「扩展并填充XX色」时输出对应颜色。",
                ),
                io.Mask.Input(
                    "mask",
                    optional=True,
                    display_name="遮罩",
                    tooltip="可选遮罩，与图像同步做同样的缩放/裁切；「扩展并填充」新增的空白区域在遮罩中记为 0（透明）。",
                ),
            ],
            outputs=[
                io.Image.Output("image", display_name="图像"),
                io.Mask.Output("mask", display_name="遮罩"),
                io.Int.Output("width", display_name="宽度"),
                io.Int.Output("height", display_name="高度"),
            ],
            description=(
                "📐 图像缩放\n"
                "多功能图像缩放裁切节点，支持「选择比例」与 3 种自定义缩放模式。\n\n"
                "• 🔁 选择比例：单一下拉（默认关），含 1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9\n"
                "       未开启任何缩放模式时，按接入图片分辨率适配新比例，多余部分中心裁切\n"
                "       与缩放模式同时开启时，比例决定输出框形状、缩放模式决定尺寸大小\n"
                "• 🖼️ 像素缩放：按百万像素目标自动计算尺寸（最高优先级）\n"
                "• ✏️ 手动宽高：直接指定宽高，支持一键切换宽高\n"
                "• 📏 边长缩放：按最长边 / 最短边缩放至指定像素\n\n"
                "⚙️ 高级特性：边长倍数对齐 / 多种裁剪方式（含「扩展并填充」白/黑/绿/蓝/灰）/ 5 种缩放算法 / 分辨率保护\n"
                "❗ 不设置任何尺寸时，图像仅按「边长倍数」对齐后透传：仅一边不合规 → 只裁切该边（不缩放）；\n"
                "   两边都不合规 → 以短边为基准等比缩小后对齐。无图像输入且未设尺寸时输出 1024×1024 白色图片，\n"
                "   裁切方式选「扩展并填充XX色」时输出对应纯色底板；\n"
                "   不接输出图片时可作为分辨率选择器提供宽高数值用于文生图"
            ),
        )

    @classmethod
    def execute(cls, ratio, lock_multiple, crop_method, resample_algo,
                enable_side_scale, side_to_scale, side_length,
                enable_pixel_scale, pixel_million, resolution_steps,
                enable_manual_size, swap_wh, width, height,
                image=None, mask=None):
        """
        核心图像缩放处理
        :param image: 输入图像张量（可选，未连线时不传）
        :param mask: 输入遮罩张量（可选，未连线时不传）
        :return: io.NodeOutput(处理后图像, 处理后遮罩, 最终宽度, 最终高度)
        """
        # 1. 参数适配（V3 显式参数 → Josia 原变量名语义）
        ratio_choice = ratio
        lock_multiple = 1 if lock_multiple == "关" else int(lock_multiple)
        manual_width, manual_height = width, height

        # 2. 切换宽高处理
        if swap_wh:
            manual_width, manual_height = manual_height, manual_width

        # 3. 获取原始尺寸（仅来自图像输入，无图像时使用默认值）
        if image is not None:
            orig_h, orig_w = image.shape[1], image.shape[2]
        else:
            orig_w = DEFAULT_PARAMS["default_base_width"]
            orig_h = DEFAULT_PARAMS["default_base_height"]

        # 4. 参数优先级控制（像素缩放 > 手动宽高 > 边长缩放 > 选择比例）
        #    当「选择比例」与任一下方缩放模式同时开启时，二者同时生效、互不覆盖：
        #      · 比例     ⇒ 驱动「目标宽高比」（输出框按选定比例生成）
        #      · 缩放模式 ⇒ 驱动「尺寸量级」（边长缩放→某边=指定像素；像素缩放→总像素=指定百万像素）
        #    仅当「未开启任何缩放模式」时，比例单独生效：按原图像素面积适配新比例并裁切。
        #    手动宽高为显式指定，优先于比例（比例不参与尺寸计算）。
        #    裁剪方式（居中/对齐/拉伸/扩展并填充）只决定原始图像与「目标框」的贴合方式，
        #    与「比例/缩放模式」正交 —— 因此无论哪种裁剪方式，比例+缩放模式都应同时工作。
        ratio_selected = (ratio_choice != "关")            # 用户是否选择了比例
        any_scale_mode = enable_pixel_scale or enable_manual_size or enable_side_scale
        # ratio_enabled 仅供「比例单独生效」分支（按原图面积适配比例后裁切）使用，
        # 开启缩放模式时置 False；此时比例改由下面的 ratio_drives_aspect 承担。
        ratio_enabled = ratio_selected and not any_scale_mode
        # 比例驱动目标宽高比：在「已选比例 + 任一缩放模式」时生效（通用，与裁剪方式无关）
        ratio_drives_aspect = ratio_selected and any_scale_mode
        # 用户是否主动设定了目标尺寸（用了任一缩放模式，或选了比例）。
        # 纯透传（两者都没有）时不触发分辨率上限缩放 —— 用户没要求改尺寸就不该改。
        user_set_target = any_scale_mode or ratio_selected

        # 5. 计算目标尺寸
        target_w, target_h = _calculate_target_size(
            orig_w, orig_h, ratio_choice, ratio_enabled,
            enable_side_scale, side_to_scale, side_length,
            enable_pixel_scale, pixel_million,
            enable_manual_size, manual_width, manual_height,
            ratio_drives_aspect=ratio_drives_aspect
        )

        # 6. 边长倍数对齐（优先裁切、必要时等比缩小、绝不放大）
        #    无任何尺寸设置时目标尺寸即原图尺寸，这里只把「不合规的边」裁掉或按短边等比缩掉，
        #    不再像旧版那样把两条边各自向下取整 —— 那会让本来就合规的边也被无谓改动。
        final_w, final_h = _align_to_multiple(target_w, target_h, lock_multiple)
        final_w, final_h = max(32, final_w), max(32, final_h)  # 最小尺寸限制

        # 6b. 分辨率上限保护：仅在用户主动设定了尺寸/比例时生效。
        #     纯透传时不做 —— 原图本来就在内存中，缩放只会白白损失画质
        #     （旧版即因此把 1536×2732 的透传图意外缩成了 1488×2656）。
        if user_set_target:
            final_w, final_h = _check_resolution_limit(final_w, final_h, lock_multiple)

        # 比例模式（未开启缩放模式）下，若用户未显式选择「扩展并填充」则强制中心裁切
        # （需求：选比例按原图分辨率裁切）；扩展并填充方式始终尊重用户选择，不参与强制中心裁切。
        if ratio_enabled and not any_scale_mode and not _is_expand_method(crop_method):
            effective_crop = "中心裁剪"
        else:
            effective_crop = crop_method

        # 7. 处理图像（批量处理）；无图像时输出空白图片
        if image is not None:
            batch_size = image.shape[0]
            processed_images = []
            processed_masks = []

            for batch_idx in range(batch_size):
                # 张量转 PIL 图像
                img_tensor = image[batch_idx].cpu().numpy()
                img_pil = Image.fromarray((img_tensor * 255).astype(np.uint8))
                mask_pil = None
                if mask is not None and batch_idx < mask.shape[0]:
                    mask_tensor = mask[batch_idx].cpu().numpy()
                    mask_pil = Image.fromarray((mask_tensor * 255).astype(np.uint8), mode="L")

                # 选择缩放方式（渐进式/单步）
                resample = RESAMPLE_FILTERS.get(resample_algo, Image.Resampling.BOX)
                if enable_manual_size:
                    img_pil, mask_pil = _apply_crop_or_stretch(img_pil, mask_pil, final_w, final_h, effective_crop, resample)
                elif _is_expand_method(effective_crop):
                    # 扩展并填充：居中贴合即可，无需渐进式（避免中间步拉伸变形）
                    img_pil, mask_pil = _single_scale(img_pil, mask_pil, final_w, final_h, resample_algo, effective_crop)
                elif resolution_steps > 1 and (final_w * final_h) < 2_000_000:
                    img_pil, mask_pil = _progressive_scale(img_pil, mask_pil, final_w, final_h, resolution_steps, resample_algo, effective_crop)
                else:
                    img_pil, mask_pil = _single_scale(img_pil, mask_pil, final_w, final_h, resample_algo, effective_crop)

                # PIL 转张量
                img_array = np.array(img_pil).astype(np.float32) / 255.0
                processed_images.append(torch.from_numpy(img_array))
                if mask_pil is not None:
                    mask_array = np.array(mask_pil).astype(np.float32) / 255.0
                    processed_masks.append(torch.from_numpy(mask_array))

                # 释放临时内存
                del img_tensor, img_pil, mask_pil
                gc.collect()

            # 拼接批量结果
            img_result = torch.stack(processed_images)
            mask_result = torch.stack(processed_masks) if processed_masks else torch.zeros((img_result.shape[0], final_h, final_w), dtype=torch.float32)
            del processed_images, processed_masks
            gc.collect()
        else:
            # 允许空挂（不接图像）→ 输出目标尺寸的纯色图片。
            # 默认白色（1024×1024，当未设置任何尺寸时）；若裁切方式选「扩展并填充XX色」，
            # 则输出对应纯色底板，便于作为图像扩展/外补绘的底色。
            # 注：即使未设尺寸，final_w/final_h 也已基于 DEFAULT 基准(1024×1024)与比例/边长倍数算出，
            #     故默认即为 1024×1024 白色图片，宽高输出也对应此分辨率。
            if _is_expand_method(crop_method):
                rgb = _EXPAND_FILL_COLORS[crop_method]
            else:
                rgb = (255, 255, 255)  # 默认白色
            color_f = torch.tensor(rgb, dtype=torch.float32) / 255.0
            img_result = color_f.reshape(1, 1, 1, 3).expand(1, final_h, final_w, 3).clone()
            mask_result = torch.zeros((1, final_h, final_w), dtype=torch.float32)

        # 8. 最终内存释放
        gc.collect()

        return io.NodeOutput(img_result, mask_result, final_w, final_h)
