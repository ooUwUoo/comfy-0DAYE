// 图像缓存预览节点前端面板 —— comfy_0DAYE
// 节点体内：大图预览区 + 历史缩略图条 + 操作栏。
// 缩略图条按容器宽度自适应每页数量（拖节点边框实时增减），操作栏提供
// 「最新页/上一页/下一页/最旧页」翻页、「上一张/下一张」单图导航与「清空」。
// 新图到达时强制回到最新（第 1 页、第 1 张）。
//
// 架构约定（勿改坏，与 image_compare.js 同源）：
//   ① 纯 DOM widget（addDOMWidget）双渲染引擎通用；不要用 LiteGraph canvas 绘制
//      （Nodes 2.0 的 Vue 渲染完全不走 onDrawForeground）；
//   ② 面板弹性：computeLayoutSize 只给 minHeight —— 旧版 distributeSpace 把节点富余
//      高度全给本 widget（maxSize 缺省 ∞），Vue 下函数存在 → auto 行随 grid 拉伸 +
//      包装层 *:flex-1 撑满；root 内联样式不得钉死 flex:none/像素高；
//   ③ computeSize 反向 getter 仅 Vue 下存在（供 node.computeSize 累加行高）；
//   ④ 图片走本插件自定义路由 /comfy_0DAYE/image_cache/view（官方 /view 只认
//      output/temp/input，读不到 user/0DAYE 缓存目录）；
//   ⑤ 索引顺序：后端 drawers 恒为「最新在前」，故 index 0 = 最新一张；
//      缩略图条内按 index 升序渲染（左新右旧），与「上一张=更新、下一张=更旧」的
//      时间轴直觉一致。
import { app } from "../../../scripts/app.js";
import { isVueNodes, installCollapseFit } from "./od_engine.js";

const NODE_NAME = "0DAYE_ImageCachePreview";
const THUMB_W = 56; // 缩略图边长（px）
const THUMB_H = 56;
const THUMB_GAP = 4; // 缩略图间距
const THUMB_ROW_H = THUMB_H + 8; // 缩略图条总高（含上下留白）
const PAGER_H = 30; // 操作栏高（px，窄节点换行时自然增高）
const STAGE_MIN = 160; // 大图区最小高
const PAD_V = 8; // 上下留白
const GAP = 8; // flex gap 总和（gap:4px × 2 个间距）
const TOTAL_MIN = STAGE_MIN + THUMB_ROW_H + PAGER_H + PAD_V; // 正常态 DOM widget 最小总高
// 内容绝对最小高（stage 收缩到 0 时）：旧版 distributeSpace 用此值作为 minHeight，
// 避免用户拖小节点到 < TOTAL_MIN 时 _arrangeWidgets 把节点自动撑回 TOTAL_MIN 导致跳动错位
const MIN_CONTENT = THUMB_ROW_H + PAGER_H + PAD_V + GAP;

