# -*- coding: utf-8 -*-
"""
Save Image MetaData —— 简洁版 CivitAI 兼容元数据保存节点 —— comfy_0DAYE

参考 ComfyUI_SaveImageWithMetaDataUniversal / comfyui-cyberdelia-metadata 的精简实现：
只保留核心链路，不引入规则扫描器 / 环境变量 / JPEG 分级回退等重型机制。

元数据提取（全自动，静态读 hidden prompt 图，无需手动接线）：
  1. 从本节点出发 BFS 上游，找最近的「采样器」节点（特征：有 positive/negative + cfg + seed/noise_seed 输入，
     覆盖 KSampler / KSamplerAdvanced / SamplerCustom 及同名封包装）。
  2. seed/steps/cfg/sampler_name/scheduler/denoise 直接读控件值；遇到连线则沿同名输入跟进
     （覆盖 Seed 节点、KSamplerSelect、BasicScheduler 等拆分式接法）。
  3. 正/负提示词：从采样器 positive/negative 链接找文本编码节点读 text 控件；
     经 FluxGuidance 等「结构节点」可再深入一层。文本由连线运行时生成（LLM 链）时静态读不到，
     请改用 positive_text / negative_text 端口手动接线（优先级最高）。
  4. 模型/LoRA：在采样器上游扫 ckpt_name / unet_name / lora_name 控件；
     模型哈希 = sha256 前 10 位（AutoV2），结果写入 <模型文件>.sha256 边车缓存，只算一次。

CivitAI 兼容写法（A1111 格式参数串）：
  - PNG：tEXt 块 parameters=参数串；「完整」模式再嵌 prompt/workflow JSON（可拖回 ComfyUI 恢复工作流）。
  - JPEG：EXIF UserComment=参数串（CivitAI 读取点；EXIF 单段 ~64KB 限制，故不嵌工作流）。
  - LoRA 以 <lora:名称:权重> 内联标签附在正面提示词后（CivitAI 解析点），另有 Lora hashes 字段。

已知边界（设计取舍，非 bug）：
  - LLM/文本缓存等运行时生成的提示词静态追溯不到 → 用 positive_text/negative_text 手动接线。
  - 一个工作流有多条独立采样流水线时，取「离本节点最近」的采样器。
  - 模型哈希首次计算需读完整模型文件（数秒），之后命中 .sha256 边车缓存。
"""

import hashlib
import json
import os
import re
from collections import deque

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths
from comfy.cli_args import args
from comfy_api.latest import io

# ---------------------------------------------------------------------------
# 静态图追溯工具（全部只读 hidden prompt 字典，不触发任何执行）
# ---------------------------------------------------------------------------

# ComfyUI 采样器名 → A1111/CivitAI 显示名（未收录的按 "下划线转空格" 兜底）
_SAMPLER_NAME_MAP = {
    "euler": "Euler", "euler_ancestral": "Euler a",
    "heun": "Heun", "heunpp2": "Heun++ 2S",
    "dpm_2": "DPM2", "dpm_2_ancestral": "DPM2 a",
    "lms": "LMS", "dpm_fast": "DPM fast", "dpm_adaptive": "DPM adaptive",
    "dpmpp_2s_ancestral": "DPM++ 2S a", "dpmpp_sde": "DPM++ SDE",
    "dpmpp_2m": "DPM++ 2M", "dpmpp_2m_sde": "DPM++ 2M SDE",
    "dpmpp_3m_sde": "DPM++ 3M SDE",
    "ddim": "DDIM", "ddpm": "DDPM", "uni_pc": "UniPC", "uni_pc_bh2": "UniPC",
    "lcm": "LCM", "restart": "Restart",
}

# 读取提示词文本时认的控件名（按优先级）
_TEXT_WIDGET_KEYS = ("text", "prompt", "positive", "negative", "text_g", "text_l", "wildcard_text", "caption")
# 允许再深入一层的「结构性」链接名（如 FluxGuidance.conditioning → CLIPTextEncode）；
# 不含 text/prompt：沿文本链接追进去读到的是上游 LLM 的输入控件（错误内容），不如留空
_STRUCT_TEXT_KEYS = ("conditioning", "positive", "negative")

# 采样器参数可藏在次级节点里（KSamplerSelect / BasicScheduler / CFGGuider 等），沿这些链接跟进
_STRUCT_PARAM_KEYS = ("sampler", "scheduler", "sigmas", "guider")


