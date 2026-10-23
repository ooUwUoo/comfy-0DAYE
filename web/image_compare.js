// 图像对比节点前端 viewer —— comfy_0DAYE
// 节点体内嵌预览区：A/B 两图叠加，三种对比模式（点击切换 / 划线分割 / 透明度混合）+ 交换 A/B；
// 右键菜单把 A/B 分别复制到剪贴板或保存到磁盘；信息行显示 A/B 原始分辨率（后端 ui 携带）。
//
// 架构约定（勿改坏）：
//   ① 纯 DOM widget（addDOMWidget）是双渲染引擎通用方案——不要用 LiteGraph canvas 绘制
//      （小珠光同款节点走 onDrawForeground，Nodes 2.0 的 Vue 渲染完全不走该钩子）；
//   ② 面板弹性：computeLayoutSize 只给 minHeight（两引擎同款），节点富余高度全归本 widget
//      （旧版 distributeSpace / Vue auto 行 + *:flex-1）→ 拖节点右下角图像区跟着缩放；
//      root 内联样式不得钉死 flex:none/像素高（applyRootH 只做引擎差异的最小处理）；
//   ③ 本 widget 的 computeSize 反向 getter 仅 Vue 下存在（供 node.computeSize() 累加行高，
//      值为最小总高 TOTAL_H），旧版下不存在（走 computeLayoutSize 分支）——只碰自有 widget；
//   ④ 模式/分割线位置/混合度是会话级状态（serialize:false 不入工作流 JSON）。
import { app } from "../../../scripts/app.js";
import { isVueNodes } from "./od_engine.js";

