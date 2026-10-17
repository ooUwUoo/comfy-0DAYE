# -*- coding: utf-8 -*-
"""
文本缓存 / 上游 / 历史（带历史回溯）节点 —— comfy_0DAYE  v3

用途：
  接住上游 LLM（提示词优化/翻译等）输出的文本，解决「跑一次得到好结果后，
  不想每次跑图都重新调 LLM」的问题。

三种模式（mode）：
  - 自动（默认）：自动判定，按优先级
      ① override_text 非空 → 输出它并记入历史（手动粘贴/回填写入后运行 = 自动固定）
      ② 上游 text 非空     → 直通并记入历史（默认直通显示）
      ③ 否则（上游被静音/未接）→ 输出历史[history_index]（自动固定上一轮）
  - 上游：无条件输出上游 text（非空时记入历史）
  - 历史：无条件输出历史[history_index]（上一轮结果复用，即原「固定」）

（v3 已移除「手动」模式：自动① 在 override_text 非空时行为与之相同，
    唯一差异（override 为空时手动输出空串而非回退）无实际用途。）

text 为纯连线输入端口（force_input：绿色圆点、无文本框，optional → 位于其它控件下方），
接上游直通；手动输入/覆盖请用 override_text 文本框（socketless）：「回填」按钮写入它并切
mode=自动，清空它即可恢复直通（面板标题栏「清空下框」按钮一键清空）。

触发词前缀（v4 新增，三种模式外层统一生效，输出恒为「前缀 + 主体」，前缀固定段首）：
  - prefix：socketless 多行文本框，手动触发词，逗号/换行分隔，可随时增删改，随工作流保存；
    冻结 override_text 后仍可独立改前缀，下次出图即生效、不破坏冻结。
  - trigger_text：optional + forceInput 纯端口，接 LoraManager 等加载器的 trigger_words 输出，
    随 LoRA 开关动态变化（仅 active 的 LoRA 贡献词）；未接/静音收 None 兜底空。
  - 手动框词在前、动态端口词在后，保序去重，空项自动跳过（兼容 LoraManager 的 ",, " 分隔）。
  - 历史里记的是拼接后的完整文本；回填的全文若已带当前前缀则不重复拼接。

历史：
  - 按 history_key 分抽屉隔离。key = -1 表示「自动」：前端会在节点创建时把当前
    节点实例编号写入该 widget，使每个节点实例各自独立一份历史；填入具体数字则
    手动分组，相同数字共享同一份历史（API/CLI 直调未经过前端时 -1 兜底归 0 号）。
  - 每抽屉最多 HISTORY_MAX（50）条，去重（与最新一条相同则不重复入列）。
  - 持久化到 ComfyUI/user/0DAYE/text_cache_history.json（新增条目/清空时原子写盘），重启自动恢复；
    面板标题栏「清空历史」按钮经 API 路由清当前节点抽屉（内存+磁盘同步）。
"""

import json
import os
import re

import folder_paths
from comfy_api.latest import io

HISTORY_MAX = 50

# 用户私有数据目录：ComfyUI/user/0DAYE/（插件更新/重装不丢，也不入 git）
USER_DATA_DIR = os.path.join(folder_paths.base_path, "user", "0DAYE")
# 历史持久化文件：{history_key: [最新在前]}，仅新增条目/清空时写盘
_HISTORY_FILE = os.path.join(USER_DATA_DIR, "text_cache_history.json")


def _load_history():
    """启动时从磁盘恢复历史；文件缺失/损坏一律按空历史兜底（不影响节点运行）。"""
    try:
        with open(_HISTORY_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return {}
    out = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                key = int(k)
            except (TypeError, ValueError):
                continue
            texts = v.get("texts") if isinstance(v, dict) else v
            if isinstance(texts, list):
                texts = [t for t in texts if isinstance(t, str) and t][:HISTORY_MAX]
                if texts:
                    out[key] = {"texts": texts}
    return out


# 模块级历史缓存：key -> {"texts": [...]}；启动时从 _HISTORY_FILE 恢复，写操作落盘持久化
_HISTORY = _load_history()


def _save_history():
    """原子写盘（先 tmp 后替换，防写一半损坏）；只存非空抽屉。写失败仅告警，不影响执行。"""
    data = {str(k): v["texts"] for k, v in _HISTORY.items() if v.get("texts")}
    try:
        os.makedirs(USER_DATA_DIR, exist_ok=True)
        tmp = _HISTORY_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, _HISTORY_FILE)
    except Exception as e:
        print(f"[TextCache] 警告：历史写盘失败：{e}")