def _is_link(v, prompt):
    """判断 prompt 里的输入值是否为链接 [node_id, slot]。
    必须与节点 id 表比对：列表型控件值（尺寸对、lora 堆栈等）会被误判。"""
    return (
        isinstance(v, (list, tuple))
        and len(v) == 2
        and isinstance(v[1], int)
        and str(v[0]) in prompt
    )


def _bfs_upstream(prompt, start_ids, limit=500):
    """从 start_ids 沿链接广度优先向上游走，返回访问到的节点 id（近→远）。"""
    order, seen = [], set()
    dq = deque(str(s) for s in start_ids if s is not None)
    while dq and len(order) < limit:
        nid = dq.popleft()
        if nid in seen or nid not in prompt:
            continue
        seen.add(nid)
        order.append(nid)
        node = prompt.get(nid)
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        for v in inputs.values():
            if _is_link(v, prompt):
                dq.append(str(v[0]))
    return order


def _is_sampler_node(node):
    inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
    return (
        ("positive" in inputs or "negative" in inputs)
        and "cfg" in inputs
        and ("seed" in inputs or "noise_seed" in inputs)
    )


def _resolve_widget(prompt, node_id, names, _depth=0, _seen=None):
    """解析某个数值控件：先查本节点同名输入；是链接则跟进（Seed 节点、KSamplerSelect、
    BasicScheduler 等拆分接法），跟进目标上没有同名控件时兜底读通用 value 控件。"""
    if _seen is None:
        _seen = set()
    if node_id in _seen or _depth > 5:
        return None
    _seen.add(node_id)
    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs", {})
    for name in names:
        if name not in inputs:
            continue
        v = inputs[name]
        if _is_link(v, prompt):
            r = _resolve_widget(prompt, str(v[0]), names, _depth + 1, _seen)
            if r is not None:
                return r
        else:
            return v
    if _depth > 0:
        v = inputs.get("value")  # Primitive/常量节点
        if v is not None and not _is_link(v, prompt):
            return v
    for key in _STRUCT_PARAM_KEYS:
        v = inputs.get(key)
        if _is_link(v, prompt):
            r = _resolve_widget(prompt, str(v[0]), names, _depth + 1, _seen)
            if r is not None:
                return r
    return None


def _resolve_text(prompt, node_id, hop=0):
    """从文本编码节点取提示词文本。只沿结构性链接（conditioning/positive/negative）
    深入一层；沿 text/prompt 链接追进去通常是运行时生成文本（LLM 链），读到的是错误控件，不如留空。"""
    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return ""
    inputs = node.get("inputs", {})
    if node.get("class_type") == "TextCacheWithHistory":
        # 本插件的文本缓存节点：输出是运行时生成的，静态只有 override_text（用户冻结的文本）可读
        v = inputs.get("override_text")
        return v if isinstance(v, str) else ""
    if node.get("class_type") == "ConditioningZeroOut":
        # 负面被清零节点：条件为空，文本应为空串而不是继续追上游
        return ""
    for k in _TEXT_WIDGET_KEYS:
        v = inputs.get(k)
        if isinstance(v, str) and v.strip():
            return v
    if hop >= 1:
        return ""
    for k in _STRUCT_TEXT_KEYS:
        v = inputs.get(k)
        if _is_link(v, prompt):
            r = _resolve_text(prompt, str(v[0]), hop + 1)
            if r:
                return r
    # 文本载体链接（text/prompt…）只允许通往已知的文本缓存类节点：其 override_text 是
    # 用户冻结的文本（权威）；其它运行时生成文本的节点（LLM 等）静态读到的是错误控件，不跟
    for k in ("text", "prompt", "text_g", "text_l"):
        v = inputs.get(k)
        if _is_link(v, prompt):
            t = prompt.get(str(v[0]))
            if isinstance(t, dict) and t.get("class_type") == "TextCacheWithHistory":
                ov = t.get("inputs", {}).get("override_text")
                return ov if isinstance(ov, str) else ""
    return ""


def _model_chain(prompt, start_link, limit=50):
    """沿 "model" 链接从采样器逐级向上走（LoraLoader → … → CheckpointLoader 是线性链），
    返回链上节点 id（近→远）。比 BFS 准确：LoRA 链顺序 = 应用顺序的倒序。"""
    chain, v = [], start_link
    while _is_link(v, prompt) and len(chain) < limit:
        nid = str(v[0])
        chain.append(nid)
        node = prompt.get(nid)
        v = (node.get("inputs", {}) if isinstance(node, dict) else {}).get("model")
    return chain


