// 文本缓存节点历史面板 —— comfy_0DAYE
// 节点体内「历史记录」区域：最近 50 条，每条 = 序号 + 截断文本 + 复制/回填双按钮；
// 悬停弹出完整文本；执行完成后自动刷新；history_key=-1 时写入当前节点实例 id 实现自动隔离。
// 面板高度由底部手柄单独调节（p.h，默认 160px，随工作流持久化在 node.properties.odPanelH）。
// 关键机制（勿改坏）——两套引擎两套布局体系，面板「固定高度」的实现完全不同（详见 attachPanel）：
//   LiteGraph：_arrangeWidgets/distributeSpace 在「有 computeLayoutSize 的 widget」间均分富余高度
//     → 面板钉死 computeLayoutSize min=max=p.h（不参与分配）；
//   Nodes 2.0：widget 由 CSS Grid（lg-node-widgets）渲染，行高只有 auto（hasLayoutSize=true，
//     参与富余高度均分）与 min-content（固定为内容高）两种 → 必须让 computeLayoutSize 呈现为 null
//     （hasLayoutSize=false → min-content 行）+ root 元素写死 flex:none + 像素高
//     （实测：只写 height 会被包装层 *:flex-1 的 flex:1 拉伸覆盖 → 面板锁死、文本框独吞增量）。
//   共同效果：①拖手柄 → 面板 +delta、节点总高同步 +delta → 提示词框分到 0 增量，只有面板变高；
//   ②拖节点右下角 → 面板不动、多余高度全归提示词框（原生行为）。
//   引擎设置切换【不刷新页面】（bundle 实测无 onChange/reload）→ 所有引擎判定必须现查
//   isVueNodes()、禁止按挂载时锁存（computeLayoutSize 用动态 getter 双形态呈现，见 attachPanel③）。
// text / override_text 均走新前端原生渲染：text 为纯连线端口（force_input，无文本框）。
import { app } from "../../../scripts/app.js";
import { isVueNodes, collapseFit, installCollapseFit, onEngineSwitch } from "./od_engine.js";

