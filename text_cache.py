# -*- coding: utf-8 -*-
"""
文本缓存 / 直通 / 历史（带历史回溯）节点 —— comfy_0DAYE  v2

用途：
  接住上游 LLM（提示词优化/翻译等）输出的文本，解决「跑一次得到好结果后，
  不想每次跑图都重新调 LLM」的问题。

三种模式（mode）：
  - auto（默认）：自动判定，按优先级
      ① override_text 非空 → 输出它并记入历史（手动粘贴/回填写入后运行 = 自动固定）
      ② 上游 text 非空     → 直通并记入历史（默认直通显示）
      ③ 否则（上游被静音/未接）→ 输出历史[history_index]（自动固定上一轮）
  - 直通：无条件输出上游 text（非空时记入历史）
  - 历史：无条件输出历史[history_index]（上一轮结果复用，即原「固定」）

（v3 已移除「手动」模式：auto ① 在 override_text 非空时行为与之相同，
    唯一差异（override 为空时手动输出空串而非回退）无实际用途。）

text 为可连线输入端口（前端隐藏文本框只留端口、置顶），接上游直通；手动输入/覆盖请用
override_text 文本框（socketless）：「回填」按钮写入它并切 mode=auto，清空它即可恢复直通。

历史：
  - 按 history_key 分抽屉隔离。key = -1 表示「自动」：前端会在节点创建时把当前
    节点实例编号写入该 widget，使每个节点实例各自独立一份历史；填入具体数字则
    手动分组，相同数字共享同一份历史（API/CLI 直调未经过前端时 -1 兜底归 0 号）。
  - 每抽屉最多 HISTORY_MAX（50）条，去重（与最新一条相同则不重复入列）。
  - 只存在进程内存（模块级），重启 ComfyUI 即清空。
"""

from comfy_api.latest import io

HISTORY_MAX = 50

# 模块级内存历史缓存：key -> {"texts": [...]}；重启 ComfyUI 进程即清空
_HISTORY = {}


def _history_bucket(key):
    if key is None or key < 0:
        key = 0  # 兜底：前端正常会把 -1 替换成节点实例 id；API 直调时归 0 号抽屉
    return _HISTORY.setdefault(key, {"texts": []})["texts"]


def _record(texts, text):
    if text and (not texts or texts[0] != text):
        texts.insert(0, text)
        del texts[HISTORY_MAX:]
        return True
    return False


def _pick(texts, history_index):
    if not texts:
        print("[TextCache] 警告：历史为空，输出空串（请先切到 auto/直通 并跑一次）")
        return ""
    idx = max(0, min(int(history_index), len(texts) - 1))
    return texts[idx]


def _preview(texts):
    if not texts:
        return "(历史为空)"
    # 每行一条完整文本：换行用 ⏎ 占位（前端面板解析回原文）；无截断，悬停可看全文
    return "\n".join(
        f"{i}. {t.replace(chr(10), '⏎').replace(chr(13), '')}"
        for i, t in enumerate(texts)
    )


class TextCacheWithHistory(io.ComfyNode):
    """文本缓存与历史回溯 v3：auto 自动判定（覆盖→直通→历史），按 key 隔离，50 条历史。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TextCacheWithHistory",
            display_name="文本缓存",
            category="0DAYE",
            inputs=[
                io.String.Input(
                    "text",
                    multiline=True,
                    default="",
                    # 注意：不要设 optional=True。io 节点渲染顺序 = required 组在前、optional 组在后，
                    # text 必须在 required 组第一位，保证它的连线端口在节点最上方（置顶）。
                    # 前端会隐藏 text 的文本框（w.hidden，只保留端口，省出节点区域）；
                    # 不连线时用 widget 默认值 ""，上游连线时用连线值。手动输入请用 override_text 文本框。
                    tooltip="接上游 LLM 的文本输出（STRING 线，前端已隐藏文本框仅留端口，置顶）。上游组被静音（Ctrl+M）时收不到数据 → auto 自动切到历史",
                ),
                io.String.Input(
                    "override_text",
                    multiline=True,
                    default="",
                    socketless=True,
                    tooltip="手动覆盖文本：auto 模式下非空时优先级最高，压过上游 text 输出并记入历史；想恢复直通就清空它",
                ),
                io.Combo.Input(
                    "mode",
                    options=["auto", "直通", "历史"],
                    default="auto",
                    tooltip="auto：override_text 非空→输出它；否则上游 text 非空→直通；否则（上游被静音/未接）→输出历史[history_index]。直通：无条件输出上游。历史：无条件输出历史",
                ),
                io.Int.Input(
                    "history_key",
                    default=-1,
                    min=-1,
                    max=999999,
                    tooltip="-1=自动：前端在节点创建时写入当前节点实例编号，每个节点历史互相独立；填相同数字则共享同一份历史",
                ),
                io.Int.Input(
                    "history_index",
                    default=0,
                    min=0,
                    max=HISTORY_MAX - 1,
                    tooltip="历史模式下输出第几条历史：0=最近一条，1=前一条……（最多保留 50 条）",
                ),
            ],
            outputs=[
                io.String.Output(
                    "text",
                    display_name="text",
                    tooltip="输出文本：auto/直通=最新文本或覆盖文本；历史=选中的一条",
                ),
                io.String.Output(
                    "history_list",
                    display_name="history_list",
                    tooltip="当前历史清单（编号+完整文本，⏎=换行），供节点面板/预览查看",
                ),
            ],
            description=(
                "文本缓存/直通/历史：auto 自动判定（覆盖文本→上游直通→历史兜底）；"
                "按 history_key 隔离，每抽屉最近 50 条去重；内存态，重启即清空。"
            ),
        )

    @classmethod
    def execute(cls, mode, text, override_text, history_key, history_index):
        if text is None:
            text = ""
        if override_text is None:
            override_text = ""

        texts = _history_bucket(history_key)

        if mode == "直通":
            _record(texts, text)
            out_text = text
        elif mode == "历史":
            out_text = _pick(texts, history_index)
        else:  # "auto" 及未知值兜底
            if override_text:
                _record(texts, override_text)
                out_text = override_text
            elif text:
                _record(texts, text)
                out_text = text
            else:
                out_text = _pick(texts, history_index)

        # 关键：必须带 ui 返回，否则后端 len(output_ui)>0 不成立 → 不广播 executed
        # 事件 → 前端历史面板永远收不到刷新数据。ui 的值必须是列表（后端会按可迭代展开）。
        hist_list = _preview(texts)
        return io.NodeOutput(
            out_text,
            hist_list,
            ui={"text": [out_text], "history_list": [hist_list]},
        )