def history_preview(key):
    """只读查询：某抽屉历史清单（_preview 同款行格式），供前端面板在重启/加载工作流后恢复显示。
    无抽屉或空历史返回 ""（前端显示「暂无历史」）。"""
    try:
        key = int(key)
    except (TypeError, ValueError):
        key = 0
    if key < 0:
        key = 0
    texts = _HISTORY.get(key, {}).get("texts") or []
    return _preview(texts) if texts else ""


def clear_history(key):
    """清空指定抽屉的历史（内存+磁盘同步）。返回是否有内容被清。供 __init__ 的 API 路由调用。"""
    try:
        key = int(key)
    except (TypeError, ValueError):
        key = 0
    if key < 0:
        key = 0  # 与 _history_bucket 同一兜底
    existed = bool(_HISTORY.get(key, {}).get("texts"))
    _HISTORY.pop(key, None)
    _save_history()
    return existed


def _history_bucket(key):
    if key is None or key < 0:
        key = 0  # 兜底：前端正常会把 -1 替换成节点实例 id；API 直调时归 0 号抽屉
    return _HISTORY.setdefault(key, {"texts": []})["texts"]


def latest_history_text(history_key):
    """只读查询：某抽屉历史最新一条（无则 ""）。供同插件 SaveImageMetadata 静态追溯回退用——
    文本缓存在采样链上游、必先于保存节点执行（拓扑序），同一遍运行内读到的就是本轮实际输出文本；
    上游被静音时读到的是上一轮的冻结文本。只读，不创建空抽屉。"""
    try:
        key = int(history_key)
    except (TypeError, ValueError):
        key = 0
    if key < 0:
        key = 0
    texts = _HISTORY.get(key, {}).get("texts") or []
    return texts[0] if texts else ""


def _record(texts, text):
    if text and (not texts or texts[0] != text):
        texts.insert(0, text)
        del texts[HISTORY_MAX:]
        return True
    return False


def _pick(texts, history_index):
    if not texts:
        print("[TextCache] 警告：历史为空，输出空串（请先切到 自动/上游 并跑一次）")
        return ""
    idx = max(0, min(int(history_index), len(texts) - 1))
    return texts[idx]


def _split_terms(text):
    """触发词文本切项：英文逗号/中文逗号/换行分隔，strip 后去空项。
    LoraManager 的 trigger_words 用 ",, " 连接多组词，连续逗号产生的空项在此自然丢弃。"""
    if not isinstance(text, str) or not text:
        return []
    return [t.strip() for t in re.split(r"[,，\r\n]+", text) if t.strip()]


def _compose(body, prefix="", trigger_text=""):
    """把「手动 prefix 框 + 动态 trigger_text 端口」的触发词保序去重后，拼到主体段首。

    顺序：手动框词在前（用户显式控制优先），动态端口词在后；统一用 ", " 连接，恒居段首
    （CLIP 位置注意力前段权重高）。主体已以该前缀开头时（典型：历史回填写入的是旧拼接全文）
    不重复拼接，直接返回主体。
    """
    body = body or ""
    terms, seen = [], set()
    for term in _split_terms(prefix) + _split_terms(trigger_text):
        if term not in seen:
            seen.add(term)
            terms.append(term)
    if not terms:
        return body
    head = ", ".join(terms)
    if body == head or body.startswith(head + ","):
        return body
    return head + ", " + body if body else head


def _preview(texts):
    if not texts:
        return "(历史为空)"
    # 每行一条完整文本：换行用 ⏎ 占位（前端面板解析回原文）；无截断，悬停可看全文
    return "\n".join(
        f"{i}. {t.replace(chr(10), '⏎').replace(chr(13), '')}"
        for i, t in enumerate(texts)
    )