// —— advanced 折叠兜底（与 save_image_metadata.js 同款机制，实测踩坑勿删）——
// 后端已给 history_key/store_full_image 声明 advanced=True，但新前端 V1→V2 转换层可能丢标记；
// 补写 options.advanced + _visibility.surfaces（canvas 面必须保持 'shown'，否则旧版画得出点不动）。
const ADV_WIDGETS = ["history_key", "store_full_image"];
function applyAdvancedFallback(node) {
  for (const name of ADV_WIDGETS) {
    const w = node?.widgets?.find((x) => x?.name === name);
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
const DEFAULT_W = 360; // 新建节点默认宽
const DEFAULT_H = 430; // 新建节点默认高
const STYLE_ID = "0daye-icp-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    .od-icp{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;
      padding:4px 6px;font-family:Consolas,'Microsoft YaHei',monospace;font-size:12px;color:#cfcfd6;
      overflow:hidden;min-width:0;}
    /* 旧版界面拖小节点时空间不足：放开大图区最小高，内容裁剪在节点框内（防穿插到框外） */
    .od-icp.tiny .od-icp-stage{min-height:0;}
    .od-icp-stage{flex:1 1 auto;position:relative;min-height:${STAGE_MIN}px;border:1px solid #33333c;
      border-radius:3px;overflow:hidden;background:#101014;
      background-image:conic-gradient(#26262d 25%,#1c1c22 0 50%,#26262d 0 75%,#1c1c22 0);
      background-size:16px 16px;}
    .od-icp-stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;
      user-select:none;-webkit-user-drag:none;}
    .od-icp-badge{position:absolute;right:4px;bottom:4px;padding:0 5px;border-radius:3px;
      background:rgba(12,12,16,.72);color:#cfcfd6;font-size:11px;line-height:16px;display:none;
      pointer-events:none;}
    .od-icp-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      color:#6b7280;font-size:12px;}
    .od-icp-thumbs{flex:none;height:${THUMB_ROW_H}px;display:flex;align-items:center;gap:${THUMB_GAP}px;
      overflow:hidden;padding:0 1px;}
    .od-icp-thumbs:empty{visibility:hidden;}
    .od-icp-thumb{flex:none;width:${THUMB_W}px;height:${THUMB_H}px;border:1px solid #3a3a44;border-radius:2px;
      overflow:hidden;cursor:pointer;box-sizing:border-box;background:#1c1c22;}
    .od-icp-thumb:hover{border-color:#7a7a88;}
    .od-icp-thumb.on{border-color:#8a6;box-shadow:0 0 0 1px #8a6 inset;}
    .od-icp-thumb img{width:100%;height:100%;object-fit:cover;display:block;user-select:none;
      -webkit-user-drag:none;}
    .od-icp-pager{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:4px;
      min-height:${PAGER_H}px;}
    .od-icp-pager button{flex:none;border:1px solid #4a4a55;background:#26262d;color:#cfcfd6;
      border-radius:3px;padding:0 6px;font-size:11px;height:22px;line-height:20px;cursor:pointer;}
    .od-icp-pager button:hover:not(:disabled){border-color:#7a7a88;background:#33333c;}
    .od-icp-pager button:disabled{opacity:.35;cursor:default;}
    .od-icp-pager button.danger:hover{border-color:#a06060;background:#3a2a2c;color:#f0d0d0;}
    .od-icp-page{flex:none;min-width:34px;text-align:center;color:#8a8f98;font-size:11px;}
    .od-icp-sep{flex:none;width:1px;height:14px;background:#3a3a44;margin:0 2px;}
    .od-icp-ctx{position:fixed;z-index:99999;min-width:150px;background:#1e1e24;border:1px solid #4a4a55;
      border-radius:4px;padding:3px 0;box-shadow:0 4px 16px rgba(0,0,0,.5);
      font-family:Consolas,'Microsoft YaHei',monospace;font-size:12px;color:#cfcfd6;}
    .od-icp-ctx-item{padding:5px 14px;cursor:pointer;white-space:nowrap;}
    .od-icp-ctx-item:hover{background:#33333c;}
  `;
  document.head.appendChild(el);
}

// 缓存图片 URL（自定义路由，见 image_cache_preview.py 注释）
function viewURL(id, kind) {
  const q = `id=${encodeURIComponent(id)}&kind=${kind}`;
  return app.api?.apiURL
    ? app.api.apiURL(`/comfy_0DAYE/image_cache/view?${q}`)
    : `/comfy_0DAYE/image_cache/view?${q}`;
}

// —— 构建面板 DOM ——
function makeDom() {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "od-icp";

  const stage = document.createElement("div");
  stage.className = "od-icp-stage";
  const big = document.createElement("img");
  const badge = document.createElement("div");
  badge.className = "od-icp-badge";
  const empty = document.createElement("div");
  empty.className = "od-icp-empty";
  empty.textContent = "执行后显示图像";
  stage.append(big, badge, empty);

  const thumbs = document.createElement("div");
  thumbs.className = "od-icp-thumbs";

  const pager = document.createElement("div");
  pager.className = "od-icp-pager";
  const mkBtn = (label, title, act) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title || label;
    b.dataset.act = act;
    return b;
  };
  const btnNewest = mkBtn("⏮", "跳到最新一页（第 1 页）", "newest");
  const btnPrevPage = mkBtn("‹", "上一页（更新的图）", "prevpage");
  const pageLabel = document.createElement("span");
  pageLabel.className = "od-icp-page";
  pageLabel.textContent = "1/1";
  const btnNextPage = mkBtn("›", "下一页（更旧的图）", "nextpage");
  const btnOldest = mkBtn("⏭", "跳到最旧一页（最后一页）", "oldest");
  const sep = document.createElement("span");
  sep.className = "od-icp-sep";
  const btnPrevImg = mkBtn("◀ 上一张", "上一张（更新的一张，跨页自动翻页）", "previmg");
  const btnNextImg = mkBtn("下一张 ▶", "下一张（更旧的一张，跨页自动翻页）", "nextimg");
  const btnClear = mkBtn("清空", "清空本节点的历史记录（仅清除本节点列表，不影响其它节点）", "clear");
  btnClear.classList.add("danger");
  pager.append(btnNewest, btnPrevPage, pageLabel, btnNextPage, btnOldest, sep,
    btnPrevImg, btnNextImg, btnClear);

  root.append(stage, thumbs, pager);
  return {
    root, stage, big, badge, empty, thumbs, pager,
    btnNewest, btnPrevPage, btnNextPage, btnOldest, btnPrevImg, btnNextImg, btnClear, pageLabel,
  };
}

// —— 每页容量：按面板 root 实际宽度计算 ——
// 基准用 root（宽度由 applyRootH 钉在节点框内）而非 thumbs.clientWidth——
// 若读被内容撑宽的 thumbs，会形成「越宽越多、越多越宽」的恶性循环（2026-10-25 横向穿出根因之一）
function calcPerPage(p) {
  const w = (p.root?.clientWidth || 0) - 12; // 扣 root 横向 padding 6+6
  if (w <= 0) return p.state.perPage || 6; // Vue 尚未挂载时兜底
  return Math.max(1, Math.floor((w + THUMB_GAP) / (THUMB_W + THUMB_GAP)));
}

function pageCount(st) {
  return Math.max(1, Math.ceil(st.items.length / st.perPage));
}

function pageOfIndex(index, perPage) {
  return Math.floor(Math.max(0, index) / perPage);
}

// —— 渲染：大图 ——
function renderBig(p) {
  const st = p.state;
  const total = st.items.length;
  const has = total > 0;
  p.empty.style.display = has ? "none" : "flex";
  p.big.style.display = has ? "block" : "none";
  p.badge.style.display = has ? "block" : "none";
  if (!has) {
    p.big.dataset.gid = "";
    p.big.removeAttribute("src");
    return;
  }
  const idx = Math.max(0, Math.min(total - 1, st.index));
  st.index = idx;
  const it = st.items[idx];
  if (it) {
    // gid 唯一且文件不再变化 → 同一 gid 不重复设 src（避免重复解码）
    if (p.big.dataset.gid !== it.id) {
      p.big.dataset.gid = it.id;
      p.big.src = viewURL(it.id, "preview");
    }
    p.badge.textContent = `${idx + 1}/${total}`;
  }
}

// —— 渲染：全量（大图 + 缩略图条 + 操作栏）——
function render(p) {
  renderBig(p);
  renderThumbs(p);
  renderPager(p);
}

// —— 只更新缩略图选中描边（同页内点选时避免整条重建造成闪烁）——
function markSelected(p) {
  for (const el of p.thumbs.children) {
    el.classList.toggle("on", Number(el.dataset.idx) === p.state.index);
  }
}

// —— 渲染：缩略图条（只渲染当前页；页内按 index 升序 = 左新右旧）——
function renderThumbs(p) {
  const st = p.state;
  p.thumbs.textContent = "";
  const total = st.items.length;
  if (!total) return;
  const start = st.page * st.perPage;
  const end = Math.min(total, start + st.perPage);
  for (let i = start; i < end; i++) {
    const it = st.items[i];
    const box = document.createElement("div");
    box.className = "od-icp-thumb";
    box.dataset.idx = String(i);
    box.title = `第 ${i + 1} 张（${it.w}×${it.h}）· 点击显示大图`;
    if (i === st.index) box.classList.add("on");
    const im = document.createElement("img");
    im.src = viewURL(it.id, "thumb");
    im.loading = "lazy";
    im.draggable = false;
    box.appendChild(im);
    box.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    box.addEventListener("contextmenu", (ev) => openContextMenu(p, ev, it));
    box.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const np = pageOfIndex(i, st.perPage);
      st.index = i;
      if (np === st.page) {
        // 同页点选：只换大图与描边，不重建缩略图（避免重载闪烁）
        renderBig(p);
        markSelected(p);
        renderPager(p);
      } else {
        st.page = np;
        render(p);
      }
    });
    p.thumbs.appendChild(box);
  }
}

// —— 渲染：操作栏状态 ——
function renderPager(p) {
  const st = p.state;
  const total = st.items.length;
  const pages = pageCount(st);
  const noItems = total === 0;
  p.pageLabel.textContent = `${st.page + 1}/${pages}`;
  p.btnNewest.disabled = noItems || st.page === 0;
  p.btnPrevPage.disabled = noItems || st.page <= 0;
  p.btnNextPage.disabled = noItems || st.page >= pages - 1;
  p.btnOldest.disabled = noItems || st.page >= pages - 1;
  p.btnPrevImg.disabled = noItems || st.index <= 0; // 上一张 = 更新
  p.btnNextImg.disabled = noItems || st.index >= total - 1; // 下一张 = 更旧
  p.btnClear.disabled = noItems;
}

// —— 视图状态同步入口：替换条目列表（新图/加载恢复/清空共用）——
function setItems(node, items, keepIndex) {
  const p = node._odIcp;
  if (!p) return;
  const st = p.state;
  st.items = Array.isArray(items) ? items : [];
  st.perPage = calcPerPage(p);
  if (!keepIndex) {
    st.index = 0; // 最新在前 → 0 = 最新一张
    st.page = 0;
  } else if (st.items.length) {
    st.index = Math.max(0, Math.min(st.items.length - 1, st.index));
    st.page = pageOfIndex(st.index, st.perPage);
  } else {
    st.index = 0;
    st.page = 0;
  }
  render(p);
}

// —— 翻页：同步把大图切到该页（页内 index 最小者 = 该页最新一张）——
function gotoPage(p, page) {
  const st = p.state;
  const pages = pageCount(st);
  st.page = Math.max(0, Math.min(pages - 1, page));
  if (st.items.length) {
    const start = st.page * st.perPage;
    st.index = Math.min(st.items.length - 1, start);
  }
  render(p);
}

// —— 单图导航（跨页自动翻页）——
function gotoIndex(p, index) {
  const st = p.state;
  if (!st.items.length) return;
  st.index = Math.max(0, Math.min(st.items.length - 1, index));
  st.page = pageOfIndex(st.index, st.perPage);
  render(p);
}

// —— 右键菜单：打开 / 复制 / 保存（对齐原生预览节点；DOM 层自制，双引擎通用）——
// DOM widget 覆盖层会吃掉右键事件，画布级 getExtraMenuOptions 在图像区不触发（同 image_compare 的教训）。
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

async function fetchBlob(id, kind) {
  const r = await fetch(viewURL(id, kind || "preview"));
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
function flashInfo(p, msg) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText =
    "position:absolute;left:6px;top:6px;padding:2px 8px;border-radius:3px;" +
    "background:rgba(12,12,16,.85);color:#cfcfd6;font-size:11px;z-index:5;pointer-events:none;";
  p.stage.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function openImage(it) {
  // f=1 → 全分辨率原图 PNG；轻量模式无 → 1024px 预览图
  window.open(viewURL(it.id, it.f ? "full" : "preview"), "_blank");
}
async function copyImage(p, it) {
  try {
    // 优先原图像素；轻量模式降级为预览图（剪贴板本身不携带 PNG 元数据）
    const png = await toPngBlob(await fetchBlob(it.id, it.f ? "full" : "preview"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    flashInfo(p, it.f ? "已复制原图到剪贴板" : "已复制预览图（轻量模式）");
  } catch (e) {
    alert(`复制失败：${e.message}`);
  }
}
async function saveImage(p, it) {
  try {
    // full = 全分辨率 PNG（内嵌 prompt/workflow 元数据，拖回 ComfyUI 可恢复工作流）；
    // 轻量模式无 full → 保存 1024px 预览图（同样内嵌 CivitAI 参数串，C 站可读）
    const kind = it.f ? "full" : "preview";
    const blob = await fetchBlob(it.id, kind);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `0DAYE_cache_${it.id}.${blob.type === "image/png" ? "png" : "jpg"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    flashInfo(p, it.f ? "已保存原图（含工作流元数据）" : "已保存预览图（轻量模式，含 CivitAI 参数）");
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}
// 打开文件管理器并定位选中该缓存文件（优先全分辨率原图，轻量模式降级为预览图）
async function revealImage(it) {
  try {
    const r = await app.api.fetchApi("/comfy_0DAYE/image_cache/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, kind: it.f ? "full" : "preview" }),
    });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    alert(`打开图片路径失败：${e.message}`);
  }
}

// it：右键命中的条目（大图当前张或某张缩略图）；无图时不拦截，保留默认行为
function openContextMenu(p, ev, it) {
  if (!it) return;
  ev.preventDefault();
  ev.stopPropagation();
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "od-icp-ctx";
  const addItem = (label, fn) => {
    const el = document.createElement("div");
    el.className = "od-icp-ctx-item";
    el.textContent = label;
    el.addEventListener("click", () => {
      closeContextMenu();
      fn();
    });
    menu.appendChild(el);
  };
  addItem("打开图像", () => openImage(it));
  addItem("复制图像", () => copyImage(p, it));
  addItem("保存图像", () => saveImage(p, it));
  addItem("打开图片路径", () => revealImage(it));
  document.body.appendChild(menu);
  ctxMenuEl = menu;
  // 视口内钳位（先显示再量尺寸）
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - r.height - 4)}px`;
  document.addEventListener("pointerdown", onCtxOutside, true);
  document.addEventListener("keydown", onCtxEscape, true);
}

// —— 面板 root 尺寸 ——
// 高度：Vue 清内联（交给 grid 拉伸），旧版 height:100%（布局层分配）。
// 宽度（2026-10-25 横向穿出修复）：旧版 canvas 只给 widget element 设 left/top、不设宽，
// absolute 元素 shrink-to-fit → root 被缩略图条 min-content（每页数量×60px）撑宽、向右穿出节点框；
// 且 calcPerPage 读撑宽后的 clientWidth → perPage 越算越多 → 恶性循环。这里按节点宽显式钉住
// （widget 区 = 节点宽 − 左右各 15px 内缩），随 onResize 同步；Vue 下由布局层约束，不钉。
const SIDE_PAD = 15;
function applyRootH(p) {
  p.root.style.flex = "";
  const vue = isVueNodes();
  p.root.style.height = vue ? "" : "100%";
  if (!vue) {
    const w = p.node?.size?.[0];
    if (w > 0) {
      const px = Math.max(120, w - SIDE_PAD * 2);
      if (p._lastW !== px) { p._lastW = px; p.root.style.width = px + "px"; } // 同值不写，防每帧触发重排
    }
  } else if (p._lastW != null) {
    p._lastW = null; p.root.style.width = "";
  }
}

// —— 交互绑定 ——
function bindEvents(node, p) {
  const st = p.state;
  // 大图区/缩略图右键 → 自定义菜单；其余区域（操作栏）拦截默认菜单避免打断操作
  p.stage.addEventListener("contextmenu", (ev) => {
    const it = st.items[st.index];
    if (it) openContextMenu(p, ev, it);
    else { ev.preventDefault(); ev.stopPropagation(); } // 无图：不弹菜单也不放给浏览器
  });
  p.root.addEventListener("contextmenu", (ev) => {
    if (ev.target.closest(".od-icp-thumb")) return; // 缩略图自己的 contextmenu 已处理
    if (ev.target.closest(".od-icp-stage")) return; // 大图区已处理
    ev.preventDefault();
    ev.stopPropagation();
  });
  p.btnNewest.addEventListener("click", (ev) => {
    ev.stopPropagation();
    gotoPage(p, 0);
  });
  p.btnOldest.addEventListener("click", (ev) => {
    ev.stopPropagation();
    gotoPage(p, pageCount(st) - 1);
  });
  p.btnPrevPage.addEventListener("click", (ev) => {
    ev.stopPropagation();
    gotoPage(p, st.page - 1);
  });
  p.btnNextPage.addEventListener("click", (ev) => {
    ev.stopPropagation();
    gotoPage(p, st.page + 1);
  });
  p.btnPrevImg.addEventListener("click", (ev) => {
    ev.stopPropagation();
    gotoIndex(p, st.index - 1); // 更新
  });
  p.btnNextImg.addEventListener("click", (ev) => {
    ev.stopPropagation();
    gotoIndex(p, st.index + 1); // 更旧
  });
  p.btnClear.addEventListener("click", (ev) => {
    ev.stopPropagation();
    clearHistory(node);
  });
  // 节点尺寸变化 → 每页容量实时增减（拖边框/缩放均触发）；
  // 同时检测高度：空间不足时放开大图区最小高（tiny），内容裁在节点框内——
  // 旧版界面手动拖小节点时 widget 区域可小于 TOTAL_MIN，不降级会让内容穿插到框外
  if (typeof ResizeObserver === "function") {
    p.obs = new ResizeObserver(() => {
      const np = calcPerPage(p);
      if (np !== st.perPage) {
        st.perPage = np;
        st.page = pageOfIndex(st.index, np); // 保持大图仍可见（页号随容量重算）
        render(p);
      }
      const tiny = p.root.clientHeight > 0
        && p.root.clientHeight < TOTAL_MIN + GAP; // < 内容实际最小高 → 放开 stage min-height 防溢出
      if (tiny !== p.root.classList.contains("tiny")) p.root.classList.toggle("tiny", tiny);
    });
    p.obs.observe(p.root);
  }
}

// —— 拉取本节点抽屉索引（加载工作流/重启后面板直接恢复，无需先执行）——
function keyOf(node) {
  const kw = node.widgets?.find((w) => w.name === "history_key");
  const n = kw ? Number(kw.value) : -1;
  return Number.isFinite(n) ? n : -1;
}

function autoAssignKey(node) {
  const kw = node.widgets?.find((w) => w.name === "history_key");
  if (kw && (kw.value === -1 || kw.value === "-1")) kw.value = node.id;
}

async function refreshItems(node) {
  const p = node._odIcp;
  if (!p) return;
  try {
    const r = await app.api.fetchApi(
      `/comfy_0DAYE/image_cache/list?key=${encodeURIComponent(keyOf(node))}`);
    if (!r.ok) return;
    const d = await r.json();
    if (Array.isArray(d?.items)) setItems(node, d.items, false);
  } catch (_) {}
}

async function clearHistory(node) {
  const p = node._odIcp;
  if (!p) return;
  if (!window.confirm("确定清空本节点的历史记录吗？\n（只清除本节点列表，缓存文件按全局容量自动淘汰）")) return;
  const key = keyOf(node);
  try {
    const r = await app.api.fetchApi("/comfy_0DAYE/image_cache/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!r.ok) throw new Error(String(r.status));
    setItems(node, [], false);
  } catch (_) {
    alert("清空失败，请查看控制台日志");
  }
}

function attachCache(node) {
  if (node._odIcp) {
    applyRootH(node._odIcp);
    return;
  }
  const p = makeDom();
  p.state = { items: [], index: 0, page: 0, perPage: 6 };
  p.node = node; // applyRootH 宽度同步要用
  node._odIcp = p;
  // 拖节点边框 → onResize → 重钉 root 宽度（旧版 canvas 不设 widget 宽，防穿出）
  if (!p.resizeHooked) {
    p.resizeHooked = true;
    const prevResize = node.onResize;
    node.onResize = function () {
      const r = prevResize?.apply(this, arguments);
      try { applyRootH(p); } catch (_) {}
      return r;
    };
    // 兜底：部分版本 resize 拖拽不走 onResize，onDrawForeground 每帧校验（同值不写，零开销）
    const prevDF = node.onDrawForeground;
    node.onDrawForeground = function () {
      try { if (!isVueNodes()) applyRootH(p); } catch (_) {}
      return prevDF?.apply(this, arguments);
    };
  }
  const widget = node.addDOMWidget("0daye_imagecache", "imagecache", p.root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_CONTENT,
  });
  // 弹性布局（同 image_compare）：只给 minHeight，把节点富余高度全交给大图区。
  // 注意（2026-10-24 拖拽错位修复）：minHeight 必须用 MIN_CONTENT 而非 TOTAL_MIN——
  // 旧版 _arrangeWidgets 中 distributeSpace 若返回 minSize=TOTAL_MIN，当用户拖小节点到
  // < TOTAL_MIN 时会触发「总高超 body 高 → setSize 撑回」的循环，节点大小跳动、看起来错位。
  // 用 MIN_CONTENT（stage=0）让节点可自由缩小；空间不足时由 .tiny 让 stage 收缩适应。
  Object.defineProperty(widget, "computeLayoutSize", {
    configurable: true,
    get() {
      return () => ({ minHeight: MIN_CONTENT, minWidth: 1 });
    },
    set() {},
  });
  Object.defineProperty(widget, "computeSize", {
    configurable: true,
    get() {
      return isVueNodes() ? (w) => [w ?? 1, MIN_CONTENT] : undefined;
    },
    set() {},
  });
  applyRootH(p);
  bindEvents(node, p);
  render(p);
}

app.registerExtension({
  name: "0DAYE.ImageCachePreview.Panel",

  // 执行完成：ui.items 为当前抽屉全量（最新在前）→ 覆盖面板并回到最新
  setup() {
    app.api.addEventListener("executed", (e) => {
      try {
        const id = e.detail?.node ?? e.detail?.display_node;
        const n = app.graph?.getNodeById?.(id);
        if (!n || (n.comfyClass !== NODE_NAME && n.type !== NODE_NAME)) return;
        const items = e.detail?.output?.items;
        if (Array.isArray(items)) setItems(n, items, false);
      } catch (_) {}
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      try {
        attachCache(this);
        autoAssignKey(this);
        applyAdvancedFallback(this); // advanced 折叠兜底（幂等）
        installCollapseFit(this); // Vue 折叠时高度收缩（幂等）
        // 新建默认尺寸（新前端 onNodeCreated 时 size=[0,0]，延迟一帧设置）
        setTimeout(() => {
          if (this._odConfigured) return; // 工作流加载节点保留保存尺寸
          try { this.setSize([DEFAULT_W, DEFAULT_H]); } catch (_) {}
        }, 0);
      } catch (_) {}
      return r;
    };

    // LiteGraph.createNode 构造期 node.id 还是 -1 → onAdded 分配真实 id 后补写 key 并拉历史
    const origOnAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      const ra = origOnAdded?.apply(this, arguments);
      try {
        autoAssignKey(this);
        applyAdvancedFallback(this); // 双保险（onAdded 时机更稳）
        installCollapseFit(this);
        if (this._odIcp) applyRootH(this._odIcp);
        refreshItems(this);
      } catch (_) {}
      return ra;
    };

    // 加载工作流：widget 值（含 history_key）已就位后再拉一次历史
    const origConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      this._odConfigured = true;
      const rc = origConfigure?.apply(this, arguments);
      try {
        autoAssignKey(this);
        applyAdvancedFallback(this);
        installCollapseFit(this);
        if (this._odIcp) applyRootH(this._odIcp);
        refreshItems(this);
      } catch (_) {}
      return rc;
    };
  },
});
