# -*- coding: utf-8 -*-
"""
会话级「内容寻址」共享存储（comfy_0DAYE）

ImageCompare 与 ImageCachePreview（轻量模式 temp 原图 + 完整模式永久原图）落盘的
全分辨率/预览 PNG 统一经本模块：同一批像素在本会话内只编码一次；命中时后到者以
NTFS 硬链接（os.link）在自己命名规则下零拷贝落地——各节点文件名/目录形式完全不变，
磁盘物理只占一份（2026-11-05 起，替代此前的路径复用）。

设计约束（勿改坏）：
- 硬链接语义：每个消费者拥有自己的目录项，删除任一方只摘除该目录项，数据随最后一个
  链接消失才释放。temp 链接由官方启动/关闭 rmtree 清理；完整模式 user 链接独立存活
  （temp 清空后数据由 user 链接继续持有，归档不受影响）。
- 索引只在进程内存中（会话级）；重启即空。命中源已 isfile 校验，失效自动降级为重新落盘。
- 去重键 = 纯像素哈希（2026-11-05 用户批准「方案 A」）。曾用「像素哈希 + workflow 指纹」，
  实测失效：前端工作流图每轮出队都在变（画布视口 extra.ds、cg-use-everywhere 虚拟链接
  ID 递增、randomize seed 出队后自动回写 widget 值），跨运行指纹永不命中 → 固定图每轮
  重复落盘。代价：复用文件内嵌的 prompt/workflow/参数串是首次落盘快照（用户知情接受，
  参数串快照此前 2026-11-04 已单独确认过）。
- 参数串写入文件但不参与去重键。
- os.link 需同卷 NTFS；失败（跨卷/权限/FAT32）自动回退为普通编码写盘，行为与旧版一致。
"""

import hashlib
import os
import threading

import numpy as np

_LOCK = threading.RLock()
_FILES = {}  # 去重键（像素哈希）-> 首个落盘文件绝对路径（硬链接源；会话级索引）


def pixel_hash(t):
    """[H,W,C] float 0-1 tensor → uint8 字节 sha1。
    量化口径与各节点 _to_pil/_to_pil_full（np.clip(x*255,0,255).astype(uint8)）一致，
    保证「同一张图」在不同节点算出同一个哈希。"""
    arr = np.clip(t.detach().float().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
    return hashlib.sha1(arr.tobytes()).hexdigest()


def plan(t):
    """查会话索引：返回 (key, 命中路径或 None)；命中路径已校验文件仍存在。"""
    key = pixel_hash(t)
    with _LOCK:
        path = _FILES.get(key)
    if path and os.path.isfile(path):
        return key, path
    return key, None


def save_shared_png(t, make_path, write_fn):
    """统一落盘入口，返回 (实际路径, 是否命中复用)。

    命中：在 make_path() 处创建指向已存文件的硬链接（零拷贝，调用方命名/目录不变）；
    链接失败（跨卷/权限/FAT32）或未命中：write_fn(path) 正常编码落盘并登记索引。
    make_path / write_fn 由调用方提供 → 各节点沿用自身命名与编码规则，本模块零侵入。
    """
    key, hit = plan(t)
    path = make_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if hit:
        if os.path.abspath(hit) == os.path.abspath(path):
            return path, True
        try:
            os.link(hit, path)
            with _LOCK:
                # 索引改指最新链接：缓存池 LRU 先淘汰旧组，新链接存活概率最高，
                # 避免「索引指向刚被淘汰的文件 → 后续命中源失效空转」
                _FILES[key] = path
            return path, True
        except OSError:
            pass  # 硬链接不可用：回退普通写盘（行为与旧版一致）
    write_fn(path)
    with _LOCK:
        _FILES[key] = path
    return path, False


def forget(path):
    """文件被删除/覆盖后摘除索引，避免后续命中指向失效路径。"""
    with _LOCK:
        for k, v in list(_FILES.items()):
            if v == path:
                _FILES.pop(k, None)