const NODE_NAME = "TextCacheWithHistory";
const PANEL_H = 160; // 默认面板高度（px）
const PANEL_MIN = 80; // 面板最小高度（px，拖拽手柄/节点缩放的硬下限）
const PANEL_MAX = 1000; // 面板最大高度（px，拖拽手柄上限）
const DEFAULT_W = 314; // 新建节点默认宽（按用户工作流实测尺寸）
const DEFAULT_H = 448; // 新建节点默认高（v4 多了 prefix 多行框与 trigger_text 端口，相应加高）
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
    .od-hp-header{color:#8a8f98;font-size:11px;margin-bottom:3px;flex:none;
      display:flex;align-items:center;gap:6px;}
    .od-hp-title{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .od-hp-clear{flex:none;border:1px solid #4a4a55;background:#26262d;color:#cfcfd6;
      border-radius:3px;padding:0 5px;font-size:11px;cursor:pointer;height:18px;line-height:16px;}
    .od-hp-clear:hover{border-color:#a06060;background:#3a2a2c;color:#f0d0d0;}
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

// —— 面板 root 高度：Vue 模式写死像素高，LiteGraph 模式走 height:100% 由布局层分配 ——
// Vue 的 CSS Grid 体系不消费 computeLayoutSize 数值（只看函数是否存在），
// min-content 行高 = root 元素实际高，必须在这里写死；p.h 变化时（拖手柄/configure 恢复）都要重调。
// 注意（实测踩坑）：Vue 包装层类名 *:flex-1 会给 root 加 flex:1 → 内联 height 被 flex 拉伸覆盖、
// min-content 行也算不到指定高度（表现为面板锁死、增量全被文本框吃掉）→ 必须 flex:none 让 height 生效。
// 引擎必须【每次调用现查】不能锁存：切换引擎设置不刷新页面（实测 bundle 确认 onChange 无 reload），
// 同一批节点实例会在两套引擎间往返，锁存值切引擎后必然过期。
function applyPanelRootH(p) {
  if (isVueNodes()) {
    p.root.style.flex = "none";
    p.root.style.height = `${p.h}px`;
  } else {
    p.root.style.flex = ""; // 清掉可能残留的 Vue 模式内联 flex，交给旧版布局层
    p.root.style.height = "100%";
  }
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
  const title = document.createElement("span");
  title.className = "od-hp-title";
  title.textContent = "历史记录";
  // 标题栏三个清空按钮（名称按节点上文本框的实际位置：上框=prefix、下框=override_text）：
  // 清空上/下框 = 纯显示层便利按钮，等价手动 Ctrl+A→Delete，只写 widget 值、不碰后端执行逻辑；
  // 清空历史 = 调后端 API 清当前节点抽屉（内存+持久化文件同步）。
  const mkClear = (label, tip) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "od-hp-clear";
    b.textContent = label;
    b.title = tip;
    return b;
  };
  const clearTopBtn = mkClear("清空上框", "一键清空 prefix 触发词前缀框");
  const clearBottomBtn = mkClear("清空下框", "一键清空 override_text（恢复 text 直通 / 静音走历史）");
  const clearHistBtn = mkClear("清空历史", "清空本节点的历史记录（含持久化文件，不可恢复）");
  header.appendChild(title);
  header.appendChild(clearTopBtn);
  header.appendChild(clearBottomBtn);
  header.appendChild(clearHistBtn);
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
  return { root, list, grip, tip, clearTopBtn, clearBottomBtn, clearHistBtn };
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
    applyPanelRootH(p); // 引擎可能已被现场切换（不刷新页面），拖前刷新 root 样式并清残留
    try { p.grip.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  p.grip.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    ev.stopPropagation();
    const scale = app.canvas?.ds?.scale || 1;
    // 取整：避免小数高度在连续 move 事件中累积漂移（节点高度与面板 min 的差值会被弹性控件吃掉）
    const want = Math.round(clampPanelH(startH + (ev.clientY - startY) / scale));
    const delta = want - p.h;
    if (Math.abs(delta) < 0.5) return;
    p.h = want;
    persistPanelH(node, want);
    applyPanelRootH(p); // Vue 模式同步 root 像素高（LiteGraph 由 computeLayoutSize 钉死，无需处理）
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
  // 双引擎面板高度策略（两套布局体系，机制完全不同，勿混用，见文件头注释）：
  // ① LiteGraph：_arrangeWidgets → distributeSpace 把节点富余高度在「有 computeLayoutSize 的
  //    widget」间按 (minSize, maxSize 缺省 ∞) 均分。面板必须钉死 min=max=p.h（remaining=0 不参与
  //    分配）→ 拖手柄时节点 +delta 恰被面板 min 增量吃掉，文本框分配额不变。
  //    勿回退为「探测 override_text 是否弹性再决定钉/不钉」的旧写法（textWidgetIsFlexible 已删）：
  //    override_text 转输入端口后无 computeLayoutSize，探测必然失败 → 面板 maxSize=∞ → 均分回归。
  // ② Nodes 2.0（实测踩坑，2026-10-17）：widget 由 CSS Grid 渲染，与 distributeSpace 完全脱钩——
  //    行高判定 = (shouldExpand(类型白名单) || hasLayoutSize) ? auto : min-content，其中
  //    hasLayoutSize = typeof computeLayoutSize === "function"（只看函数存在与否，数值不被消费；
  //    实测钉死 min=max 时 p.h 涨 358 而面板 DOM 只涨 100，均分照旧）。正解：让该属性呈现为 null
  //    → hasLayoutSize=false → 面板行变 min-content（= root 写死的像素高），拖手柄时节点 +delta
  //    恰被这一行吃掉 → auto 行（prefix/override_text）分到 0 增量，输入框不再跟着拉伸。
  // ③ 引擎可【不刷新页面】随时切换（设置项无 onChange/reload，实测 bundle 确认），同一批节点
  //    实例会往返两套引擎 → 此属性绝不能按挂载时的引擎锁存。用 getter 动态呈现：
  //    Vue 布局每次渲染 typeof 检查拿到 null（min-content），LiteGraph 每次 arrange 拿到钉死
  //    函数（消费数值），两边各自在布局时现查 isVueNodes()，天然随引擎切换自愈。
  let lastLayoutSize = null;
  Object.defineProperty(widget, "computeLayoutSize", {
    configurable: true,
    get() {
      if (!isVueNodes()) {
        lastLayoutSize = () => ({ minHeight: p.h, maxHeight: p.h, minWidth: 1 });
      } else {
        lastLayoutSize = null;
      }
      return lastLayoutSize;
    },
    set() {}, // 本插件独占该 widget 实例，吞掉外部赋值，保证引擎分支不被覆盖
  });
  // 反向配套：Vue 下面板 computeLayoutSize 呈现为 null，node.computeSize()（折叠收缩的尺寸
  // 来源）会把它按 26px 兜底而不是实际 p.h → 收缩会裁掉面板。给 computeSize 也做双形态：
  // Vue 下返回 [w, p.h]（computeSize 循环 t += p.h，与旧版经 computeLayoutSize 的 min 同值），
  // 旧版下不存在（走 computeLayoutSize 分支，现有布局逻辑原样）。
  // 安全性：仅覆写自有面板 widget（勿碰其它 widget 的该回调是既定教训），返回值只依赖 p.h
  // 常量态，且该回调仅被 node.computeSize() 消费，不影响 Vue 的 CSS Grid 行高（那套只看
  // computeLayoutSize 是否为函数）。
  Object.defineProperty(widget, "computeSize", {
    configurable: true,
    get() {
      if (isVueNodes()) return (w) => [w ?? 1, p.h];
      return undefined;
    },
    set() {},
  });
  applyPanelRootH(p);
  p.widget = widget;
  attachResizeGrip(node, p);
  p.clearTopBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    clearBox(node, p.clearTopBtn, "prefix");
  });
  p.clearBottomBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    clearBox(node, p.clearBottomBtn, "override_text");
  });
  p.clearHistBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    clearHistory(node, p.clearHistBtn);
  });

  updatePanel(node, []);
  refreshHistory(node); // 持久化历史：新建/加载后直接恢复显示（无需先执行一次）
}

