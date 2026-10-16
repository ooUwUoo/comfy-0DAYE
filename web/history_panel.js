// 文本缓存节点历史面板 —— comfy_0DAYE
// 节点体内「历史记录」区域：最近 50 条，每条 = 序号 + 截断文本 + 复制/回填双按钮；
// 悬停弹出完整文本；执行完成后自动刷新；history_key=-1 时写入当前节点实例 id 实现自动隔离。
// 面板高度由底部手柄单独调节（p.h，默认 160px，随工作流持久化在 node.properties.odPanelH）。
// 关键机制（勿改坏）：新前端 _arrangeWidgets 会把节点多余高度在所有「有 computeLayoutSize 的 widget」
// 之间等比均分。若面板与提示词框都是弹性 widget，拖手柄增高节点时两者会一起变长（输入框跟着被拉长）。
// 因此面板必须声明「固定高度」（minHeight = maxHeight = p.h，remaining=0 不参与分配）：
//   ① 拖手柄 → 面板 +delta、节点总高同步 +delta → 提示词框分配额不变，只有面板变高；
//   ② 拖节点右下角 → 面板不动、多余高度全归提示词框（原生行为）。
// text / override_text 均走新前端原生渲染：text 为纯连线端口（force_input，无文本框）。
import { app } from "../../../scripts/app.js";

const NODE_NAME = "TextCacheWithHistory";
const PANEL_H = 160; // 默认面板高度（px）
const PANEL_MIN = 80; // 面板最小高度（px，拖拽手柄/节点缩放的硬下限）
const PANEL_MAX = 1000; // 面板最大高度（px，拖拽手柄上限）
const DEFAULT_W = 314; // 新建节点默认宽（按用户工作流实测尺寸）
const DEFAULT_H = 360; // 新建节点默认高（同上）
const ROW_BRIEF_MAX = 120; // 行内展示的截断长度（字符）

const STYLE_ID = "0daye-histpanel-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    .od-hp{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;
      background:#16161b;color:#cfcfd6;font-family:Consolas,'Microsoft YaHei',monospace;
      font-size:12px;line-height:1.5;padding:4px 6px;border-top:1px solid #33333c;}
    .od-hp-header{color:#8a8f98;font-size:11px;margin-bottom:3px;flex:none;}
    .od-hp-list{flex:1 1 auto;min-height:0;overflow-y:auto;}
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
    .od-hp-grip{flex:none;height:8px;cursor:ns-resize;margin:2px -6px -4px;
      background:linear-gradient(to bottom,transparent 2px,#3a3a44 2px,#3a3a44 3px,transparent 3px,
        transparent 5px,#3a3a44 5px,#3a3a44 6px,transparent 6px);}
    .od-hp-grip:hover{background-color:#2a2a31;}
  `;
  document.head.appendChild(el);
}

// —— 面板高度状态：p.h（节点单位），持久化到 node.properties.odPanelH（随工作流保存）——
function clampPanelH(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return PANEL_H;
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, n));
}
function readStoredPanelH(node) {
  return clampPanelH(node?.properties?.odPanelH);
}
function persistPanelH(node, h) {
  try {
    node.properties = node.properties || {};
    node.properties.odPanelH = h;
  } catch (_) {}
}

// 提示词框（override_text）是否为「弹性」widget（有 computeLayoutSize 且无 computeSize）。
// 弹性 → 节点多余高度由它吸收，面板必须钉成固定高度；否则维持面板吸收的旧行为。
function textWidgetIsFlexible(node) {
  const tw = node.widgets?.find((w) => w.name === "override_text");
  return !!(tw && !tw.computeSize && typeof tw.computeLayoutSize === "function");
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
  header.textContent = "历史记录（最多50条，悬停看全文）";
  const list = document.createElement("div");
  list.className = "od-hp-list";
  const grip = document.createElement("div");
  grip.className = "od-hp-grip";
  grip.title = "拖拽调整面板高度";
  root.appendChild(header);
  root.appendChild(list);
  root.appendChild(grip);
  const tip = document.createElement("div");
  tip.className = "od-hp-tip";
  tip.style.display = "none";
  document.body.appendChild(tip);
  return { root, list, grip, tip };
}

// —— 面板底部手柄：单独拖拽调整面板高度 ——
// 做法：面板 +delta 的同时把节点总高 +delta → 提示词框分配额不变，只有面板变高。
// 坐标换算：clientY 增量是屏幕像素，node.size / p.h 是画布（节点）单位，需除以画布缩放。
function attachResizeGrip(node, p) {
  let dragging = false;
  let startY = 0;
  let startH = 0;
  p.grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    startY = ev.clientY;
    startH = p.h;
    try { p.grip.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  p.grip.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    ev.stopPropagation();
    const scale = app.canvas?.ds?.scale || 1;
    const want = clampPanelH(startH + (ev.clientY - startY) / scale);
    const delta = want - p.h;
    if (Math.abs(delta) < 0.5) return;
    p.h = want;
    persistPanelH(node, want);
    node.setSize([node.size[0], node.size[1] + delta]); // 总高同步 +delta，上方控件不受影响
    node.setDirtyCanvas?.(true, true);
  });
  const end = () => { dragging = false; };
  p.grip.addEventListener("pointerup", end);
  p.grip.addEventListener("pointercancel", end);
}

function attachPanel(node) {
  if (node._odHp) return; // 已挂载过
  const p = makePanel();
  node._odHp = p; // 状态与渲染共用同一对象（高度状态 p.h 必须与闭包引用一致）
  p.h = readStoredPanelH(node);
  const widget = node.addDOMWidget("0daye_histpanel", "histpanel", p.root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => PANEL_MIN,
  });
  // 面板声明「固定高度」p.h（min=max → 不参与多余高度均分）：
  // 显示层若探测到提示词框非弹性（不会吸收高度），则退回旧的弹性吸收写法，避免节点底部留空白。
  widget.computeLayoutSize = () =>
    textWidgetIsFlexible(node)
      ? { minHeight: p.h, maxHeight: p.h, minWidth: 1 }
      : { minHeight: PANEL_MIN, minWidth: 1 };
  p.widget = widget;
  attachResizeGrip(node, p);

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

// 回填：写入 override_text，并确保 mode=自动（自动下 override_text 优先级最高，输出即生效）
function fillManual(node, txt, btn) {
  const mw = node.widgets?.find((w) => w.name === "override_text");
  const md = node.widgets?.find((w) => w.name === "mode");
  if (mw) {
    mw.value = txt;
    if (typeof mw.callback === "function") {
      try { mw.callback(txt); } catch (_) {}
    }
  }
  if (md && md.value !== "自动") {
    md.value = "自动";
    if (typeof md.callback === "function") {
      try { md.callback("自动"); } catch (_) {}
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
  // 后端 executed 的 output 值为「数组」（如 {"history_list": ["..."]}），取首元素
  const raw = d.output?.history_list;
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s === "string") updatePanel(node, parseList(s));
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
      // 新建节点统一为实测默认尺寸 314×360；
      // 加载工作流走 configure（size 随后被保存值覆盖），不受影响。
      try { this.setSize([DEFAULT_W, DEFAULT_H]); } catch (_) {}
      return r;
    };

    // 加载工作流时 configure 直接赋值、不触发 onNodeCreated 的回调逻辑，需补一次 key 分配与面板高度
    const origConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      const rc = origConfigure?.apply(this, arguments);
      autoAssignKey(this);
      if (this._odHp) this._odHp.h = readStoredPanelH(this); // 恢复持久化的面板高度
      return rc;
    };
  },
});
