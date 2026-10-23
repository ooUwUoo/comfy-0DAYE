# -*- coding: utf-8 -*-
"""
图像对比节点（ImageCompare）—— comfy_0DAYE

用途：
  接收 A/B 两张图（B 可选），前端预览区内做三种对比：划线跟随（默认）/ 按住点击 / 透明度混合；
  右键菜单可把 A/B 分别复制到剪贴板或保存到磁盘。纯预览节点（is_output_node），无预览
  之外副作用；输出端口：image_a 原样输出（原始分辨率）+ concat 左右拼接图（B 未接时=A）。

防卡顿机制（参考小珠光图像对比的 reduce_lag，简化为零配置固定策略）：
  大图经 websocket 传输 + 浏览器解码是预览卡顿主源 → 送前端的预览图统一做
  GPU bicubic 下采样（长边 > PREVIEW_MAX_SIDE 才缩）+ PNG 无损编码（官方原生存图格式），
  存 ComfyUI temp 目录（官方 /view 惯例，重启自动清理）；输出端口不受影响，
  image_a / concat 始终是原始分辨率的完整 tensor。

双文件策略（防卡顿与原档保存两全，2026-10-18）：
  每张图每次执行写两份 PNG——预览文件（下采样、面板显示+复制剪贴板用）与
  全分辨率文件（含官方 SaveImage 同款 prompt/workflow 元数据，右键「保存」下载用，
  可直接拖回 ComfyUI 恢复工作流）；未触发下采样时两用途共用同一文件。
  接收 A/B 两图均可选（只接一个端口也能预览），一个都没接执行报错。

ui 数据约定（前端 image_compare.js 消费）：
  ui.a_images / ui.b_images 各一项：{filename, subfolder, type:"temp",
  orig_width, orig_height[, full:{filename, subfolder, type:"temp"}]}——
  orig_* 是原始张量尺寸（下采样前的），前端信息行显示用；full 是全分辨率文件项，
  缺省=预览文件本身（未下采样共用）。
"""

import json
import os

import numpy as np
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths
from comfy.cli_args import args
from comfy_api.latest import io

# 预览分辨率上限：2048 在 16G 显存机器上清晰度足够、传输解码开销小一个量级；PNG 无损（官方原生格式）
PREVIEW_MAX_SIDE = 2048
PREFIX_A = "0DAYE_Compare_A"
PREFIX_B = "0DAYE_Compare_B"


def _to_pil(t):
    """[H,W,C] float 0-1 tensor → PIL RGB（4 通道 alpha 贴黑底转 RGB）"""
    arr = np.clip(t.detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
    if arr.shape[2] == 4:
        base = Image.new("RGB", (arr.shape[1], arr.shape[0]), (0, 0, 0))
        base.paste(Image.fromarray(arr, "RGBA"), (0, 0))
        return base
    return Image.fromarray(arr[..., :3], "RGB")


def _downscale(t):
    """[1,H,W,C] 长边超过上限时 GPU bicubic 下采样（预览专用，输出端口不走这里）。"""
    h, w = int(t.shape[1]), int(t.shape[2])
    m = max(h, w)
    if m <= PREVIEW_MAX_SIDE:
        return t
    s = PREVIEW_MAX_SIDE / m
    nh, nw = max(1, round(h * s)), max(1, round(w * s))
    x = t[0].permute(2, 0, 1).unsqueeze(0)
    x = torch.nn.functional.interpolate(x, size=(nh, nw), mode="bicubic", align_corners=False)
    return x.squeeze(0).permute(1, 2, 0).unsqueeze(0).clamp(0, 1).to(t.dtype)


def _png_metadata(pnginfo, prompt, extra_pnginfo):
    """按官方 SaveImage 约定写 PNG tEXt：prompt + extra_pnginfo 各键（workflow 等），可拖回恢复。"""
    if args.disable_metadata:
        return
    if prompt is not None:
        pnginfo.add_text("prompt", json.dumps(prompt))
    if extra_pnginfo is not None:
        for k, v in extra_pnginfo.items():
            pnginfo.add_text(k, json.dumps(v))


def _save_temp_preview(t, prefix, prompt=None, extra_pnginfo=None):
    """batch 第一张 → 预览 PNG（长边>2048 下采样）+ 全分辨率 PNG（含工作流元数据）。

    未触发下采样时两用途共用同一个文件（返回项无 full 子项，前端回退用预览项）；
    触发时预览文件名加 _prev 后缀，全分辨率文件按官方 SaveImage 命名约定带元数据。
    返回官方 /view 惯例项 + orig_*（原始分辨率，前端信息行显示）。
    """
    orig_h, orig_w = int(t.shape[1]), int(t.shape[2])
    small = _downscale(t[:1].contiguous())
    downscaled = int(small.shape[2]) != orig_w or int(small.shape[1]) != orig_h
    pil_small = _to_pil(small[0])
    full_dir, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, folder_paths.get_temp_directory(), orig_w, orig_h)
    full_name = f"{filename}_{counter:05}_.png"
    pnginfo = PngInfo()
    _png_metadata(pnginfo, prompt, extra_pnginfo)
    if downscaled:
        pil_small.save(os.path.join(full_dir, f"{filename}_{counter:05}_prev.png"), "PNG")
        _to_pil(t[0].contiguous()).save(os.path.join(full_dir, full_name), "PNG", pnginfo=pnginfo)
        full_item = {"filename": full_name, "subfolder": subfolder, "type": "temp"}
    else:
        pil_small.save(os.path.join(full_dir, full_name), "PNG", pnginfo=pnginfo)
        full_item = None
    return {
        "filename": f"{filename}_{counter:05}_prev.png" if downscaled else full_name,
        "subfolder": subfolder,
        "type": "temp",
        "orig_width": orig_w,
        "orig_height": orig_h,
        "full": full_item,
    }