class TextCacheWithHistory(io.ComfyNode):
    """文本缓存与历史回溯 v4：自动判定（覆盖→直通→历史）+ 触发词前缀拼接，按 key 隔离，50 条历史。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TextCacheWithHistory",
            display_name="Text Cache",
            category="0DAYE",
            inputs=[
                io.String.Input(
                    "text",
                    optional=True,      # 必留：required 输入未连线会被校验拒绝（required_input_missing），optional 才能「不接线/只跑历史」
                    force_input=True,   # 只保留连线端口（绿色圆点），不生成文本框；该端口专接上游 LLM
                    # 端口位置说明：前端渲染顺序 = required 组在前、optional 组在后，
                    # 故 text 端口在其它控件下方（左下角），无法再置顶（置顶需脆弱 JS 重排，不做）。
                    # 上游被静音（Ctrl+M）时执行器传 None → execute 里兜底为 ""。手动输入请用 override_text 文本框。
                    tooltip="接上游 LLM 的文本输出（STRING 线，仅端口无文本框）。上游组被静音（Ctrl+M）时收不到数据 → 自动切到历史",
                ),
                io.String.Input(
                    "trigger_text",
                    optional=True,      # 同 text：不接线/加载器静音都不能导致执行失败
                    force_input=True,   # 纯端口无文本框，专接 LoraManager 等加载器的 trigger_words
                    tooltip=(
                        "动态触发词（STRING 线，仅端口）：接 LoraManager 等加载器的 trigger_words 输出，"
                        "只含 active 开启的 LoRA 的词；与手动 prefix 合并去重后拼在段首。未接/静音时忽略"
                    ),
                ),
                io.String.Input(
                    "prefix",
                    multiline=True,
                    default="",
                    socketless=True,
                    advanced=True,
                    tooltip=(
                        "触发词前缀（手动，逗号或换行分隔多个）：始终拼在最终输出段首，与模式无关；"
                        "可随时增删改，冻结 override_text 后改这里也立即生效（面板「清空上框」一键清空）"
                    ),
                ),
                io.String.Input(
                    "override_text",
                    multiline=True,
                    default="",
                    socketless=True,
                    tooltip="手动覆盖：非空时优先输出并记入历史；清空恢复上游（面板标题栏「清空下框」按钮可一键清空）",
                ),
                io.Combo.Input(
                    "mode",
                    options=["自动", "上游", "历史"],
                    default="自动",
                    advanced=True,
                    tooltip="自动：override_text 非空→输出它；否则上游 text 非空→直通；否则（上游被静音/未接）→输出历史[history_index]。上游：无条件输出上游。历史：无条件输出历史",
                ),
                io.Int.Input(
                    "history_key",
                    default=-1,
                    min=-1,
                    max=999999,
                    advanced=True,
                    tooltip="-1=自动：前端在节点创建时写入当前节点实例编号，每个节点历史互相独立；填相同数字则共享同一份历史",
                ),
                io.Int.Input(
                    "history_index",
                    default=0,
                    min=0,
                    max=HISTORY_MAX - 1,
                    advanced=True,
                    tooltip="历史模式下输出第几条历史：0=最近一条，1=前一条……（最多保留 50 条）",
                ),
            ],
            outputs=[
                io.String.Output(
                    "text",
                    display_name="text",
                    tooltip="输出文本：触发词前缀（prefix 框 + trigger_text 端口，去重）拼在段首 + 模式决定的主体（覆盖/上游/历史）",
                ),
                io.String.Output(
                    "history_list",
                    display_name="history_list",
                    tooltip="当前历史清单（编号+完整文本，⏎=换行），供节点面板/预览查看",
                ),
            ],
            description=(
                "文本缓存/上游/历史：自动判定（覆盖文本→上游直通→历史兜底）；"
                "触发词前缀（手动 prefix 框 + trigger_text 动态端口）恒拼段首、保序去重；"
                "按 history_key 隔离，每抽屉最近 50 条去重；历史持久化到插件目录 JSON，重启保留。"
            ),
        )

    @classmethod
    def execute(cls, mode, text=None, trigger_text=None, override_text="", prefix="",
                history_key=-1, history_index=0):
        # text / trigger_text 都是 optional 输入：未连线时执行器根本不传该 kwarg（必须有默认值），
        # 上游被静音时传 None；两种「空」统一兜底为 ""。
        if text is None:
            text = ""
        if trigger_text is None:
            trigger_text = ""
        if override_text is None:
            override_text = ""
        if prefix is None:
            prefix = ""

        texts = _history_bucket(history_key)

        # 模式只决定「主体」；触发词前缀在主体确定后统一拼（历史模式复用旧文，不重复入历史）
        record = False  # 该主体是否需要记入历史（与旧逻辑一致：仅 自动①②/上游非空 记录）
        if mode == "上游":
            body = text
            record = bool(text)
        elif mode == "历史":
            body = _pick(texts, history_index)
        else:  # "自动" 及未知值兜底（旧值 auto/直通/手动 等一律走自动判定，安全）
            if override_text:
                body = override_text
                record = bool(override_text)
            elif text:
                body = text
                record = bool(text)
            else:
                body = _pick(texts, history_index)

        # 历史记的是拼接后的完整文本：保存节点历史回退同遍即可读到含触发词的最终 prompt
        out_text = _compose(body, prefix, trigger_text)
        if record and _record(texts, out_text):
            _save_history()  # 只在真正新增条目时落盘

        # 关键：必须带 ui 返回，否则后端 len(output_ui)>0 不成立 → 不广播 executed
        # 事件 → 前端历史面板永远收不到刷新数据。ui 的值必须是列表（后端会按可迭代展开）。
        hist_list = _preview(texts)
        return io.NodeOutput(
            out_text,
            hist_list,
            ui={"text": [out_text], "history_list": [hist_list]},
        )