def _scan_models(prompt, sampler_id, fallback_order):
    """找主模型与 LoRA。返回 (模型文件名, 模型目录类型, [(lora名, sm, sc)]，按应用顺序)。
    优先沿采样器 model 链走；找不到采样器时退回 BFS 顺序扫描。"""
    model_name, model_kind = None, None
    loras = []
    chain = []
    if sampler_id is not None:
        s_inputs = prompt[sampler_id].get("inputs", {})
        chain = _model_chain(prompt, s_inputs.get("model"))
    scan = chain if chain else fallback_order
    for nid in scan:
        node = prompt.get(nid)
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        ln = inputs.get("lora_name")
        if isinstance(ln, str) and ln:
            loras.append((ln, inputs.get("strength_model"), inputs.get("strength_clip")))
        if model_name is None:
            for key, kind in (("ckpt_name", ("checkpoints",)),
                              ("unet_name", ("diffusion_models", "unet"))):
                v = inputs.get(key)
                if isinstance(v, str) and v:
                    model_name, model_kind = v, kind
                    break
    if chain:
        loras.reverse()  # 链是近→远（应用倒序）→ 反转为加载器→采样器的应用顺序
    return model_name, model_kind, loras


def _find_model_path(filename, kinds):
    for kind in kinds:
        try:
            p = folder_paths.get_full_path(kind, filename)
        except Exception:
            p = None
        if p:
            return p
    return None


def _sha256_10(path):
    """模型文件 sha256 前 10 位（AutoV2，CivitAI 识别用）。
    结果写 <文件>.sha256 边车缓存（与 Universal 版同约定），只算一次；失败静默返回 None。"""
    cache = path + ".sha256"
    try:
        if os.path.isfile(cache):
            with open(cache, "r", encoding="utf-8", errors="ignore") as f:
                token = f.read().strip().split()
            if token and len(token[0]) >= 10:
                return token[0][:10]
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        digest = h.hexdigest()
        try:
            with open(cache, "w", encoding="utf-8") as f:
                f.write(digest)
        except OSError:
            pass
        return digest[:10]
    except OSError:
        return None


def _fmt_num(v):
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _sampler_display(name, scheduler):
    disp = _SAMPLER_NAME_MAP.get(str(name), str(name).replace("_", " "))
    if scheduler == "karras":
        disp += " Karras"
    elif scheduler == "exponential":
        disp += " Exponential"
    return disp


def _parse_lora_override(text, with_hash=True):
    """解析手动 LoRA 覆盖串 → [(显示名, 权重, hash10或None)]。
    每项支持三种写法：<lora:名称:权重> / 名称:权重 / 名称（权重省略记 1.0）；
    分隔符：换行或逗号。名称可含子目录（取 basename 显示，原样用于查文件算哈希）。"""
    items = []
    for token in re.split(r"[\n,]+", text):
        token = token.strip().strip("<>").strip()
        if not token:
            continue
        if token.lower().startswith("lora:"):
            token = token[len("lora:"):].strip()
        name, weight = token, 1.0
        if ":" in token:
            head, _, tail = token.rpartition(":")
            try:
                weight, name = round(float(tail), 6), head.strip()
            except ValueError:
                name = token  # 末尾不是数字（如路径含冒号）→ 整串当名称
        if not name:
            continue
        base = os.path.splitext(os.path.basename(name))[0]
        hash10 = None
        if with_hash:
            path = _find_model_path(name, ("loras",))
            if path:
                hash10 = _sha256_10(path)
        items.append((base, weight, hash10))
    return items


