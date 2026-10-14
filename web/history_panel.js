// 文本缓存节点历史面板 —— comfy_0DAYE
// 节点体内「历史记录」区域：最近 50 条，每条 = 序号 + 截断文本 + 复制/回填双按钮；
// 悬停弹出完整文本；执行完成后自动刷新；history_key=-1 时写入当前节点实例 id 实现自动隔离。
// 面板为弹性布局：默认 160px，拖动节点右下角即可自然调高/调矮（DOM widget 吸收节点多余高度）。
// text 为置顶可连线端口（文本框已隐藏，省出节点区域）；override_text 文本框保留（可拖拽调高）。
import { app } from "../../../scripts/app.js";

const NODE_NAME = "TextCacheWithHistory";
const PANEL_H = 160; // 默认面板高度（px），弹性保底值
const ROW_BRIEF_MAX = 120; // 行内展示的截断长度（字符）
const RESIZABLE_INPUTS = ["override_text"]; // 可拖拽调高的输入框 widget 名（必须与后端输入 id 一致）

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
  `;
  document.head.appendChild(el);
}

// —— history_key=-1（自动）时写入当前节点实例编号 ——
function autoAssignKey(node) {
  const kw = node.widgets?.find((w) => w.name === "history_key");
  if (kw && (kw.value === -1 || kw.value === "-1")) kw.value = node.id;
}

// —— 隐藏 text 文本框，只保留置顶可连线端口（节省节点区域）——
// text 后端为可连线输入（required 组第一位 → 端口在节点最上方）。ComfyUI 原生支持 widget 隐藏
// （w.hidden=true 后节点布局跳过它，输入端口仍独立渲染），故此处直接隐藏文本框。
function hideTextWidget(node) {
  if (node.__odHidText) return;
  const w = node.widgets?.find((x) => x.name === "text");
  if (!w) return;
  w.hidden = true;
  node.__odHidText = true;
  try {
    const cs = node.computeSize?.(node.size[0]);
    if (cs && Array.isArray(cs) && cs[1] > 0) node.setSize?.(node.size[0], cs[1]);
  } catch (_) {}
  node.setDirtyCanvas?.(true, true);
}

// —— 让多行输入框（text / override_text）支持拖拽调节高度 ——
// ComfyUI 的 multiline widget 本身不绑定「拖拽同步节点高度」：textarea 有 DOM 层，
// 但 widget 逻辑高度固定，拖了不会驱动节点重排。这里给 textarea 加 CSS resize 手柄，
// 拖拽时（DOM resize 事件 + pointerup 兜底）把新高度实时写回 widget 的 computeSize，
// 再重算节点总高并重绘，使输入框区（节点上边框）高度可自由伸缩。
function makeResizableTextarea(node, wName) {
  const w = node.widgets?.find((x) => x.name === wName);
  if (!w || w.__odRz) return;
  const TA_MIN = 38; // 拖拽最小高度（px）

  const bind = () => {
    const ta = w.element;
    if (!ta || ta.tagName !== "TEXTAREA") return false; // DOM 未就绪，等下一次绘制
    ta.style.resize = "vertical";
    ta.style.overflowY = "auto";
    ta.style.minHeight = `${TA_MIN}px`;
    let base = Math.max(TA_MIN, ta.offsetHeight || 60);

    const sync = () => {
      const h = Math.max(TA_MIN, ta.offsetHeight);
      const delta = h - base;
      if (Math.abs(delta) < 2) return;
      base = h;
      const width = node.size?.[0] ?? 300;
      w.computeSize = (cw) => [cw ?? width, h + 12]; // 12 = 标题/描边余量
      if (typeof w.computeLayoutSize === "function") {
        w.computeLayoutSize = () => ({ minHeight: h + 12, minWidth: 1 });
      }
      // 重算节点高度：优先走 node.computeSize 汇总 widget 高度，失败则按增量调整
      let nh = 0;
      try {
        const cs = node.computeSize?.(node.size[0]);
        if (cs && Array.isArray(cs) && cs[1] > 0) nh = cs[1];
      } catch (_) {}
      if (!nh) nh = node.size[1] + delta;
      node.setSize?.(node.size[0], nh);
      node.setDirtyCanvas?.(true, true);
    };
    ta.addEventListener("resize", sync); // CSS resize 手柄拖拽时实时触发
    ta.addEventListener("pointerup", sync, true); // 兜底：拖拽结束再同步一次
    w.__odRz = true;
    return true;
  };

  if (!bind()) {
    // widget DOM 尚未创建（首次绘制前拿不到 element）：挂到 onDrawForeground 上重试
    const draw = node.onDrawForeground?.bind(node);
    node.onDrawForeground = function (...args) {
      draw?.apply(this, args);
      bind();
    };
  }
}

// —— 节点内绘制一行注释：说明置顶 text 端口的用途（端口名保持 text，注释可见不占布局）——
function attachTextHint(node) {
  if (node.__odHint) return;
  node.__odHint = true;
  const draw = node.onDrawForeground?.bind(node);
  node.onDrawForeground = function (ctx, ...rest) {
    draw?.apply(this, [ctx, ...rest]);
    try {
      ctx.save();
      ctx.font = "11px 'Microsoft YaHei', 'PingFang SC', sans-serif";
      ctx.fillStyle = "rgba(138,143,152,0.9)";
      // text 端口在节点最上方一行（文本框已隐藏，该行右侧空出），注释画在标题栏下该行内
      const x = this.pos[0] + 54; // 避开左侧端口 + "text" 标签
      const y = this.pos[1] + (this.title_height ?? this.titleHeight ?? 30) + 15;
      ctx.fillText("text 端口 ← 上游 LLM（静音自动回退历史）", x, y);
      ctx.restore();
    } catch (_) {}
  };
}

// —— 面板构建 ——
function makePanel() {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "od-hp";
  const header = document.createElement("div");
  header.className = "od-hp-header";
  header.textContent = "历史记录（50 条 · 悬停看全文）";
  const list = document.createElement("div");
  list.className = "od-hp-list";
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
  // 弹性保底：节点被拖高时，多余高度由本 widget 吸收（面板自然变高）
  widget.computeLayoutSize = () => ({ minHeight: PANEL_H, minWidth: 1 });
  p.widget = widget;
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
      hideTextWidget(this);
      attachTextHint(this);
      for (const n of RESIZABLE_INPUTS) makeResizableTextarea(this, n);
      return r;
    };

    // 加载工作流时 configure 直接赋值、不触发 onNodeCreated 的回调逻辑，需补一次 key 分配
    const origConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      const rc = origConfigure?.apply(this, arguments);
      autoAssignKey(this);
      hideTextWidget(this);
      attachTextHint(this);
      for (const n of RESIZABLE_INPUTS) makeResizableTextarea(this, n);
      return rc;
    };
  },
});
