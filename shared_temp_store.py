# -*- coding: utf-8 -*-
"""
会话级「内容寻址」共享 temp 存储（comfy_0DAYE）

ImageCompare 与 ImageCachePreview（轻量模式）写进 ComfyUI temp 的全分辨率/预览 PNG
统一经本模块落盘：同一批像素 + 相同结构元数据（prompt/workflow）在本会话内只编码一次，
后到者直接复用已有文件绝对路径（跳过 PNG 编码与写盘）。

设计约束（勿改坏）：
- 文件名与目录保持各节点原有命名规则——去重靠内存索引，与文件叫什么名字无关。
- 索引只在进程内存中（会话级）；重启即空，temp 文件由官方启动/关闭 rmtree 清理，
  插件零清理代码（与 image_cache_preview 的轻量模式回收策略一致）。
- 参数串写入文件但不参与去重键：随机 seed 每轮都变，若参与指纹则固定 B 图会每轮重复落盘
  （用户确认：以去重为先；复用文件的参数串可能是上一次的快照）。
"""

import hashlib
import json
import os
import threading

import numpy as np

_LOCK = threading.RLock()
_FILES = {}  # 去重键 -> 文件绝对路径（会话级索引）


def pixel_hash(t):
    """[H,W,C] float 0-1 tensor → uint8 字节 sha1。
    量化口径与各节点 _to_pil（np.clip(x*255,0,255).astype(uint8)）一致，
    保证「同一张图」在不同节点算出同一个哈希。"""
    arr = np.clip(t.detach().float().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
    return hashlib.sha1(arr.tobytes()).hexdigest()


def meta_fingerprint(prompt, extra_pnginfo):
    """结构元数据指纹：prompt + extra_pnginfo（workflow 等）内容的 sha1。
    prompt 相同、工作流不同 → 不同键；两节点在同一工作流里传同一份对象 → 同键（可跨节点复用）。"""
    try:
        blob = json.dumps([prompt, extra_pnginfo], sort_keys=True,
                          default=str, ensure_ascii=False)
    except Exception:  # 极端不可序列化场景：退化为 repr，宁可低命中率也不崩
        blob = repr([prompt, extra_pnginfo])
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def plan(t, meta_fp):
    """查会话索引：返回 (key, 命中路径或 None)；命中路径已校验文件仍存在。"""
    key = f"{pixel_hash(t)}:{meta_fp}"
    with _LOCK:
        path = _FILES.get(key)
    if path and os.path.isfile(path):
        return key, path
    return key, None


def save_shared_png(t, meta_fp, make_path, write_fn):
    """命中则直接返回已有路径（不调 make_path、不调 write_fn）；
    未命中用 make_path() 生成目标路径、write_fn(path) 落盘并登记索引。
    make_path / write_fn 由调用方提供 → 各节点沿用自身命名与编码规则，本模块零侵入。"""
    key, hit = plan(t, meta_fp)
    if hit:
        return hit
    path = make_path()
    write_fn(path)
    with _LOCK:
        _FILES[key] = path
    return path


def forget(path):
    """文件被删除/覆盖后摘除索引，避免后续命中指向失效路径。"""
    with _LOCK:
        for k, v in list(_FILES.items()):
            if v == path:
                _FILES.pop(k, None)