const NODE_NAME = "0DAYE_ImageCompare";
const BAR_H = 30; // 模式按钮行高（px）
const STAGE_H = 300; // 图像显示区高（px）
const INFO_H = 20; // 信息行高（px，A/B 分辨率）
const PAD_V = 8; // 上下留白
const TOTAL_H = BAR_H + STAGE_H + INFO_H + PAD_V; // DOM widget 总高
const DEFAULT_W = 340; // 新建节点默认宽
const STYLE_ID = "0daye-cmp-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    .od-cmp{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;
      padding:4px 6px;font-family:Consolas,'Microsoft YaHei',monospace;font-size:12px;color:#cfcfd6;}
    .od-cmp-bar{flex:none;display:flex;align-items:center;gap:4px;height:${BAR_H}px;}
    .od-cmp-bar button{border:1px solid #4a4a55;background:#26262d;color:#cfcfd6;border-radius:3px;
      padding:0 8px;font-size:11px;height:22px;cursor:pointer;line-height:20px;}
    .od-cmp-bar button:hover{border-color:#7a7a88;background:#33333c;}
    .od-cmp-bar button.on{border-color:#8a6; background:#2c3a26;color:#c8e6b0;}
    .od-cmp-mix{flex:1 1 auto;min-width:0;accent-color:#8a6;display:none;}
    .od-cmp-mix.show{display:block;}
    .od-cmp-stage{flex:1 1 auto;position:relative;min-height:120px;border:1px solid #33333c;
      border-radius:3px;overflow:hidden;background:#101014;
      background-image:conic-gradient(#26262d 25%,#1c1c22 0 50%,#26262d 0 75%,#1c1c22 0);
      background-size:16px 16px;}
    .od-cmp-stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;
      user-select:none;-webkit-user-drag:none;}
    .od-cmp-stage img.has{display:block;}
    .od-cmp-line{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#cfcfd6;
      box-shadow:0 0 4px rgba(0,0,0,.8);display:none;pointer-events:none;}
    .od-cmp-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      color:#6b7280;font-size:12px;}
    .od-cmp-info{flex:none;height:${INFO_H}px;line-height:20px;color:#8a8f98;font-size:11px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .od-cmp-ctx{position:fixed;z-index:99999;min-width:150px;background:#1e1e24;border:1px solid #4a4a55;
      border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.5);padding:4px 0;font-size:12px;color:#cfcfd6;
      font-family:Consolas,'Microsoft YaHei',monospace;}
    .od-cmp-ctx-item{padding:5px 14px;cursor:pointer;white-space:nowrap;}
    .od-cmp-ctx-item:hover{background:#33333c;}
    .od-cmp-ctx-sep{height:1px;background:#3a3a44;margin:3px 0;}
  `;
  document.head.appendChild(el);
}

// /view URL（官方 temp 预览惯例；apiURL 自动拼 host）
function viewURL(item) {
  const q = `filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder || "")}&type=${encodeURIComponent(item.type || "temp")}`;
  return app.api?.apiURL ? app.api.apiURL(`/view?${q}`) : `/view?${q}`;
}

// —— 构建面板 DOM ——
function makeDom() {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "od-cmp";
  const bar = document.createElement("div");
  bar.className = "od-cmp-bar";
  const mkBtn = (label, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title || label;
    return b;
  };
  const btnSplit = mkBtn("划线", "鼠标扫过图像：分界线跟随指针，左 A 右 B（默认模式）");
  const btnMix = mkBtn("混合", "透明度混合对比");
  const btnSwap = mkBtn("A ⇄ B", "交换 A 与 B（对比方向反转）");
  const mix = document.createElement("input");
  mix.type = "range";
  mix.className = "od-cmp-mix";
  mix.min = "0";
  mix.max = "100";
  mix.value = "50";
  mix.title = "B 图透明度（0=A，100=B）";
  bar.append(btnSplit, btnMix, btnSwap, mix);

  const stage = document.createElement("div");
  stage.className = "od-cmp-stage";
  const imgA = document.createElement("img");
  const imgB = document.createElement("img");
  const line = document.createElement("div");
  line.className = "od-cmp-line";
  const empty = document.createElement("div");
  empty.className = "od-cmp-empty";
  empty.textContent = "执行后显示对比图像";
  stage.append(imgA, imgB, line, empty);

  const info = document.createElement("div");
  info.className = "od-cmp-info";
  info.textContent = "执行后显示对比图像";
  root.append(bar, stage, info);
  return { root, bar, btnSplit, btnMix, btnSwap, mix, stage, imgA, imgB, line, empty, info };
}

// —— 按当前状态刷新 stage 渲染（模式/显隐/裁剪/透明度）——
function render(p) {
  const st = p.state;
  const hasA = !!(st.images && st.images.a);
  const hasB = !!(st.images && st.images.b);
  p.empty.style.display = hasA ? "none" : "flex";
  p.btnSwap.disabled = !hasB;
  p.btnSwap.style.opacity = hasB ? "" : ".4";
  p.btnSwap.textContent = st.swapped ? "B ⇄ A" : "A ⇄ B";
  p.btnSwap.classList.toggle("on", st.swapped);
  p.btnSplit.classList.toggle("on", st.mode === "split");
  p.btnMix.classList.toggle("on", st.mode === "mix");
  p.mix.classList.toggle("show", st.mode === "mix");
  p.stage.classList.toggle("split", st.mode === "split");

  p.imgA.classList.toggle("has", hasA);
  // 模式：划线=悬停时线跟随指针、线右侧露 B（默认）；混合=B 按 mix% 叠加
  const showB = hasB && (st.mode === "mix" || (st.mode === "split" && st.hover));
  p.imgB.classList.toggle("has", showB);
  p.imgB.style.clipPath = st.mode === "split" ? `inset(0 0 0 ${st.divider}%)` : "";
  p.imgB.style.opacity = st.mode === "mix" ? String(st.mix / 100) : "";
  // 分割线是纯指示器（不可交互）：仅划线模式且悬停时显示
  p.line.style.display = st.mode === "split" && st.hover ? "block" : "none";
  p.line.style.left = `${st.divider}%`;

  renderInfo(p);
}

function renderInfo(p) {
  const st = p.state;
  if (!st.images || !st.images.a) {
    p.info.textContent = "执行后显示对比图像";
    return;
  }
  const dim = (it) => (it ? `${it.orig_width}×${it.orig_height}` : "—");
  const a = st.swapped ? st.images.b : st.images.a;
  const b = st.swapped ? st.images.a : st.images.b;
  p.info.textContent = `A: ${dim(a)}${b ? `   B: ${dim(b)}${st.swapped ? "（已交换）" : ""}` : ""}`;
}

function flashInfo(p, msg) {
  const old = p.info.textContent;
  p.info.textContent = msg;
  clearTimeout(p._infoTimer);
  p._infoTimer = setTimeout(() => renderInfo(p), 1400);
}

// —— 按交换状态把图像写到 img 元素 ——
function applySources(p) {
  const st = p.state;
  const a = st.swapped ? st.images.b : st.images.a;
  const b = st.swapped ? st.images.a : st.images.b;
  if (a) p.imgA.src = viewURL(a);
  if (b) p.imgB.src = viewURL(b);
}

function setImages(node, aItem, bItem) {
  const p = node._odCmp;
  if (!p) return;
  p.state.images = { a: aItem || null, b: bItem || null };
  applySources(p);
  render(p);
}

// —— 交互绑定 ——
function bindEvents(node, p) {
  const st = p.state;
  // 面板内右键 → 自定义菜单（DOM 层事件到不了画布，画布级 getExtraMenuOptions 在图像区不触发）
  p.root.addEventListener("contextmenu", (ev) => openContextMenu(node, ev));
  p.btnSplit.addEventListener("click", (ev) => {
    ev.stopPropagation();
    st.mode = "split";
    // 光标可能已在图像上（enter 事件不会再触发）——现查 :hover 兜一帧
    st.hover = !!(st.images && st.images.a) && p.stage.matches(":hover");
    render(p);
  });
  p.btnMix.addEventListener("click", (ev) => {
    ev.stopPropagation();
    st.mode = "mix";
    render(p);
  });
  p.btnSwap.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!st.images || !st.images.b) return;
    st.swapped = !st.swapped;
    applySources(p);
    render(p);
  });
  p.mix.addEventListener("input", () => {
    st.mix = Number(p.mix.value) || 0;
    render(p);
  });
  p.mix.addEventListener("click", (ev) => ev.stopPropagation());

  // 划线（Josia 式）：分界线跟随鼠标扫过，无需拖手柄；移开图像区整幅显示 A
  p.stage.addEventListener("pointerenter", () => {
    if (st.mode === "split" && !st.hover) {
      st.hover = true;
      render(p);
    }
  });
  p.stage.addEventListener("pointerleave", () => {
    if (st.hover) {
      st.hover = false;
      render(p);
    }
  });
  p.stage.addEventListener("pointermove", (ev) => {
    if (st.mode !== "split" || !st.hover) return;
    const r = p.stage.getBoundingClientRect();
    if (r.width <= 0) return;
    const x = Math.round(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)));
    if (x !== st.divider) {
      st.divider = x;
      render(p);
    }
  });
}

// —— Vue / 旧版双形态：root 样式 + 布局回调（见文件头约定②③）——
function applyRootH(p) {
  // 弹性面板：旧版 root height:100% 由前端定高的 wrapper 撑满；
  // Vue 侧清掉内联残留，让包装层 *:flex-1 + grid auto 行自然拉伸（不能 flex:none 钉死）
  p.root.style.flex = "";
  p.root.style.height = isVueNodes() ? "" : "100%";
}

function attachCompare(node) {
  if (node._odCmp) {
    applyRootH(node._odCmp);
    return;
  }
  const p = makeDom();
  p.state = { mode: "split", divider: 50, mix: 50, swapped: false, hover: false, images: null };
  node._odCmp = p;
  const widget = node.addDOMWidget("0daye_compare", "compare", p.root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => TOTAL_H,
  });
  // 弹性布局回调（拖节点右下角 → 图像区跟着缩放）：两引擎同款规格，只给 minHeight 不给 maxHeight——
  //   旧版：本节点唯一 widget，distributeSpace 把节点富余高度全分给它（maxSize 缺省 ∞）；
  //   Vue：函数存在 → hasLayoutSize=true → auto 行随 grid 拉伸，包装层 *:flex-1 把 root 撑满。
  // （历史面板的「钉死防拉伸」教训在此反用：那边要保文本框不动、面板独占增量；这边唯一 widget
  //   就是拉伸目标，必须放开 maxSize。两处不可互相照搬。）
  Object.defineProperty(widget, "computeLayoutSize", {
    configurable: true,
    get() {
      return () => ({ minHeight: TOTAL_H, minWidth: 1 });
    },
    set() {},
  });
  Object.defineProperty(widget, "computeSize", {
    configurable: true,
    get() {
      return isVueNodes() ? (w) => [w ?? 1, TOTAL_H] : undefined;
    },
    set() {},
  });
  applyRootH(p);
  bindEvents(node, p);
  render(p);
}

// —— 剪贴板 / 保存（右键菜单回调）——
async function fetchBlob(item) {
  const r = await fetch(viewURL(item));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}
async function toPngBlob(blob) {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close?.();
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("canvas.toBlob 失败"))), "image/png"));
}
async function copyImage(node, item, tag) {
  try {
    const png = await toPngBlob(await fetchBlob(item));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    flashInfo(node._odCmp, `${tag} 已复制到剪贴板`);
  } catch (e) {
    alert(`复制 ${tag} 失败：${e.message}`);
  }
}
async function saveImage(node, item, tag) {
  try {
    const src = item.full || item; // 全分辨率文件（未下采样时=预览文件本身），带工作流元数据
    const blob = await fetchBlob(src);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = src.filename || `0DAYE_${tag}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    flashInfo(node._odCmp, `${tag} 已保存`);
  } catch (e) {
    alert(`保存 ${tag} 失败：${e.message}`);
  }
}

