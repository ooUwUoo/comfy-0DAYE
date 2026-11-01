# -*- coding: utf-8 -*-
"""
图像缓存预览节点（ImageCachePreview）—— comfy_0DAYE

用途：
  在原生预览节点基础上增加历史缓存：每张流经本节点的图自动留档，节点内大图下方
  一行缩略图可回看，点缩略图切大图，支持翻页/上一张/下一张/清空，新图默认显示最新。
  image 输出端口原样透传（原始分辨率），可插在采样器与保存节点之间的链路任意位置。

两级容量（关键设计，勿改坏）：
  ① 抽屉层（drawers）：每个 history_key 一份索引，最多 HISTORY_MAX(50) 条，只存 gid
     与尺寸等轻量信息——多个节点/多个工作流各自独立，索引总和再大也只占几十 KB。
  ② 文件池层（groups）：全部节点的图片文件统一放在 user/0DAYE/image_cache/，
     全局硬顶 POOL_MAX(300) 组（每组 = 一张大图 + 一张小图），超出按 LRU 淘汰最旧的
     并自动从所有抽屉索引里摘除该 gid。
  两层解耦的意义：无论用户建多少个预览节点、存多少个工作流，磁盘占用都由 300 组
  封顶，不会随节点数乘法膨胀（曾评估过「每节点各自 50 张」方案，20 工作流 × 5 节点
  = 5000 张大图，不可接受）。

  抽屉被清空/裁剪只影响索引，不删文件（文件是全局池共用资源，可能还被别的抽屉引用），
  文件只在池超限淘汰时删除。

存储（均在 user/0DAYE/，插件更新/重装/重启都不丢）：
  image_cache/{gid}_p.{png|jpg}  大图，长边 > PREVIEW_MAX_SIDE 时等比缩小（节点内显示用）；
                                 嵌 CivitAI/A1111 参数串（JPG→EXIF UserComment，PNG→tEXt
                                 parameters 块），轻量模式下右键保存的就是它，C 站照样可读
  image_cache/{gid}_t.{png|jpg}  小图，长边 > THUMB_MAX_SIDE 时等比缩小（缩略图条用；不嵌元数据）
  image_cache/{gid}_f.png        全分辨率 PNG，内嵌 prompt/workflow/CivitAI 参数串
                                 （store_full_image=完整模式才存；右键「保存图像」用，
                                 可拖回 ComfyUI 恢复工作流；轻量模式无此文件，info 无 "f" 标记）
  image_cache_history.json       {"groups": {gid: {w,h,e,f?}}, "drawers": {key: [gid...]}}
  大图/小图编码按有无 alpha 分流：RGBA 存 PNG（保留透明），RGB 存 JPEG q92
  （节点内显示用，体积省 4/5）；全分辨率文件恒为 PNG（需嵌 tEXt 元数据）。
  磁盘仍由 POOL_MAX 硬顶控制；完整模式下全分辨率 PNG 是单组体积大头（用户明确要求右键存原图），
  轻量模式单组降到几十 KB。参数串生成复用 save_image_metadata 的 _extract_info+build_parameters
  （自动追溯上游采样器/提示词/模型/LoRA 哈希），失败仅告警不阻断缓存。

前端消费（web/image_cache.js）：
  execute 的 ui.items = [{id, w, h, f?}, ...]（当前抽屉全量，最新在前）驱动面板刷新；
  图片经本文件末尾的自定义路由 /comfy_0DAYE/image_cache/view?id=&kind= 读取
  （不走官方 /view：官方只认 output/temp/input，读不到 user 目录）。
"""

import json
import os
import random
import re
import threading
import time

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths
from cli_args import args
from comfy_api.latest import io

# 复用保存元数据节点的 CivitAI 参数串管线（同包模块；测试环境无包上下文时回退绝对导入）
try:
    from .save_image_metadata import _extract_info, build_parameters, _user_comment_bytes
except ImportError:  # pragma: no cover
    from save_image_metadata import _extract_info, build_parameters, _user_comment_bytes

POOL_MAX = 300          # 全局图片池上限（组）；超出按 LRU 淘汰最旧
HISTORY_MAX = 50        # 每个抽屉（节点）最多保留的条目数
PREVIEW_MAX_SIDE = 1024  # 大图长边上限（节点内显示足够清晰，体积可控）
THUMB_MAX_SIDE = 160     # 小图长边上限（前端缩略图显示 56px，兼顾高清屏）
JPEG_QUALITY = 92

