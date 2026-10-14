// 文本缓存节点历史面板 —— comfy_0DAYE
// 在节点体内注入「历史记录」区域：最近 50 条，每条 = 序号 + 截断文本 + 复制/回填双按钮；
// 悬停弹出完整文本；执行完成后自动刷新；history_key=-1 时写入当前节点实例 id 实现自动隔离。
import { app } from "../../../scripts/app.js";

const NODE_NAME = "TextCacheWithHistory";
const PANEL_H = 240; // 面板固定高度，超出滚动
const ROW_BRIEF_MAX = 120; // 行内展示的截断长度（字符）

const STYLE_ID = "0daye-histpanel-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    .od-hp{width:100%;height:${PANEL_H}px;box-sizing:border-box;overflow-y:auto;
      background:#16161b;color:#cfcfd6;font-family:Consolas,'Microsoft YaHei',monospace;
      font-size:12px;line-height:1.5;padding:4px 6px;border-top:1px solid #33333c;}
    .od-hp-header{color:#8a8f98;font-size:11px;margin-bottom:3px;}
    .od-hp-empty{color:#6b7280;font-size:11px;padding:6px 2px;}
    .od-hp-row{display:flex;align-items:center;gap:5px;padding:1px 2px;border-radius:3px;}
    .od-hp-row:hover{background:#2a2a31;}
    .od-hp-num{color:#8a8f98;min-width:26px;text-align:right;flex:none;font-size:11px;}
    .od-hp-txt{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default;}
    .od-hp-btn{flex:none;border:1px solid #4a4a55;background:#26262d;color:#cfcfd6;
      border-radius:3px;padding:0 5px;font-size:11px;cursor:pointer;height:18px;line-height:16px;}
    .od-hp-btn:hover{border-color:#7a7a88;background:#33333c;}
    .od-hp-tip{position:fixed;z-index:9999;max-width:520px;white-space:pre-wrap;word-break:break-word;
      background:#0f0f13;border:1px solid #55555f;color:#e6e6ee;font-size:12px;line-height:1.5;
      padding:6px 8px;border-radius:4px;box-shadow:0 2px 10px rgba(0,0,0,.5);pointer-events:none;}
  `;
  document.head.appendChild(el);
}

// —— history_key=-1（自动）时写入当前节点实例编号 ——
function autoAssignKey(node) {
  const kw = node.widgets?.find((w) => w.name === "history_key");
  if (kw && (kw.value === -1 || kw.value === "-1")) kw.value = node.id;
}

// —— 面板构建 ——
function makePanel() {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "od-hp";
  const header = document.createElement("div");
  header.className = "od-hp-header";
  header.textContent = "历史记录（50 条 · 悬停看全文 · 复制/回填）";
  const list = document.createElement("div");
  root.appendChild(header);
  root.appendChild(list);
  const tip = document.createElement("div");
  tip.className = "od-hp-tip";
  tip.style.display = "none";
  document.body.appendChild(tip);
  return { root, list, tip };
}

function attachPanel(node) {
  if (node._odHp) return; // 已挂载过
  const p = makePanel();
  const widget = node.addDOMWidget("0daye_histpanel", "histpanel", p.root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => PANEL_H,
  });
  widget.computeLayoutSize = () => ({ minHeight: PANEL_H, minWidth: 1 });
  node._odHp = { ...p, widget };
  updatePanel(node, []);
}

// —— 渲染 ——
function updatePanel(node, entries) {
  const p = node._odHp;
  if (!p) return;
  p.list.textContent = "";
  if (!entries.length) {
    const e = document.createElement("div");
    e.className = "od-hp-empty";
    e.textContent = "（暂无历史：运行一次后自动显示最近 50 条）";
    p.list.appendChild(e);
    return;
  }
  for (const ent of entries) {
    const row = document.createElement("div");
    row.className = "od-hp-row";

    const num = document.createElement("span");
    num.className = "od-hp-num";
    num.textContent = `#${ent.index}`;

    const txt = document.createElement("span");
    txt.className = "od-hp-txt";
    txt.textContent = brief(ent.text, ROW_BRIEF_MAX);

    const btnC = makeBtn("复制");
    btnC.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copyText(ent.text, btnC);
    });
    const btnF = makeBtn("回填");
    btnF.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fillManual(node, ent.text, btnF);
    });

    row.appendChild(num);
    row.appendChild(txt);
    row.appendChild(btnC);
    row.appendChild(btnF);

    // 自定义悬浮弹层（完整文本）
    row.addEventListener("mouseenter", (ev) => showTip(p, ent.text, ev));
    row.addEventListener("mousemove", (ev) => moveTip(p, ev));
    row.addEventListener("mouseleave", () => hideTip(p));

    p.list.appendChild(row);
  }
}