// —— 渲染 ——
function updatePanel(node, entries) {
  const p = node._odHp;
  if (!p) return;
  p.list.textContent = "";
  if (!entries.length) {
    const e = document.createElement("div");
    e.className = "od-hp-empty";
    e.textContent = "（暂无历史：运行一次后自动显示；最多 50 条，悬停看全文）";
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

// 一键清空指定多行文本框（prefix / override_text）：与手动 Ctrl+A→Delete 结果完全相同
//（仅写 widget 值，不碰执行逻辑）。若该 widget 已被拖成连线端口且接了线，
// 运行值来自连线、清空文本框无意义，提示用户删线。
function clearBox(node, btn, widgetName) {
  const linked = node.inputs?.some((i) => i.name === widgetName && i.link != null);
  if (linked) {
    flash(btn, "请先删线");
    return;
  }
  const w = node.widgets?.find((x) => x.name === widgetName);
  if (w) {
    w.value = "";
    if (typeof w.callback === "function") {
      try { w.callback(""); } catch (_) {}
    }
  }
  try { node.setDirtyCanvas(true, true); } catch (_) {}
  flash(btn, "已清空");
}

// 清空历史：调后端 API 清当前节点抽屉（内存 + 持久化文件同步），成功后清空面板显示。
// 后端 execute 是类方法拿不到实例，清空只能走 HTTP 路由；JS 失败时历史仍在、不影响执行。
async function clearHistory(node, btn) {
  const kw = node.widgets?.find((w) => w.name === "history_key");
  const key = kw ? Number(kw.value) : -1;
  if (!window.confirm(`确定清空本节点的历史记录吗？（history_key=${key}，不可恢复）`)) return;
  try {
    const r = await app.api.fetchApi("/comfy_0DAYE/text_cache/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!r.ok) throw new Error(String(r.status));
    updatePanel(node, []);
    flash(btn, "已清空");
  } catch (_) {
    flash(btn, "清空失败");
  }
}

// 拉取本节点抽屉的持久化历史并刷新面板：重启/加载工作流后无需执行即可恢复显示。
// 失败静默（后端旧版本无此路由时退回空面板，执行后由 executed 事件正常刷新）。
async function refreshHistory(node) {
  const kw = node.widgets?.find((w) => w.name === "history_key");
  const key = kw ? Number(kw.value) : -1;
  try {
    const r = await app.api.fetchApi(`/comfy_0DAYE/text_cache/list?key=${encodeURIComponent(key)}`);
    if (!r.ok) return;
    const d = await r.json();
    if (typeof d?.history_list === "string") updatePanel(node, parseList(d.history_list));
  } catch (_) {}
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

// —— V1 config 的 advanced 折叠标记兜底（实测踩坑，勿删）——
// 后端 text_cache.py 已给 4 个控件声明 advanced=True（/object_info 里也确实携带），
// 但新前端（1.55.x）把 V1 nodeData 转成内部 V2 规格时对本节点会丢失该标记
// （实测 SI 同构 config 落到 widget.options.advanced=true，TC 却变 false，根因在前端转换层）。
// 因此这里按后端定义硬编码补写：options.advanced（对齐正常路径）+ _visibility.surfaces
// （可见性判定实际消费的即时状态；仅改 options 不重算可见性，实测无效）。
// surfaces 三面的消费方不同（bundle 实挖，勿乱改）：
//   vueNode = Vue 节点画布折叠（isWidgetVisible / processWidget 消费）→ 写 'advanced'；
//   panel   = Vue 设置面板 → 写 'advanced' 保持一致；
//   canvas  = 旧版画布命中测试（getWidgetOnPos → node.isWidgetVisible 消费）→ 必须保持
//             'shown'！若也写 'advanced'，旧版（showAdvanced 恒 false）这 4 个控件会
//             「画得出但点不动」（绘制不走可见性判定，命中测试走）。
// deriveWidgetSurfaces 的 canvas 面只读顶层 w.advanced（不读 options.advanced），
// 故不动 _visibility.surfaces.canvas 时旧版天然平铺可点，与「LiteGraph 全平铺零副作用」一致。
// 与后端 advanced=True 清单保持一致：mode、prefix、history_key、history_index。
const ADV_WIDGETS = ["mode", "prefix", "history_key", "history_index"];
function applyAdvancedFallback(node) {
  for (const nm of ADV_WIDGETS) {
    const w = node.widgets?.find((x) => x.name === nm);
    if (!w) continue;
    if (w.options) w.options.advanced = true;
    const vis = w._visibility ?? w.visibility;
    if (vis?.surfaces) {
      vis.surfaces.canvas = "shown";
      vis.surfaces.vueNode = "advanced";
      vis.surfaces.panel = "advanced";
    }
  }
}

app.registerExtension({
  name: "0DAYE.TextCacheHistoryPanel",

  // 引擎现场切换（不刷新页面）：切到 Vue → 本类折叠态节点统一收缩（否则保留旧版全平铺
  // 高度、中部大片空白）；切回旧版 → 撑回全高（否则平铺控件被折叠态短高度裁掉）。
  setup() {
    onEngineSwitch((vue) => {
      for (const n of app.graph?._nodes ?? []) {
        if (n?.comfyClass !== NODE_NAME && n?.type !== NODE_NAME) continue;
        try {
          if (n._odHp) applyPanelRootH(n._odHp); // root 像素高/flex 按新引擎重刷
          if (vue) collapseFit(n); // 内部已守卫：展开态/整节点折叠不动作
          else n.expandToFitContent?.();
        } catch (_) {}
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      autoAssignKey(this);
      attachPanel(this);
      applyAdvancedFallback(this);
      // 新建节点统一为实测默认尺寸 314×360；
      // 加载工作流走 configure（size 随后被保存值覆盖），不受影响。
      try { this.setSize([DEFAULT_W, DEFAULT_H]); } catch (_) {}
      // 折叠态高度自适应（仅 Nodes 2.0）：新建即收缩到折叠态实际高度（4 项 advanced 折叠
      // 后约省 100px）；同步先收一次，延迟一帧再收一次（双保险，SIM 同款）；工作流加载走
      // configure（先清 _odCreatePending）→ 延迟收缩跳过，保存尺寸不动。
      installCollapseFit(this);
      collapseFit(this);
      this._odCreatePending = true;
      setTimeout(() => {
        if (this._odCreatePending) {
          this._odCreatePending = false;
          collapseFit(this);
        }
      }, 0);
      return r;
    };

    // LiteGraph 原生创建路径（LiteGraph.createNode）在构造期触发 onNodeCreated，
    // 此时 node.id 尚未由 graph.add 分配（恒为 -1）→ autoAssignKey 写入无效；
    // graph.add 分配真实 id 后会触发 onAdded，在此补一次 key 分配（双引擎通用，无需分支）。
    // 顺带刷新引擎相关显示状态：引擎设置可【不刷新页面】随时切换（bundle 实测无 onChange/reload），
    // 若切换伴随节点重建（graph.add），此处会按当前引擎重刷面板 root 样式与 advanced surfaces；
    // applyPanelRootH / applyAdvancedFallback 均幂等，重复调用无副作用。
    const origOnAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      const ra = origOnAdded?.apply(this, arguments);
      autoAssignKey(this);
      if (this._odHp) applyPanelRootH(this._odHp);
      applyAdvancedFallback(this);
      installCollapseFit(this); // 幂等；兼兜引擎现场切换伴随的节点重建
      return ra;
    };

    // 加载工作流时 configure 直接赋值、不触发 onNodeCreated 的回调逻辑，需补一次 key 分配与面板高度
    const origConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      this._odCreatePending = false; // 工作流加载：取消延迟收缩，保存尺寸优先
      const rc = origConfigure?.apply(this, arguments);
      autoAssignKey(this);
      if (this._odHp) {
        this._odHp.h = readStoredPanelH(this); // 恢复持久化的面板高度
        applyPanelRootH(this._odHp); // Vue 模式 root 像素高随 p.h 恢复
      }
      applyAdvancedFallback(this);
      installCollapseFit(this); // 只装访问器不收缩：加载节点尊重保存尺寸，后续手动折叠才收缩
      refreshHistory(this); // configure 后 widget 值（含 history_key）已就位，再拉一次历史
      return rc;
    };
  },
});