# 用户私有数据目录：ComfyUI/user/0DAYE/（插件更新/重装不丢，也不入 git）
USER_DATA_DIR = os.path.join(folder_paths.base_path, "user", "0DAYE")
CACHE_DIR = os.path.join(USER_DATA_DIR, "image_cache")
_INDEX_FILE = os.path.join(USER_DATA_DIR, "image_cache_history.json")

# gid = 毫秒时间戳 + 随机数，前端直接用来拼 URL；只允许字母数字下划线（防路径穿越）
_VALID_GID = re.compile(r"^[0-9A-Za-z_]+$")

_LOCK = threading.RLock()


def _load_index():
    """启动时恢复索引；文件缺失/损坏/条目异常一律跳过（不影响节点运行）。
    同时校验文件是否真的存在（用户可能手动清过 image_cache 目录），缺文件的组直接丢弃。"""
    try:
        with open(_INDEX_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return {"groups": {}, "drawers": {}}
    if not isinstance(raw, dict):
        return {"groups": {}, "drawers": {}}

    groups = {}
    raw_groups = raw.get("groups")
    if isinstance(raw_groups, dict):
        for gid, info in raw_groups.items():
            if not isinstance(gid, str) or not _VALID_GID.match(gid):
                continue
            if not isinstance(info, dict):
                continue
            w, h, e = info.get("w"), info.get("h"), info.get("e")
            if not isinstance(w, int) or not isinstance(h, int) or w < 1 or h < 1:
                continue
            e = e if e in ("png", "jpg") else "jpg"
            # 大图/小图必须都在（缺一即整组丢弃，避免前端裂图）；全分辨率文件可选：
            # 轻量模式（store_full_image=False）存的组本就没有 _f，以 f 标记记录
            if not (os.path.isfile(_group_path(gid, e, "preview"))
                    and os.path.isfile(_group_path(gid, e, "thumb"))):
                continue
            groups[gid] = {"w": w, "h": h, "e": e}
            if os.path.isfile(_group_path(gid, e, "full")):
                groups[gid]["f"] = 1

    drawers = {}
    raw_drawers = raw.get("drawers")
    if isinstance(raw_drawers, dict):
        for k, arr in raw_drawers.items():
            try:
                key = int(k)
            except (TypeError, ValueError):
                continue
            if key < 0 or not isinstance(arr, list):
                continue
            ids = [gid for gid in arr if isinstance(gid, str) and gid in groups][:HISTORY_MAX]
            if ids:
                drawers[key] = ids

    return {"groups": groups, "drawers": drawers}


def _group_path(gid, ext, kind):
    """kind: preview=大图(_p) / thumb=小图(_t) / full=全分辨率PNG(_f，带工作流元数据，右键保存用)。"""
    suffix = {"preview": "_p", "thumb": "_t", "full": "_f"}[kind]
    ext = "png" if kind == "full" else ext  # 全分辨率文件恒为 PNG（需嵌 tEXt 元数据）
    return os.path.join(CACHE_DIR, f"{gid}{suffix}.{ext}")


# 模块级索引：启动时从磁盘恢复，每次新增/清空落盘
_INDEX = _load_index()


def _save_index():
    """原子写盘（先 tmp 后替换，防写一半损坏）；写失败仅告警，不影响执行。"""
    data = {
        "groups": {gid: info for gid, info in _INDEX["groups"].items() if info},
        "drawers": {str(k): v for k, v in _INDEX["drawers"].items() if v},
    }
    try:
        os.makedirs(USER_DATA_DIR, exist_ok=True)
        tmp = _INDEX_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, _INDEX_FILE)
    except Exception as e:
        print(f"[ImageCache] 警告：索引写盘失败：{e}")


def _norm_key(key):
    """history_key 兜底：-1/非法值归 0 号抽屉（与 TextCacheWithHistory 同一约定）。"""
    try:
        key = int(key)
    except (TypeError, ValueError):
        key = 0
    return 0 if key < 0 else key


