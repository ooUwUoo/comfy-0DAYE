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
mode=自动，清空它即可恢复直通。

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
        print("[TextCache] 警告：历史为空，输出空串（请先切到 自动/上游 并跑一次）")
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
    """文本缓存与历史回溯 v3：自动判定（覆盖→直通→历史），按 key 隔离，50 条历史。"""

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
                    "override_text",
                    multiline=True,
                    default="",
                    socketless=True,
                    tooltip="手动覆盖：非空时优先输出并记入历史；清空恢复上游",
                ),
                io.Combo.Input(
                    "mode",
                    options=["自动", "上游", "历史"],
                    default="自动",
                    tooltip="自动：override_text 非空→输出它；否则上游 text 非空→直通；否则（上游被静音/未接）→输出历史[history_index]。上游：无条件输出上游。历史：无条件输出历史",
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
                    tooltip="输出文本：自动/上游=最新文本或覆盖文本；历史=选中的一条",
                ),
                io.String.Output(
                    "history_list",
                    display_name="history_list",
                    tooltip="当前历史清单（编号+完整文本，⏎=换行），供节点面板/预览查看",
                ),
            ],
            description=(
                "文本缓存/上游/历史：自动判定（覆盖文本→上游直通→历史兜底）；"
                "按 history_key 隔离，每抽屉最近 50 条去重；内存态，重启即清空。"
            ),
        )

    @classmethod
    def execute(cls, mode, text=None, override_text="", history_key=-1, history_index=0):
        # text 是 optional 输入：未连线时执行器根本不传该 kwarg（必须有默认值），
        # 上游被静音时传 None；两种「空」统一兜底为 ""。
        if text is None:
            text = ""
        if override_text is None:
            override_text = ""

        texts = _history_bucket(history_key)

        if mode == "上游":
            _record(texts, text)
            out_text = text
        elif mode == "历史":
            out_text = _pick(texts, history_index)
        else:  # "自动" 及未知值兜底（旧值 auto/直通/手动 等一律走自动判定，安全）
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