function brief(s, n) {
  const flat = String(s).replace(/\s+/g, " ");
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

function makeBtn(label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "od-hp-btn";
  b.textContent = label;
  return b;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = old;
  }, 900);
}

async function copyText(txt, btn) {
  try {
    await navigator.clipboard.writeText(txt);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
  }
  flash(btn, "已复制");
}

// 回填：写入 override_text，并确保 mode=auto（auto 下 override_text 优先级最高，输出即生效）
function fillManual(node, txt, btn) {
  const mw = node.widgets?.find((w) => w.name === "override_text");
  const md = node.widgets?.find((w) => w.name === "mode");
  if (mw) {
    mw.value = txt;
    if (typeof mw.callback === "function") {
      try { mw.callback(txt); } catch (_) {}
    }
  }
  if (md && md.value !== "auto") {
    md.value = "auto";
    if (typeof md.callback === "function") {
      try { md.callback("auto"); } catch (_) {}
    }
  }
  try { node.setDirtyCanvas(true, true); } catch (_) {}
  flash(btn, "已回填");
}

// —— 悬浮弹层 ——
function showTip(p, text, ev) {
  p.tip.textContent = text;
  p.tip.style.display = "block";
  moveTip(p, ev);
}
function moveTip(p, ev) {
  const pad = 12;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const r = p.tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = Math.max(8, ev.clientX - r.width - pad);
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, ev.clientY - r.height - pad);
  p.tip.style.left = `${x}px`;
  p.tip.style.top = `${y}px`;
}
function hideTip(p) {
  p.tip.style.display = "none";
}

// —— 解析后端 history_list（行格式：`N. 文本`，换行已用 ⏎ 占位）——
function parseList(str) {
  const out = [];
  const lines = String(str || "").split("\n");
  for (const line of lines) {
    const m = /^\s*(\d+)\.\s?(.*)$/.exec(line);
    if (m) {
      out.push({ index: parseInt(m[1], 10), text: m[2].replace(/⏎/g, "\n") });
    }
  }
  return out;
}

// 执行完成后自动刷新本节点面板
app.api?.addEventListener?.("executed", (e) => {
  const d = e?.detail;
  if (!d || !app.graph) return;
  const nodeId = d.node ?? d.display_node;
  if (nodeId == null) return;
  let node = null;
  try {
    node = app.graph.getNodeById ? app.graph.getNodeById(nodeId) : app.graph._nodes_by_id?.[nodeId];
  } catch (_) {}
  if (!node || node.type !== NODE_NAME) return;
  const listStr = d.output?.history_list;
  if (typeof listStr === "string") updatePanel(node, parseList(listStr));
});

app.registerExtension({
  name: "0DAYE.TextCacheHistoryPanel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      autoAssignKey(this);
      attachPanel(this);
      return r;
    };

    // 加载工作流时 configure 直接赋值、不触发 onNodeCreated 的回调逻辑，需补一次 key 分配
    const origConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      const rc = origConfigure?.apply(this, arguments);
      autoAssignKey(this);
      return rc;
    };
  },
});