def _extract_info(prompt, unique_id, width, height, with_hash=True, sampler_override=None):
    """汇总全部自动提取结果。prompt 为空（异常场景）时只剩尺寸。
    with_hash=False 时跳过模型哈希（仅为文件名占位符解析的场景省一次大文件 IO）。
    sampler_override 非空时指定采样器节点 ID（手动兜底），不再走 BFS 自动识别。"""
    info = {
        "positive": "", "negative": "",
        "seed": None, "steps": None, "cfg": None,
        "sampler_name": None, "scheduler": None, "denoise": None,
        "width": width, "height": height,
        "model_name": None, "model_hash": None,
        "loras": [],  # [(显示名, 权重, hash10或None)]
    }
    if not isinstance(prompt, dict) or not prompt:
        return info

    start = str(unique_id) if unique_id is not None else None
    order = _bfs_upstream(prompt, [start] if start in prompt else list(prompt.keys()))

    # 手动指定采样器节点 ID 时直接采用（不校验是否为采样器，按该节点输入解析）
    sampler_id = None
    if sampler_override is not None and str(sampler_override) in prompt:
        sampler_id = str(sampler_override)
    if sampler_id is None:
        sampler_id = next((nid for nid in order if _is_sampler_node(prompt[nid])), None)
    if sampler_id is not None:
        s_inputs = prompt[sampler_id].get("inputs", {})
        info["seed"] = _resolve_widget(prompt, sampler_id, ["seed", "noise_seed"])
        info["steps"] = _resolve_widget(prompt, sampler_id, ["steps"])
        info["cfg"] = _resolve_widget(prompt, sampler_id, ["cfg"])
        info["sampler_name"] = _resolve_widget(prompt, sampler_id, ["sampler_name"])
        info["scheduler"] = _resolve_widget(prompt, sampler_id, ["scheduler"])
        info["denoise"] = _resolve_widget(prompt, sampler_id, ["denoise"])
        for key, field in (("positive", "positive"), ("negative", "negative")):
            v = s_inputs.get(key)
            if _is_link(v, prompt):
                info[field] = _resolve_text(prompt, str(v[0]))

    model_name, model_kind, loras = _scan_models(prompt, sampler_id, order)
    if model_name:
        info["model_name"] = os.path.splitext(os.path.basename(model_name))[0]
        if with_hash:
            path = _find_model_path(model_name, model_kind or ())
            if path:
                info["model_hash"] = _sha256_10(path)
    for ln, sm, sc in loras:
        base = os.path.splitext(os.path.basename(ln))[0]
        weight = sm if isinstance(sm, (int, float)) else (sc if isinstance(sc, (int, float)) else 1.0)
        hash10 = None
        if with_hash:
            path = _find_model_path(ln, ("loras",))
            if path:
                hash10 = _sha256_10(path)
        info["loras"].append((base, weight, hash10))
    return info


_FILENAME_BAD = re.compile(r'[\\/:*?"<>|]')


def _safe_token(v, default="unknown"):
    """占位符值 → 文件名片段：None/空串 → default；文件名非法字符替换为 -。"""
    if v is None or (isinstance(v, str) and not v.strip()):
        return default
    s = _fmt_num(v) if isinstance(v, float) else str(v)
    return _FILENAME_BAD.sub("-", s.strip())


def _apply_filename_placeholders(prefix, info):
    """本节点自有占位符（官方另认 %date:...% / %batch_num%），对标参考节点规则：
    %seed% %steps% %cfg% %sampler% %scheduler% %denoise% %model% %width% %height%
    %prompt%（正面提示词首行，截断 50 字符）。解析不到 → unknown。"""
    if not isinstance(prefix, str) or "%" not in prefix:
        return prefix
    pos = (info.get("positive") or "").split("\n")[0].strip()
    mapping = {
        "%seed%": _safe_token(info.get("seed")),
        "%steps%": _safe_token(info.get("steps")),
        "%cfg%": _safe_token(info.get("cfg")),
        "%sampler%": _safe_token(info.get("sampler_name")),
        "%scheduler%": _safe_token(info.get("scheduler")),
        "%denoise%": _safe_token(info.get("denoise")),
        "%model%": _safe_token(info.get("model_name")),
        "%width%": _safe_token(info.get("width")),
        "%height%": _safe_token(info.get("height")),
        "%prompt%": _safe_token(pos[:50]),
    }
    for k, v in mapping.items():
        if k in prefix:
            prefix = prefix.replace(k, v)
    return prefix