def _to_pil(t):
    """[H,W,C] float 0-1 tensor → PIL（4 通道保留 RGBA 以便透明图存 PNG，其余统一 RGB）。
    float() 先兜底：半精度/bfloat16 张量直接转 numpy 会出错。"""
    arr = np.clip(t.detach().float().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        arr = arr[..., None]
    c = arr.shape[2]
    if c == 4:
        return Image.fromarray(arr, "RGBA")
    if c == 1:
        return Image.fromarray(arr[..., 0], "L").convert("RGB")
    return Image.fromarray(arr[..., :3], "RGB")


def _fit(pil, max_side):
    """长边超过上限时等比缩小；未超限原样返回。
    大比例缩小时 reducing_gap 会先做多级预缩，比直接 LANCZOS 快一个量级，画质差异对预览无感。"""
    w, h = pil.size
    m = max(w, h)
    if m <= max_side:
        return pil
    s = max_side / m
    size = (max(1, round(w * s)), max(1, round(h * s)))
    return pil.resize(size, Image.LANCZOS, reducing_gap=2.0)


def _png_metadata(pnginfo, prompt, extra_pnginfo, parameters=None):
    """按官方 SaveImage 约定写 PNG tEXt：prompt + extra_pnginfo 各键（workflow 等），可拖回恢复；
    parameters 非空时附带 A1111 参数串（CivitAI 读 PNG 的读取点）。"""
    if args.disable_metadata:
        return
    if parameters:
        pnginfo.add_text("parameters", parameters)
    if prompt is not None:
        pnginfo.add_text("prompt", json.dumps(prompt))
    if extra_pnginfo is not None:
        for k, v in extra_pnginfo.items():
            pnginfo.add_text(k, json.dumps(v))


def _jpeg_exif(parameters):
    """JPEG 的 CivitAI 读取点：EXIF UserComment=A1111 参数串（与保存元数据节点同约定）。
    UserComment 必须写进 EXIF 子 IFD（0x8769）——直接 exif[0x9286] 会落根 IFD，
    部分解析器按规范只读子 IFD（2026-10-24 Pillow 实测）。
    EXIF 单段 ~64KB 限制，故只嵌参数串不嵌工作流。"""
    if args.disable_metadata or not parameters:
        return None
    exif = Image.Exif()
    exif.get_ifd(0x8769)[0x9286] = _user_comment_bytes(parameters)  # EXIF-IFD.UserComment
    return exif


def _save_group(t, prompt=None, extra_pnginfo=None, parameters=None, store_full=True):
    """单张图落盘为一组文件，返回 (gid, info)；失败返回 (None, None)。
    {gid}_p: 大图（≤1024，节点内显示；嵌 CivitAI 参数串——JPG 走 EXIF UserComment / PNG 走 tEXt）
    {gid}_t: 小图（≤160，缩略图条；不嵌元数据）
    {gid}_f: 全分辨率 PNG 带工作流元数据（store_full=True 才存；右键「保存图像」用，可拖回恢复）
    info 带 "f"=1 标记表示本组有全分辨率文件（轻量模式下没有，前端保存时降级用预览图）。"""
    try:
        pil = _to_pil(t)
        orig_w, orig_h = pil.size
        prev = _fit(pil, PREVIEW_MAX_SIDE)
        thumb = _fit(prev, THUMB_MAX_SIDE)
        ext = "png" if prev.mode == "RGBA" else "jpg"
        gid = f"{int(time.time() * 1000)}{random.randrange(10 ** 6):06d}"
        os.makedirs(CACHE_DIR, exist_ok=True)
        if ext == "png":
            pi = PngInfo()
            if not args.disable_metadata and parameters:
                pi.add_text("parameters", parameters)
            prev.save(_group_path(gid, ext, "preview"), "PNG", pnginfo=pi)
            thumb.save(_group_path(gid, ext, "thumb"), "PNG")
        else:
            # exif 为 None（无参数串/disable_metadata）时不要传 exif 参数——
            # 部分 Pillow 版本对 exif=None 会走 len(exif) 路径直接抛 TypeError
            exif = _jpeg_exif(parameters)
            kw = {"quality": JPEG_QUALITY}
            if exif is not None:
                kw["exif"] = exif
            prev.save(_group_path(gid, ext, "preview"), "JPEG", **kw)
            thumb.save(_group_path(gid, ext, "thumb"), "JPEG", quality=JPEG_QUALITY)
        info = {"w": orig_w, "h": orig_h, "e": ext}
        if store_full:
            pnginfo = PngInfo()
            _png_metadata(pnginfo, prompt, extra_pnginfo, parameters)
            pil.save(_group_path(gid, ext, "full"), "PNG", pnginfo=pnginfo)
            info["f"] = 1
        return gid, info
    except Exception as e:
        print(f"[ImageCache] 警告：图片缓存落盘失败：{e}")
        return None, None


def _drop_group(gid):
    """淘汰一组：删三个文件 + 摘除所有抽屉里的引用（调用方须持 _LOCK）。"""
    info = _INDEX["groups"].pop(gid, None)
    if not info:
        return
    for kind in ("preview", "thumb", "full"):
        try:
            os.remove(_group_path(gid, info.get("e", "jpg"), kind))
        except OSError:
            pass
    for arr in _INDEX["drawers"].values():
        while gid in arr:
            arr.remove(gid)


def _prune_pool():
    """全局池超限时按插入顺序（最旧在前）淘汰（调用方须持 _LOCK）。"""
    groups = _INDEX["groups"]
    while len(groups) > POOL_MAX:
        _drop_group(next(iter(groups)))


def drawer_items(key):
    """只读：某抽屉的条目清单（最新在前），供前端面板在加载工作流/重启后恢复显示。
    条目 {id, w, h, f}——f=1 表示有全分辨率文件（右键保存原图），无则保存降级用预览图。"""
    key = _norm_key(key)
    with _LOCK:
        ids = _INDEX["drawers"].get(key) or []
        out = []
        for gid in ids:
            info = _INDEX["groups"].get(gid)
            if info:
                it = {"id": gid, "w": info["w"], "h": info["h"]}
                if info.get("f"):
                    it["f"] = 1
                out.append(it)
        return out


def clear_drawer(key):
    """清空某抽屉索引（内存+磁盘同步）。不删图片文件——文件是全局池共用资源，
    可能还被别的抽屉引用，只在池超限淘汰时自然释放。返回是否有内容被清。"""
    key = _norm_key(key)
    with _LOCK:
        existed = bool(_INDEX["drawers"].get(key))
        _INDEX["drawers"].pop(key, None)
        _save_index()
        return existed


def group_file(gid, kind):
    """只读：取某组的文件绝对路径（不存在/非法 gid 返回 None），供 view 路由用。
    kind: preview（默认）/ thumb / full（全分辨率 PNG，右键保存用）。"""
    if not isinstance(gid, str) or not _VALID_GID.match(gid):
        return None
    if kind not in ("preview", "thumb", "full"):
        kind = "preview"
    with _LOCK:
        info = _INDEX["groups"].get(gid)
        if not info:
            return None
        path = _group_path(gid, info.get("e", "jpg"), kind)
    return path if os.path.isfile(path) else None


def _win_reveal(path):
    """Windows：资源管理器打开父目录并选中文件。返回 None=成功，否则错误字符串。

    不用 `explorer /select,"路径"` 命令行方式：subprocess 传参时该写法常被 explorer
    解析失败，只打开默认文件夹（桌面/文档），不定位目标（2026-10-26 实测）。
    改用 Shell API SHOpenFolderAndSelectItems，无解析歧义，路径含空格也可靠。"""
    import ctypes
    from ctypes import wintypes

    shell32 = ctypes.windll.shell32
    ole32 = ctypes.windll.ole32
    shell32.SHParseDisplayName.argtypes = [
        wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        wintypes.DWORD, ctypes.POINTER(wintypes.ULONG)]
    shell32.SHOpenFolderAndSelectItems.argtypes = [
        ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD]
    shell32.ILFree.argtypes = [ctypes.c_void_p]

    hr_init = ole32.CoInitialize(None)  # SHOpenFolderAndSelectItems 要求 COM 已初始化
    pidl_dir = ctypes.c_void_p()
    pidl_item = ctypes.c_void_p()
    try:
        if shell32.SHParseDisplayName(os.path.dirname(path), None,
                                      ctypes.byref(pidl_dir), 0, None) != 0:
            return "无法解析目录路径"
        if shell32.SHParseDisplayName(path, None,
                                      ctypes.byref(pidl_item), 0, None) != 0:
            return "无法解析文件路径"
        items = (ctypes.c_void_p * 1)(pidl_item)
        if shell32.SHOpenFolderAndSelectItems(pidl_dir, 1, items, 0) != 0:
            return "资源管理器定位失败"
        return None
    finally:
        if pidl_dir:
            shell32.ILFree(pidl_dir)
        if pidl_item:
            shell32.ILFree(pidl_item)
        if hr_init in (0, 1):  # S_OK / S_FALSE → 配对 CoUninitialize
            ole32.CoUninitialize()


def reveal_group(gid, kind):
    """在系统文件管理器中定位并选中某组缓存文件（右键菜单「打开图片路径」）。
    复用 group_file 的 gid 校验与存在性检查，路径必在缓存目录内，无穿越风险。
    返回 (ok, error_or_path)。"""
    path = group_file(gid, kind)
    if not path:
        return False, "not_found"
    if os.name == "nt":
        err = _win_reveal(path)
        if err is not None:
            # Shell API 失败 → 回退命令行（字符串形式传参，等同 Win+R 里输入的写法）
            try:
                import subprocess
                subprocess.Popen('explorer /select,"{}"'.format(path))
            except Exception as e:
                return False, f"{err}; {e}"
        return True, path
    try:
        import subprocess
        import sys
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", path], timeout=10, check=True)
        else:  # Linux 等：没有通用「选中文件」，退化为打开所在目录
            subprocess.run(["xdg-open", os.path.dirname(path)], timeout=10, check=True)
    except Exception as e:
        return False, str(e)
    return True, path


class ImageCachePreview(io.ComfyNode):
    """图像缓存预览：大图 + 历史缩略图条（翻页自适应节点宽度），image 原样透传。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="0DAYE_ImageCachePreview",
            display_name="Image Cache Preview",
            category="0DAYE",
            description=(
                "图像缓存预览：每张流经的图自动留档，大图下方缩略图条可回看翻页"
                "（页容量随节点宽度自适应），点小图切大图，可上一张/下一张/清空；"
                "image 原样透传（原始分辨率）"
            ),
            inputs=[
                io.Image.Input(
                    "image",
                    tooltip="待预览的图片；流经本节点时自动写入历史缓存，原图直通输出端口",
                ),
                io.Int.Input(
                    "history_key",
                    default=-1,
                    min=-1,
                    max=999999,
                    advanced=True,
                    tooltip=(
                        "-1=自动：前端在节点创建时写入当前节点实例编号，每个节点历史互相独立；"
                        "填相同数字则多个节点共享同一份历史"
                    ),
                ),
                io.Boolean.Input(
                    "store_full_image",
                    default=True,
                    advanced=True,
                    tooltip=(
                        "完整模式（默认开）：每组多存一份全分辨率 PNG（内嵌 prompt/workflow/"
                        "CivitAI 参数串），右键保存得到原图带数据；关闭=轻量模式：只存 1024px "
                        "预览图（也带 CivitAI 参数串），右键保存退化为预览图，单组体积降到几十 KB"
                    ),
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    display_name="image",
                    tooltip="原样透传输入图（原始分辨率，不受缓存缩图影响）",
                ),
            ],
            # 全分辨率 PNG 需嵌 prompt/workflow 元数据（右键保存可拖回恢复工作流）；
            # unique_id 供 CivitAI 参数串从本节点起精准追溯上游采样器/提示词
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo, io.Hidden.unique_id],
            is_output_node=True,  # 即使输出端口未连线也要执行（流经即记录）
        )

    @classmethod
    def execute(cls, image, history_key=-1, store_full_image=True):
        key = _norm_key(history_key)
        hidden = getattr(cls, "hidden", None)
        prompt = getattr(hidden, "prompt", None)
        extra_pnginfo = getattr(hidden, "extra_pnginfo", None)
        unique_id = getattr(hidden, "unique_id", None)
        n = int(image.shape[0])
        # CivitAI/A1111 参数串：同一批执行只提取一次（含模型/LoRA 哈希，有大文件 IO）。
        # 失败不致命——空串时仅不嵌参数串，图片照常缓存。
        parameters = ""
        try:
            h, w = int(image.shape[1]), int(image.shape[2])
            parameters = build_parameters(
                _extract_info(prompt, unique_id, w, h, with_hash=True))
        except Exception as e:
            print(f"[ImageCache] 警告：CivitAI 参数串生成失败（不影响缓存）：{e}")
        new_ids = []
        new_infos = {}
        # batch 内按原顺序记录：第一张放抽屉最前（=「最新」位，前端默认显示这张）
        for i in range(n):
            gid, info = _save_group(image[i].contiguous(), prompt, extra_pnginfo,
                                    parameters, store_full=bool(store_full_image))
            if gid:
                new_ids.append(gid)
                new_infos[gid] = info
        with _LOCK:
            for gid, info in new_infos.items():
                _INDEX["groups"][gid] = info
            if new_ids:
                drawer = _INDEX["drawers"].setdefault(key, [])
                drawer[0:0] = new_ids
                del drawer[HISTORY_MAX:]
            _prune_pool()
            if new_ids:
                _save_index()
            items = drawer_items(key)
        # ui.items 必须是列表：后端会把每个 ui 值当可迭代对象展开成 output 数组
        return io.NodeOutput(image, ui={"items": items})