def _concat_horizontal(a, b):
    """A|B 左右拼接：以 A 为基准——B 高度缩放到 A 的高度（等比，GPU bicubic）、通道对齐（统一 3 通道 RGB）。"""
    ha, hb = int(a.shape[1]), int(b.shape[1])
    if hb != ha:
        w = int(b.shape[2])
        nw = max(1, round(w * ha / hb))
        x = b[0].permute(2, 0, 1).unsqueeze(0)
        x = torch.nn.functional.interpolate(x, size=(ha, nw), mode="bicubic", align_corners=False)
        b = x.squeeze(0).permute(1, 2, 0).unsqueeze(0).clamp(0, 1).to(b.dtype)
    ca, cb = int(a.shape[3]), int(b.shape[3])
    if ca != 3:
        a = a[..., :3] if ca > 3 else a.repeat(1, 1, 1, 3)  # RGBA→RGB / 灰度→RGB
    if cb != 3:
        b = b[..., :3] if cb > 3 else b.repeat(1, 1, 1, 3)
    return torch.cat([a, b], dim=2)  # W 维拼接


class ImageCompare(io.ComfyNode):
    """图像对比预览：划线跟随 / 按住点击 / 透明度混合三种模式，A/B 可交换，右键复制或保存。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="0DAYE_ImageCompare",
            display_name="Image Compare",
            category="0DAYE",
            description="A/B 图像对比预览：划线跟随 / 按住点击 / 透明度混合，右键菜单可复制到剪贴板或保存图片",
            inputs=[
                io.Image.Input(
                    "image_a",
                    optional=True,  # 两输入均可选：只接一个端口也能预览（单图模式）
                    tooltip="A 图（对比基准，左/底层）；只接这一个就是普通预览器，之后想对比再接 B",
                ),
                io.Image.Input(
                    "image_b",
                    optional=True,
                    tooltip="B 图（对比对象，右/顶层）；只接 B 时预览 B、双输出=B；不接时仅预览 A，拼接输出=A",
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    display_name="image_a",
                    tooltip="A 图原样输出（原始分辨率，不受预览下采样影响；只接 B 时=B）",
                ),
                io.Image.Output(
                    "concat",
                    display_name="concat",
                    tooltip="A|B 左右拼接图（以 A 高度为准等比对齐；B 未接或只接 B 时=A）",
                ),
            ],
            is_output_node=True,  # 纯预览输出节点（无预览之外的副作用）
            hidden=[io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, image_a=None, image_b=None):
        if image_a is None and image_b is None:
            raise RuntimeError("图像对比：请至少接入一张图片（image_a / image_b 任意一个端口）")
        if image_a is None:  # 只接 B：单图模式，B 顶到 A 位（预览与双输出都走 A 通道）
            image_a = image_b
            image_b = None
        hidden = getattr(cls, "hidden", None)
        prompt = getattr(hidden, "prompt", None)
        extra_pnginfo = getattr(hidden, "extra_pnginfo", None)
        ui = {"a_images": [_save_temp_preview(image_a, PREFIX_A, prompt, extra_pnginfo)]}
        concat = image_a
        if image_b is not None:
            ui["b_images"] = [_save_temp_preview(image_b, PREFIX_B, prompt, extra_pnginfo)]
            concat = _concat_horizontal(image_a.contiguous(), image_b.contiguous())
        # 输出原样 tensor（不受预览下采样影响）；ui 只携带预览图信息
        return io.NodeOutput(image_a, concat, ui=ui)