def build_parameters(info):
    """拼 A1111 格式参数串（CivitAI 解析格式）：
        正面提示词 <lora:名:权重>…
        Negative prompt: 负面提示词
        Steps: …, Sampler: …, CFG scale: …, Seed: …, Size: WxH, Model hash: …, Model: …, …
    缺哪个字段就跳过哪个。"""
    lines = []
    pos = info.get("positive") or ""
    tags = "".join(f" <lora:{base}:{_fmt_num(w)}>" for base, w, _h in info["loras"])
    if pos or tags:
        lines.append(pos + tags)
    neg = info.get("negative") or ""
    if neg:
        lines.append(f"Negative prompt: {neg}")

    fields = []
    if info.get("steps") is not None:
        fields.append(f"Steps: {_fmt_num(info['steps'])}")
    if info.get("sampler_name"):
        fields.append(f"Sampler: {_sampler_display(info['sampler_name'], info.get('scheduler'))}")
    if info.get("cfg") is not None:
        fields.append(f"CFG scale: {_fmt_num(info['cfg'])}")
    if info.get("seed") is not None:
        fields.append(f"Seed: {_fmt_num(info['seed'])}")
    fields.append(f"Size: {info['width']}x{info['height']}")
    if info.get("model_hash"):
        fields.append(f"Model hash: {info['model_hash']}")
    if info.get("model_name"):
        fields.append(f"Model: {info['model_name']}")
    denoise = info.get("denoise")
    if isinstance(denoise, (int, float)) and denoise != 1.0:
        fields.append(f"Denoising strength: {_fmt_num(denoise)}")
    lora_hashes = ", ".join(f"{base}: {h}" for base, _w, h in info["loras"] if h)
    if lora_hashes:
        fields.append(f'Lora hashes: "{lora_hashes}"')
    if fields:
        lines.append(", ".join(fields))
    return "\n".join(lines)


def _user_comment_bytes(text):
    """EXIF UserComment 编码（与 piexif/A1111 同约定，CivitAI 用 exiftool 读取）：
    纯 ASCII → b"ASCII\\0\\0\\0" + ascii；含非 ASCII → b"UNICODE\\0" + utf-16（带 BOM）。"""
    try:
        return b"ASCII\x00\x00\x00" + text.encode("ascii")
    except UnicodeEncodeError:
        return b"UNICODE\x00" + text.encode("utf-16")


# ---------------------------------------------------------------------------
# 脱敏（保存前默认开启：防止 API key / token / 路径用户名 随元数据外泄）
# ---------------------------------------------------------------------------

# JSON 键名脱敏：小写规范化后做子串匹配（覆盖各家 LLM/API 节点的命名差异），
# 白名单放行 max_tokens 等「含 token 但不是密钥」的常规参数
_SENSITIVE_KEY_PARTS = (
    "api_key", "apikey", "token", "secret", "password", "passwd", "credential",
    "authorization", "oauth", "bearer", "cookie", "private_key", "access_key",
    "session_id", "session_key",
)
_SAFE_KEY_NAMES = {"max_tokens", "num_tokens", "token_count", "tokenizer", "tokenizers"}

_REDACTED = "[REDACTED]"

# 字符串值脱敏：(正则, 替换串)。覆盖：OpenAI/Anthropic/HF/GitHub/Google/AWS/Slack/Replicate
# 令牌前缀、JWT、Bearer 头、URL 查询串敏感参数、绝对路径用户名（保留其余路径段，不影响拖回恢复）
_TOKEN_SUBS = [
    (re.compile(r"sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{16,}"), _REDACTED),
    (re.compile(r"hf_[A-Za-z0-9]{20,}"), _REDACTED),
    (re.compile(r"(?:gh[psour]_|github_pat_)[A-Za-z0-9_]{20,}"), _REDACTED),
    (re.compile(r"AIza[0-9A-Za-z_\-]{30,}"), _REDACTED),
    (re.compile(r"AKIA[0-9A-Z]{16}"), _REDACTED),
    (re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"), _REDACTED),
    (re.compile(r"r8_[A-Za-z0-9]{20,}"), _REDACTED),
    (re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"), _REDACTED),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9_\-.=]{16,}"), "Bearer " + _REDACTED),
    (re.compile(r"(?i)([?&](?:api_key|apikey|token|key|sig|signature|password)=)[^&\s\"']+"), r"\1" + _REDACTED),
    (re.compile(r"([A-Za-z]:[\\/]Users[\\/])[^\\/\s\"']+"), r"\1[USER]"),
    (re.compile(r"(/home/)[^/\s\"']+"), r"\1[USER]"),
]


def _is_sensitive_key(k):
    nk = str(k).strip().lower().replace("-", "_").replace(" ", "_")
    if nk in _SAFE_KEY_NAMES:
        return False
    return any(p in nk for p in _SENSITIVE_KEY_PARTS)