// —— 面板内自定义右键菜单（DOM 层，双引擎通用）——
// DOM widget 覆盖层会把右键事件吃掉，画布级 getExtraMenuOptions 在图像区不触发
//（小珠光图像画在 canvas 上所以能弹，本节点是 DOM 架构，走不了那条路）→ 面板上自制浮层菜单。
let ctxMenuEl = null;
function closeContextMenu() {
  ctxMenuEl?.remove();
  ctxMenuEl = null;
  document.removeEventListener("pointerdown", onCtxOutside, true);
  document.removeEventListener("keydown", onCtxEscape, true);
}
function onCtxOutside(ev) {
  if (ctxMenuEl && !ctxMenuEl.contains(ev.target)) closeContextMenu();
}
function onCtxEscape(ev) {
  if (ev.key === "Escape") closeContextMenu();
}
function openContextMenu(node, ev) {
  const st = node._odCmp?.state;
  if (!st?.images?.a) return; // 未执行的图：不拦截，保留浏览器原生菜单
  ev.preventDefault();
  ev.stopPropagation();
  closeContextMenu();

  const a = st.swapped ? st.images.b : st.images.a;
  const b = st.swapped ? st.images.a : st.images.b;
  const menu = document.createElement("div");
  menu.className = "od-cmp-ctx";
  const addItem = (label, fn) => {
    const it = document.createElement("div");
    it.className = "od-cmp-ctx-item";
    it.textContent = label;
    it.addEventListener("click", () => {
      closeContextMenu();
      fn();
    });
    menu.appendChild(it);
  };
  const addSep = () => {
    const s = document.createElement("div");
    s.className = "od-cmp-ctx-sep";
    menu.appendChild(s);
  };
  addItem("复制 A 到剪贴板", () => copyImage(node, a, "A"));
  addItem("保存 A 图片", () => saveImage(node, a, "A"));
  if (b) {
    addSep();
    addItem("复制 B 到剪贴板", () => copyImage(node, b, "B"));
    addItem("保存 B 图片", () => saveImage(node, b, "B"));
  }

  document.body.appendChild(menu);
  ctxMenuEl = menu;
  // 视口内钳位（先显示再量尺寸）
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - r.height - 4)}px`;
  document.addEventListener("pointerdown", onCtxOutside, true);
  document.addEventListener("keydown", onCtxEscape, true);
}

app.registerExtension({
  name: "0DAYE.ImageCompare.Viewer",

  // 执行完成：读 ui.a_images / b_images（各取第一张），刷新对应节点预览
  setup() {
    app.api.addEventListener("executed", (e) => {
      try {
        const id = e.detail?.node ?? e.detail?.display_node;
        const n = app.graph?.getNodeById?.(id);
        if (!n || (n.comfyClass !== NODE_NAME && n.type !== NODE_NAME)) return;
        const out = e.detail?.output;
        if (!out) return;
        setImages(n, out.a_images?.[0], out.b_images?.[0]);
      } catch (_) {}
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      try {
        attachCompare(this);
        // 新建默认尺寸（新前端 onNodeCreated 时 size=[0,0]，setSize 会被跳过 → 延迟一帧，SIM 同款）
        setTimeout(() => {
          if (this._odConfigured) return; // 工作流加载节点保留保存尺寸
          try { this.setSize([DEFAULT_W, TOTAL_H]); } catch (_) {}
        }, 0);
      } catch (_) {}
      return r;
    };

    // configure（加载工作流）：不自动填图（temp 预览文件可能已清），等下次执行刷新
    const origConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      this._odConfigured = true;
      const rc = origConfigure?.apply(this, arguments);
      try {
        if (this._odCmp) {
          applyRootH(this._odCmp);
          render(this._odCmp);
        }
      } catch (_) {}
      return rc;
    };

    // onAdded：graph.add 分配真实 id 后触发；重刷双形态（兼兜引擎现场切换的节点重建）
    const origOnAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      const ra = origOnAdded?.apply(this, arguments);
      try {
        if (this._odCmp) {
          applyRootH(this._odCmp);
          render(this._odCmp);
        }
      } catch (_) {}
      return ra;
    };

    // 右键菜单（节点级官方 API，非画布猴子补丁；在预览图上右键同样命中本节点菜单）：
    // A/B 分别「复制到剪贴板」+「保存图片」，未执行的图不出现对应项
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
      const st = this._odCmp?.state;
      if (!st?.images) return;
      const items = [];
      const a = st.swapped ? st.images.b : st.images.a;
      const b = st.swapped ? st.images.a : st.images.b;
      if (a) {
        items.push(
          { content: "复制 A 到剪贴板", callback: () => copyImage(this, a, "A") },
          { content: "保存 A 图片", callback: () => saveImage(this, a, "A") },
        );
      }
      if (b) {
        items.push(
          { content: "复制 B 到剪贴板", callback: () => copyImage(this, b, "B") },
          { content: "保存 B 图片", callback: () => saveImage(this, b, "B") },
        );
      }
      if (items.length) {
        options.push(...items);
      }
    };
  },
});