def _sanitize_text(s):
    for pat, repl in _TOKEN_SUBS:
        s = pat.sub(repl, s)
    return s


def _sanitize_obj(obj):
    """递归脱敏 JSON 结构（嵌入的 prompt / workflow）：敏感键名的值整体打码，
    普通字符串值再过令牌/路径扫描。结构与原数据一致，PNG 仍可拖回恢复。"""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if _is_sensitive_key(k) and isinstance(v, str) and v:
                out[k] = _REDACTED
            else:
                out[k] = _sanitize_obj(v)
        return out
    if isinstance(obj, list):
        return [_sanitize_obj(v) for v in obj]
    if isinstance(obj, str):
        return _sanitize_text(obj)
    return obj


# ---------------------------------------------------------------------------
# 节点本体
# ---------------------------------------------------------------------------

class SaveImageMetadata(io.ComfyNode):
    """主存 PNG + 可选附带 JPEG/WEBP；CivitAI 参数串模式或原生 ComfyUI 模式；无预览窗口。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SaveImageMetadata",
            display_name="元数据存图 (Save Image Metadata)",
            category="0DAYE",
            search_aliases=["save image", "save image metadata", "metadata",
                            "civitai", "civitai metadata", "a1111", "pnginfo", "元数据存图", "存图"],
            inputs=[
                io.Image.Input("images", tooltip="要保存的图像（支持批次）"),
                io.String.Input(
                    "filename_prefix",
                    default="ComfyUI_Meta",
                    tooltip="文件名前缀，可含子目录；占位符：官方 %date:yyyy-MM-dd%、%batch_num%，"
                            "本节点另支持 %seed% %steps% %cfg% %sampler% %scheduler% %denoise% %model% %width% %height% %prompt%",
                ),
                io.Boolean.Input(
                    "save_png", default=True, label_on="保存", label_off="不存",
                    tooltip="主格式 PNG（无损；唯一可内嵌完整 ComfyUI 工作流的格式）",
                ),
                io.Combo.Input(
                    "extra_format",
                    options=["不保存", "JPEG", "WEBP"],
                    default="JPEG",
                    tooltip="附带格式：在 PNG 之外再同存一张（一次最多两种格式）。JPEG/WEBP 经 EXIF UserComment 写参数串，CivitAI 可读",
                ),
                io.Combo.Input(
                    "mode",
                    options=["CivitAI 元数据", "原生 ComfyUI"],
                    default="CivitAI 元数据",
                    tooltip="CivitAI 元数据：写 A1111 参数串（可被 CivitAI 识别）；原生 ComfyUI：与官方 Save Image 完全一致——PNG 只嵌工作流 JSON、不写参数串",
                ),
                io.Boolean.Input(
                    "embed_parameters", default=True, label_on="嵌入", label_off="不嵌",
                    tooltip="内嵌 CivitAI/A1111 生成参数串（PNG 的 parameters 块 / JPEG·WEBP 的 EXIF UserComment）；原生模式下无效",
                ),
                io.Boolean.Input(
                    "embed_lora", default=True, label_on="嵌入", label_off="不嵌",
                    tooltip="参数串中附带 LoRA 信息（<lora:名:权重> 内联标签 + Lora hashes 字段）；原生模式下无效",
                ),
                io.Boolean.Input(
                    "embed_workflow", default=False, label_on="嵌入", label_off="不嵌",
                    tooltip="PNG 额外内嵌 ComfyUI 工作流 JSON（可拖回恢复，文件明显变大，默认关）；仅对 PNG 生效；原生模式下强制嵌入",
                ),
                io.Boolean.Input(
                    "sanitize", default=True, label_on="脱敏", label_off="不脱敏",
                    tooltip="保存前脱敏：API key/token/密码等敏感控件值与常见令牌格式打码为 [REDACTED]，防止随元数据外泄",
                ),
                io.Int.Input(
                    "quality", default=95, min=1, max=100,
                    tooltip="JPEG/WEBP 画质（PNG 无损，不受影响）",
                ),
                io.Int.Input(
                    "positive_node_id", default=-1, min=-1, max=999999,
                    tooltip="兜底正面提示词抓取：-1=自动追溯；填节点 ID 则直接从该节点的文本控件抓取（抓取为空时回落自动结果）。优先级低于 positive_text 接线",
                ),
                io.Int.Input(
                    "negative_node_id", default=-1, min=-1, max=999999,
                    tooltip="兜底负面提示词抓取：-1=自动追溯；填节点 ID 则直接从该节点的文本控件抓取（抓取为空时回落自动结果）。优先级低于 negative_text 接线",
                ),
                io.Int.Input(
                    "sampler_node_id", default=-1, min=-1, max=999999,
                    tooltip="兜底采样参数抓取：-1=自动追溯；填节点 ID 则把该节点当采样器解析——seed/steps/cfg/采样器/调度器与模型、LoRA 全部从它派生（解析不到时回落自动结果）",
                ),
                io.Int.Input(
                    "seed_override", default=-1, min=-1, max=(1 << 63) - 1,
                    tooltip="手动指定 seed（-1=不覆盖）。优先级最高，覆盖自动追溯与 sampler_node_id 的结果",
                ),
                io.Int.Input(
                    "steps_override", default=-1, min=-1, max=1000000,
                    tooltip="手动指定步数（-1=不覆盖）。优先级最高",
                ),
                io.String.Input(
                    "model_override", default="", socketless=True,
                    tooltip="手动指定主模型文件名（可含子目录与扩展名，留空=不覆盖）；填了按该名字查文件算哈希。优先级最高",
                ),
                io.String.Input(
                    "lora_override", default="", multiline=True, socketless=True,
                    tooltip="手动指定 LoRA 列表（留空=不覆盖）。每行一项，支持「名称:权重」或「<lora:名称:权重>」，省略权重记 1.0。优先级最高",
                ),
                io.String.Input(
                    "positive_text",
                    optional=True, force_input=True,
                    tooltip="手动指定正面提示词（STRING 线）。接 LLM/文本缓存等动态文本链时用它，优先级高于自动提取",
                ),
                io.String.Input(
                    "negative_text",
                    optional=True, force_input=True,
                    tooltip="手动指定负面提示词（STRING 线），优先级高于自动提取",
                ),
            ],
            outputs=[
                io.Image.Output("images", display_name="images", tooltip="原样透传图像，便于串联后续节点"),
                io.String.Output("parameters", display_name="parameters", tooltip="实际写入图片的 A1111/CivitAI 参数串，可接预览节点查看"),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            description=(
                "保存图像并内嵌 CivitAI 可识别的生成参数（A1111 格式），或切原生 ComfyUI 模式"
                "（与官方 Save Image 一致）。自动追溯提示词/采样参数/模型/LoRA；主存 PNG 加可选附带"
                "JPEG/WEBP；参数串/LoRA/工作流/脱敏各有独立开关；提示词与采样参数/模型/LoRA 都支持"
                "节点 ID 兜底（positive/negative/sampler_node_id）与手动覆盖（positive/negative_text、"
                "seed/steps/model/lora_override）。"
            ),
        )

    @classmethod
    def execute(cls, images, filename_prefix="ComfyUI_Meta",
                save_png=True, extra_format="JPEG", mode="CivitAI 元数据",
                embed_parameters=True, embed_lora=True, embed_workflow=False,
                sanitize=True, quality=95,
                positive_node_id=-1, negative_node_id=-1, sampler_node_id=-1,
                seed_override=-1, steps_override=-1,
                model_override="", lora_override="",
                positive_text=None, negative_text=None):
        hidden = getattr(cls, "hidden", None)
        prompt = getattr(hidden, "prompt", None)
        extra_pnginfo = getattr(hidden, "extra_pnginfo", None)
        unique_id = getattr(hidden, "unique_id", None)

        # 原生 ComfyUI 模式：完全按官方 Save Image 行为（PNG 只嵌工作流，参数串/EXIF 全关）
        native = str(mode).startswith("原生")
        write_meta = not args.disable_metadata

        # 先解析一次：文件名占位符也要用；哈希只在要写元数据时算
        # 尺寸：images[0] 去批次维后是 (H, W, C) → W=shape[1], H=shape[0]
        info = _extract_info(
            prompt, unique_id,
            int(images[0].shape[1]), int(images[0].shape[0]),
            with_hash=write_meta,
            sampler_override=(sampler_node_id if isinstance(sampler_node_id, int) and sampler_node_id >= 0 else None),
        )
        # 提示词覆盖（节点 ID 兜底 → 手动接线最高）：参数串与 %prompt% 占位符共用最终结果
        if isinstance(prompt, dict):
            for nid, field in ((positive_node_id, "positive"), (negative_node_id, "negative")):
                if isinstance(nid, int) and nid >= 0 and str(nid) in prompt:
                    grabbed = _resolve_text(prompt, str(nid))
                    if grabbed:
                        info[field] = grabbed
        if isinstance(positive_text, str) and positive_text.strip():
            info["positive"] = positive_text
        if isinstance(negative_text, str) and negative_text.strip():
            info["negative"] = negative_text

        # 采样参数 / 模型 / LoRA 手动兜底（优先级最高：覆盖自动追溯与 sampler_node_id 结果）
        if isinstance(seed_override, int) and seed_override >= 0:
            info["seed"] = seed_override
        if isinstance(steps_override, int) and steps_override > 0:
            info["steps"] = steps_override
        if isinstance(model_override, str) and model_override.strip():
            raw = model_override.strip()
            info["model_name"] = os.path.splitext(os.path.basename(raw))[0]
            info["model_hash"] = None
            if write_meta:
                path = _find_model_path(raw, ("checkpoints", "diffusion_models", "unet"))
                if path:
                    info["model_hash"] = _sha256_10(path)
        if isinstance(lora_override, str) and lora_override.strip():
            info["loras"] = _parse_lora_override(lora_override, with_hash=write_meta)

        filename_prefix = _apply_filename_placeholders(filename_prefix, info)

        output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, images[0].shape[1], images[0].shape[0]
        )

        params = ""
        if write_meta:
            if not embed_lora:
                info["loras"] = []
            params = build_parameters(info)
            if sanitize:
                params = _sanitize_text(params)

        # 参数串是否实际写入文件（原生模式不写出；parameters 输出端口仍给字符串便于预览）
        write_params = write_meta and embed_parameters and not native
        # PNG 是否嵌工作流：原生模式强制嵌（官方行为）；CivitAI 模式看开关（默认关）
        write_workflow = write_meta and (native or embed_workflow)

        # 脱敏只作用于「写入的数据」，不改原对象；结构保持一致，PNG 仍可拖回恢复
        meta_prompt = _sanitize_obj(prompt) if (sanitize and prompt is not None) else prompt
        meta_pnginfo = _sanitize_obj(extra_pnginfo) if (sanitize and extra_pnginfo) else extra_pnginfo

        extra = {"JPEG": "JPEG", "WEBP": "WEBP"}.get(str(extra_format).upper())
        if not save_png and extra is None:
            print("[SaveImageMetadata] 警告：save_png 关 且 附带格式=不保存，本次不保存任何文件")

        for batch_number, image in enumerate(images):
            i = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
            base = filename.replace("%batch_num%", str(batch_number)) + f"_{counter:05}_"

            if save_png:
                file = base + ".png"
                pnginfo = PngInfo()
                if write_params:
                    pnginfo.add_text("parameters", params)  # CivitAI 读取点
                if write_workflow:
                    if meta_prompt is not None:
                        pnginfo.add_text("prompt", json.dumps(meta_prompt))
                    if meta_pnginfo:
                        for key in meta_pnginfo:  # 与官方 SaveImage 同约定：可拖回恢复工作流
                            pnginfo.add_text(key, json.dumps(meta_pnginfo[key]))
                img.save(os.path.join(full_output_folder, file), pnginfo=pnginfo, compress_level=4)

            if extra == "JPEG":
                file = base + ".jpg"
                jpg = img if img.mode == "RGB" else img.convert("RGB")  # JPEG 不支持 alpha
                exif = Image.Exif()
                if write_params:
                    exif[0x9286] = _user_comment_bytes(params)  # UserComment，CivitAI 读取点
                jpg.save(os.path.join(full_output_folder, file), "JPEG",
                         quality=int(quality), exif=exif)
            elif extra == "WEBP":
                file = base + ".webp"
                exif = Image.Exif()
                if write_params:
                    exif[0x9286] = _user_comment_bytes(params)
                img.save(os.path.join(full_output_folder, file), "WEBP",
                         quality=int(quality), exif=exif)

            counter += 1  # 同一张图的两种格式共用编号，下一张图再递增

        # 不返回 ui 数据：只存盘，节点上不出预览图片窗口（预览请接官方 Preview Image）
        return io.NodeOutput(images, params)
