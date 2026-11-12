import { app } from "../../../scripts/app.js";
import { isVueNodes, collapseFit, installCollapseFit, onEngineSwitch } from "./od_engine.js";

// SaveImageMetadata（元数据存图）前端扩展 —— 纯显示层。
// 节点多语言显示名由 ComfyUI 官方 i18n 机制（locales/<lang>/nodeDefs.json）接管，本文件不再处理标题。
// 这里只做四件事（后端仍是唯一真源，JS 失效不影响执行）：
// ① 新建节点统一为实测默认宽度（仅宽度；高度沿用 ComfyUI 计算值 + 前缀助手面板占位）。
// ② mode=原生 ComfyUI 时灰化三个 CivitAI 嵌入开关（embed_parameters/embed_lora/embed_workflow），
//    提示用户这些开关在原生模式下不生效；后端 write_params/write_workflow 的短路逻辑不变。
// ③ filename_prefix「路径标签」面板（折叠/展开两态，双引擎高度方案同 history_panel.js，已验证踩坑勿回退）：
//    **折叠态只留两件事**——状态行 + 「最近使用 / 我的模板」两个下拉；
//    两个下拉点选后**立即把内容写进上方 filename_prefix 路径框**（不再「载入草稿→再应用」）。
//    展开态是编辑工作台：「标签」下拉（点选把标签插进下方草稿编辑框；浮层内按住拖动排序、
//    ✎ 改名、× 删除，底部「＋ 新建标签 / 恢复默认」）+ 草稿编辑框 + 应用 / 存模板。
//    数据经 GET/POST /comfy_0DAYE/save_image/prefix_state 持久化到服务端 user/0DAYE/
//    （历史/模板/标签三个数组；插件更新不丢），路由不可用时降级为内存态。
//    「最近使用」另由后端 execute() 返回的 ui.filename_prefix（原始模板值）经 executed 事件记录；
//    与默认值（image）相同的不记录，旧版默认值 ComfyUI_Meta 在加载时一次性迁移。
// ④ advanced 折叠兜底：后端 13 个控件声明 advanced=True，但新前端 V1→V2 转换层可能丢标记
//    （TextCache 同构 config 实测中招），节点创建/加载后补写 _visibility.surfaces（见 ADV_WIDGETS）。
const DEFAULT_W = 295;

// 原生模式下被夺权的开关（参数串/LoRA 强制不写、工作流强制嵌，与后端短路一致）
const NATIVE_DISABLED = ["embed_parameters", "embed_lora", "embed_workflow"];

// 前缀助手面板：折叠 / 展开两态，各自固定高度（双引擎高度方案见 attachPrefixHelper 内注释）；
// 切换展开态时同步 setSize 补差额（与历史面板拖拽手柄同款做法，绝不改成弹性 widget）。
// 折叠态 = 1(上边框) + 8(内边距) + 20(状态行) + 4(间距) + 22(下拉行) ≈ 55 → 取 56；
// 展开态 = 折叠态 + 4(间距) + 22(标签/应用/存模板同一行) + 4(间距) + 50(编辑框) ≈ 135 → 取 140（留余量防字体差异）。
// 【旧引擎 20px 陷阱，2026-11-13 用户实测回归后定案，勿删】旧版 LiteGraph 下 DOM widget 元素的实际高度
//   = computedHeight - margin*2（GraphView 的 DomWidgets.updateWidgets 实挖），而 DOMWidgetImpl 的
//   margin 默认 10 → 沿用默认时整块面板凭空少 20px：折叠态 56-20=36px 只够显示头部行（两个下拉被裁掉、
//   用户以为「折叠态没有下拉」），展开态 166-20=146px 恰好裁掉底部按钮行。正解 = addDOMWidget 显式传
//   margin:0（options 原样透传给 DOMWidgetImpl），左右 10px 留白改由 .od-px 自己的 margin 承担，
//   这样两套引擎拿到的高度预算完全一致（Vue 走 CSS Grid 行高 + applyPxRootH 像素高，本来不吃 margin）。
// 条数/长度上限与后端 save_image_metadata.py 的 PREFIX_* 常量保持一致（单一数据源以后端为准）
const PREFIX_PANEL_H_COLLAPSED = 56;
const PREFIX_PANEL_H_EXPANDED = 140;
const PREFIX_HISTORY_MAX = 10;
const PREFIX_TEMPLATES_MAX = 10;
const PREFIX_TAGS_MAX = 40;
const PREFIX_LABEL_MAX_LEN = 200;
const PREFIX_STATE_URL = "/comfy_0DAYE/save_image/prefix_state";
const PREFIX_DEFAULT_VALUE = "image"; // 后端 filename_prefix 默认值（自动填入与「默认值不入历史」的判定基准）
const PREFIX_LEGACY_DEFAULT = "ComfyUI_Meta"; // 旧版默认值：仅在加载老工作流时一次性迁移，其余场合只读

// 后端 PREFIX_DEFAULT_TAGS 的**离线降级镜像**：只在 GET 状态路由失败时用一次；
// 正常路径一律以服务端返回的 default_tags 为准（单一数据源仍在后端）。
const FALLBACK_TAGS = [
    "%seed%", "%steps%", "%cfg%", "%sampler%", "%scheduler%", "%denoise%",
    "%model%", "%model40%", "%width%", "%height%", "%prompt%", "%date:yyyy-MM-dd%", "%batch_num%",
];

// —— ④ advanced 折叠兜底（与 history_panel.js 同款机制，实测踩坑勿删）——
// 后端 save_image_metadata.py 已给 13 个控件声明 advanced=True（用户逐项确认），
// 但新前端（1.55.x）V1→V2 转换层可能丢失该标记（TextCache 同构 config 实测中招）。
// 补写 options.advanced + _visibility.surfaces（可见性判定消费的即时状态，仅改 options 不重算）。
// surfaces 三面消费方不同（bundle 实挖）：canvas=旧版画布命中测试必须保持 'shown'（否则旧版
// 画得出但点不动）；vueNode/panel=Vue 折叠 → 'advanced'。
// 与后端 advanced=True 清单保持一致（单一数据源仍以后端为准，JS 是显示层兜底）。
const ADV_WIDGETS = [
    "quality", "sanitize",
    "embed_parameters", "embed_lora", "embed_workflow", "save_workflow_json",
    "seed_override", "steps_override", "lora_override",
    "positive_node_id", "negative_node_id", "sampler_node_id", "model_node_id",
];
function applyAdvancedFallback(node) {
    for (const name of ADV_WIDGETS) {
        const w = findWidget(node, name);
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

function findWidget(node, name) {
    return node?.widgets?.find((w) => w?.name === name);
}

// ---------------------------------------------------------------------------
// ② 原生模式灰化
// ---------------------------------------------------------------------------

function applyModeState(node) {
    const modeW = findWidget(node, "mode");
    if (!modeW) return;
    const native = String(modeW.value ?? "").startsWith("原生");
    for (const name of NATIVE_DISABLED) {
        const w = findWidget(node, name);
        if (w) w.disabled = native;  // 只灰化不禁值：值仍随工作流保存，切回 CivitAI 模式即恢复生效
    }
    node.graph?.setDirtyCanvas?.(true, true);
}

function hookModeWidget(node) {
    const modeW = findWidget(node, "mode");
    if (!modeW || modeW._odNativeHooked) return;
    modeW._odNativeHooked = true;
    const cb = modeW.callback;
    modeW.callback = function () {
        const r = cb?.apply(this, arguments);
        applyModeState(node);
        return r;
    };
}

// ---------------------------------------------------------------------------
// ③ filename_prefix 路径标签面板
// ---------------------------------------------------------------------------

const PREFIX_STYLE_ID = "0daye-prefix-helper-style";
function ensurePrefixStyle() {
    if (document.getElementById(PREFIX_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = PREFIX_STYLE_ID;
    el.textContent = `
    .od-px{width:calc(100% - 20px);margin:0 10px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;
      padding:4px 6px;border-top:1px solid #33333c;background:#16161b;overflow:hidden;}
    .od-px-head{flex:none;display:flex;align-items:center;gap:6px;height:20px;}
    .od-px-title{flex:none;font-size:11px;color:#9aa0a8;}
    .od-px-badge{flex:none;display:none;font-size:10px;color:#e0a33a;}
    .od-px-badge.on{display:inline;}
    .od-px-spacer{flex:1 1 auto;}
    .od-px-btn{flex:none;height:22px;padding:0 8px;border:1px solid #4a4a55;background:#26262d;
      color:#cfcfd6;border-radius:3px;font-size:11px;cursor:pointer;}
    .od-px-btn:hover:not(:disabled){border-color:#7a7a88;background:#33333c;}
    .od-px-btn:disabled{opacity:.4;cursor:default;}
    .od-px-btn.primary{border-color:#3f6ea8;background:#1e3350;color:#cfe2ff;}
    .od-px-btn.primary:hover:not(:disabled){border-color:#5a8fd0;background:#264266;}
    .od-px-btn.small{height:16px;padding:0 5px;font-size:9px;}
    .od-px-ddrow{flex:none;display:flex;align-items:center;gap:4px;height:22px;}
    .od-px-dd{flex:1 1 0;min-width:0;height:22px;display:flex;align-items:center;padding:0 6px;
      border:1px solid #46464f;background:#22222a;color:#cfcfd6;border-radius:3px;font-size:11px;
      cursor:pointer;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
    .od-px-dd:hover{border-color:#6d7684;background:#2c2c35;}
    .od-px-dd.on{border-color:#3f6ea8;background:#1e3350;color:#cfe2ff;}
    .od-px-expand{flex:none;display:none;flex-direction:column;gap:4px;overflow:hidden;}
    .od-px-expand.on{display:flex;}
    .od-px-edit{flex:none;height:50px;width:100%;box-sizing:border-box;resize:none;padding:3px 4px;
      background:#101014;color:#dfe3e8;border:1px solid #33333c;border-radius:3px;
      font-size:10px;line-height:15px;font-family:Consolas,monospace;outline:none;}
    .od-px-edit:focus{border-color:#4a6f9c;}
    .od-px-pop{position:fixed;z-index:10000;box-sizing:border-box;background:#1b1b21;
      border:1px solid #4a4a55;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.55);
      padding:3px;max-height:240px;overflow-y:auto;font-size:10px;}
    .od-px-pop-empty{padding:6px 4px;color:#66666e;line-height:15px;}
    .od-px-pop-row{display:flex;align-items:flex-start;gap:5px;padding:3px 4px;border-radius:3px;cursor:pointer;}
    .od-px-pop-row:hover{background:#26314a;}
    .od-px-pop-txt{flex:1 1 auto;min-width:0;font-family:Consolas,monospace;color:#cfd6de;
      line-height:14px;word-break:break-all;white-space:pre-wrap;}
    .od-px-pop-del{flex:none;height:16px;padding:0 5px;border:1px solid #4a4a55;background:#22222a;
      color:#9aa0a8;border-radius:3px;font-size:9px;cursor:pointer;}
    .od-px-pop-del:hover{border-color:#8a4a4a;color:#e6b0b0;}
    .od-px-trow{display:flex;align-items:flex-start;gap:4px;padding:3px 4px;border-radius:3px;
      cursor:grab;user-select:none;touch-action:none;}
    .od-px-trow:hover{background:#26314a;}
    .od-px-trow.dragging{opacity:.5;cursor:grabbing;background:#2f3a54;}
    body.od-px-dragging,body.od-px-dragging *{user-select:none !important;cursor:grabbing !important;}
    .od-px-trow.editing{cursor:default;}
    .od-px-ttxt{flex:1 1 auto;min-width:0;font-family:Consolas,monospace;color:#cfd6de;
      line-height:14px;word-break:break-all;white-space:pre-wrap;cursor:pointer;}
    .od-px-tmini{flex:none;height:16px;padding:0 5px;border:1px solid #4a4a55;background:#22222a;
      color:#9aa0a8;border-radius:3px;font-size:9px;cursor:pointer;}
    .od-px-tmini:hover{border-color:#7a7a88;color:#e6e6ec;}
    .od-px-tfoot{display:flex;align-items:center;gap:4px;padding:4px 2px 1px;margin-top:3px;
      flex:none;border-top:1px solid #33333c;}
    .od-px-tinp{flex:1 1 auto;min-width:0;height:20px;box-sizing:border-box;background:#101014;
      color:#dfe3e8;border:1px solid #4a6f9c;border-radius:3px;font-size:10px;
      font-family:Consolas,monospace;padding:0 4px;outline:none;}
    `;
    document.head.appendChild(el);
}

// 模块级状态缓存（全插件共用一份；loaded=false 表示尚未拉取，拉取失败按空处理、仍可写）
// tags = 有序标签列表（内置占位符与自定义标签已合并，值即内容，顺序即界面顺序、由用户拖动决定）
const prefixState = { loaded: false, history: [], templates: [], tags: [], defaultTags: FALLBACK_TAGS.slice() };
let prefixStatePromise = null;

// 只收非空字符串 + 截断超长项（与后端 PREFIX_LABEL_MAX_LEN 对齐）
function cleanStrList(list, cap, maxLen) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const s of list) {
        if (typeof s !== "string") continue;
        const v = maxLen ? s.slice(0, maxLen) : s;
        if (!v || out.includes(v)) continue;
        out.push(v);
        if (out.length >= cap) break;
    }
    return out;
}

// 并集去重（本地在前=更新）：GET 在途期间记录/新增的条目不能被服务端结果整体覆盖
function mergeStrList(local, remote, cap, maxLen) {
    return cleanStrList([...(local || []), ...(remote || [])], cap, maxLen);
}

function loadPrefixState() {
    if (!prefixStatePromise) {
        prefixStatePromise = fetch(PREFIX_STATE_URL)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (d && Array.isArray(d.history) && Array.isArray(d.templates)) {
                    // 默认值（含旧版默认值）不进历史：历史只留用户实际自定义过的前缀
                    const hist = cleanStrList(d.history, PREFIX_HISTORY_MAX).filter(
                        (s) => s !== PREFIX_DEFAULT_VALUE && s !== PREFIX_LEGACY_DEFAULT
                    );
                    prefixState.history = mergeStrList(prefixState.history, hist, PREFIX_HISTORY_MAX);
                    prefixState.templates = mergeStrList(prefixState.templates, d.templates, PREFIX_TEMPLATES_MAX);
                    // 默认标签表优先用后端返回（单一数据源），缺失时才退回本地镜像
                    const defs = cleanStrList(d.default_tags, PREFIX_TAGS_MAX, PREFIX_LABEL_MAX_LEN);
                    if (defs.length) prefixState.defaultTags = defs;
                    // 标签顺序是用户拖出来的，必须原样保留（本地为空时直接用服务端顺序）
                    if (Array.isArray(d.tags)) {
                        prefixState.tags = mergeStrList(prefixState.tags, d.tags, PREFIX_TAGS_MAX, PREFIX_LABEL_MAX_LEN);
                    } else if (!prefixState.tags.length) {
                        prefixState.tags = prefixState.defaultTags.slice();
                    }
                }
                prefixState.loaded = true;
                return prefixState;
            })
            .catch(() => {
                // 路由不可用：用本地镜像的默认标签兜底，面板仍可编辑（只是不持久化）
                if (!prefixState.tags.length) prefixState.tags = prefixState.defaultTags.slice();
                prefixState.loaded = true;
                return prefixState;
            });
    }
    return prefixStatePromise;
}

// 持久化（失败静默：后端路由不可用时退化为内存态，不影响面板使用）
function persistPrefixState() {
    try {
        fetch(PREFIX_STATE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                history: prefixState.history,
                templates: prefixState.templates,
                tags: prefixState.tags,
            }),
        }).catch(() => {});
    } catch (_) {}
}

// 记录一次实际执行使用的 prefix（executed 事件调用）：去重、新的在前、截到上限
// 默认值不入历史；GET 未返回时先等 load 完成再记，避免刚记的条目被服务端结果覆盖
function recordPrefixHistory(v) {
    if (typeof v !== "string" || !v) return;
    if (v === PREFIX_DEFAULT_VALUE || v === PREFIX_LEGACY_DEFAULT) return;
    if (!prefixState.loaded) {
        loadPrefixState().then(() => recordPrefixHistory(v));
        return;
    }
    const i = prefixState.history.indexOf(v);
    if (i >= 0) prefixState.history.splice(i, 1);
    prefixState.history.unshift(v);
    prefixState.history.length = Math.min(prefixState.history.length, PREFIX_HISTORY_MAX);
    persistPrefixState();
}

// 刷新所有节点面板的下拉计数（历史/模板是全局共享的，executed 后各节点都要跟着变）
function refreshAllBars() {
    for (const n of app.graph?._nodes ?? []) {
        try { n?._odPx?.refreshBar?.(); } catch (_) {}
    }
}

// 按钮文字短暂反馈（如 存→已存）
function flashBtn(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 800);
}

// 把值真正写回 filename_prefix（等价手动输入：值 + 回调 + 画布标脏 + 版本自增）
function writePrefixWidget(node, fw, v) {
    const s = node._odPx;
    if (s) s._applying = true;
    try {
        fw.value = v;
        fw.callback?.(v);
        node.graph?.setDirtyCanvas?.(true, true);
        try { node.graph?.incrementVersion?.(); } catch (_) {}
    } finally {
        if (s) s._applying = false;
    }
}

// 刷新「未应用」标记与草稿编辑框；编辑区有焦点时不覆写（避免打断光标）
function refreshPrefixPanel(node) {
    const s = node?._odPx;
    if (!s) return;
    if (document.activeElement !== s.edit && s.edit.value !== s.draft) s.edit.value = s.draft;
    s.badge.classList.toggle("on", s.draft !== String(s.base ?? ""));
}

// 与 widget 实际值对齐：force=true 强制以 widget 为准（加载工作流/迁移默认值）；
// 否则仅在没有未应用修改时跟随外部改动，保留用户草稿
function syncPrefixPanel(node, force) {
    const s = node?._odPx;
    if (!s) return;
    const cur = String(s.fw.value ?? "");
    if (force || s.draft === s.base) s.draft = cur;
    s.base = cur;
    refreshPrefixPanel(node);
}

// 链式包装 filename_prefix 回调（保留原回调）：用户直接改上面输入框时同步草稿
function hookPrefixWidget(node) {
    const s = node._odPx;
    if (!s || s.fw._odPxHooked) return;
    s.fw._odPxHooked = true;
    const cb = s.fw.callback;
    s.fw.callback = function () {
        const r = cb?.apply(this, arguments);
        try { if (!s._applying) syncPrefixPanel(node, false); } catch (_) {}
        return r;
    };
}

// —— 下拉浮层（原生 <select> 的选项会被节点宽度截断，故用 body 级浮层：全文换行 + 视口钳位）——
// 同一时刻只允许一个浮层；点外部 / Esc / 滚动画布 / 窗口缩放都会关闭。
let openPop = null;  // { el, anchor, redraw }
function closePop() {
    if (!openPop) return;
    const prev = openPop;
    openPop = null;
    try { prev.el?.remove?.(); } catch (_) {}
    try { prev.anchor?.classList.remove("on"); } catch (_) {}
}
function redrawPop() {
    if (!openPop) return;
    try { openPop.redraw(); } catch (_) {}
}

window.addEventListener("pointerdown", (ev) => {
    if (!openPop) return;
    if (openPop.el?.contains(ev.target) || openPop.anchor?.contains(ev.target)) return;
    closePop();
}, true);
window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closePop();  // 浮层没开时是空操作，不干扰节点删除等原生快捷键
}, true);
window.addEventListener("wheel", (ev) => {
    if (!openPop) return;
    if (openPop.el?.contains(ev.target)) return;  // 浮层内部的滚动不算外部滚动
    closePop();
}, { capture: true, passive: true });
window.addEventListener("resize", () => closePop());

function showPop(anchor, render) {
    closePop();
    const el = document.createElement("div");
    el.className = "od-px-pop";
    // 浮层内部的所有交互都不传给画布（否则会拖动节点 / 弹画布菜单）
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    el.addEventListener("contextmenu", (ev) => ev.stopPropagation());
    document.body.appendChild(el);

    const draw = () => { el.textContent = ""; render(el); };
    draw();

    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    let w = Math.max(r.width, 260);
    w = Math.max(200, Math.min(w, vw - 16));
    el.style.width = w + "px";
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    const ph = el.offsetHeight || 120;
    let top = r.bottom + 4;
    if (top + ph > vh - 8) {
        const up = r.top - 4 - ph;
        top = up >= 8 ? up : Math.max(8, vh - ph - 8);  // 上方也放不下就贴底
    }
    el.style.left = left + "px";
    el.style.top = top + "px";
    anchor.classList.add("on");
    openPop = { el, anchor, redraw: draw };
}

function popRow(text, onPick, onDelete) {
    const row = document.createElement("div");
    row.className = "od-px-pop-row";
    const t = document.createElement("div");
    t.className = "od-px-pop-txt";
    t.textContent = text;
    t.title = text;
    row.append(t);
    if (onDelete) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "od-px-pop-del";
        del.textContent = "删";
        del.title = "删除此模板";
        del.addEventListener("mousedown", (ev) => ev.stopPropagation());
        del.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onDelete();
        });
        row.append(del);
    }
    row.addEventListener("mousedown", (ev) => ev.stopPropagation());
    row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onPick();
    });
    return row;
}

function attachPrefixHelper(node) {
    if (node._odPx) return;
    const fw = findWidget(node, "filename_prefix");
    if (!fw) return;
    ensurePrefixStyle();

    const expanded = !!node.properties?.odPxExpand;
    const root = document.createElement("div");
    root.className = "od-px";

    const stop = (ev) => ev.stopPropagation();

    // ① 状态行：标题 + 未应用标记 + 展开/收起（折叠态也只留这一行 + 下面两个下拉）
    const head = document.createElement("div");
    head.className = "od-px-head";
    const title = document.createElement("span");
    title.className = "od-px-title";
    title.textContent = "路径标签";
    const badge = document.createElement("span");
    badge.className = "od-px-badge";
    badge.textContent = "● 未应用";
    const spacer = document.createElement("span");
    spacer.className = "od-px-spacer";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "od-px-btn";
    head.append(title, badge, spacer, toggle);

    // ② 下拉行：最近使用 / 我的模板 —— 点选 = 立即写入上方路径框
    const ddRow = document.createElement("div");
    ddRow.className = "od-px-ddrow";
    const histBtn = document.createElement("button");
    histBtn.type = "button";
    histBtn.className = "od-px-dd";
    const tplBtn = document.createElement("button");
    tplBtn.type = "button";
    tplBtn.className = "od-px-dd";
    ddRow.append(histBtn, tplBtn);

    // ③ 展开区：「标签」下拉 + 应用 / 存模板（同一行）+ 草稿编辑框
    //    提示文案不再单独占一行：窄节点上会用省略号把「标签 (14) ▾」挤成「标签 (1…」，
    //    用户实测反馈「标题没显示完整」→ 管理说明一律挪进按钮 tooltip / title 属性。
    const expand = document.createElement("div");
    expand.className = "od-px-expand";
    const tagRow = document.createElement("div");
    tagRow.className = "od-px-ddrow";
    const tagBtn = document.createElement("button");
    tagBtn.type = "button";
    tagBtn.className = "od-px-dd";

    const edit = document.createElement("textarea");
    edit.className = "od-px-edit";
    edit.spellcheck = false;
    edit.placeholder = "在此自由编辑：光标位置 = 标签插入点；Ctrl+Enter 应用";

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "od-px-btn primary";
    applyBtn.textContent = "应用";
    applyBtn.title = "把草稿写入上面的 filename_prefix 并记入最近使用（Ctrl+Enter 同效）";
    const tplBtnSave = document.createElement("button");
    tplBtnSave.type = "button";
    tplBtnSave.className = "od-px-btn";
    tplBtnSave.textContent = "存模板";
    tplBtnSave.title = "把当前草稿存为我的模板（下拉里点选即直接应用）";

    tagRow.append(tagBtn, applyBtn, tplBtnSave);
    // 2026-11-13 用户指定：编辑框在上、「标签 / 应用 / 存模板」在下（先看到要编辑的内容，再挑标签往里塞）
    expand.append(edit, tagRow);
    root.append(head, ddRow, expand);

    const s = {
        root, fw, widget: null, edit, badge, toggle,
        histBtn, tplBtn, tagBtn,
        draft: String(fw.value ?? ""),
        base: String(fw.value ?? ""),
        expanded,
        h: expanded ? PREFIX_PANEL_H_EXPANDED : PREFIX_PANEL_H_COLLAPSED,
        _applying: false,
        _suppressClick: false,
        sel: null,          // 编辑框最后的光标位置（点浮层标签时用它定位插入点）
    };
    node._odPx = s;

    // —— 标签：轻点插入草稿（编辑框有焦点则插在光标处，否则插到最后记住的光标位置／末尾）——
    function insertAtCursor(text) {
        const cur = String(s.draft ?? "");
        let a = -1, b = -1;
        if (document.activeElement === edit && typeof edit.selectionStart === "number") {
            a = edit.selectionStart;
            b = typeof edit.selectionEnd === "number" ? edit.selectionEnd : a;
        } else if (typeof s.sel === "number") {
            // 焦点不在编辑框（例如刚点完浮层里的标签）：用最后记下的光标位置，别一律怼到末尾
            a = Math.max(0, Math.min(s.sel, cur.length));
            b = a;
        }
        if (a >= 0) {
            s.draft = cur.slice(0, a) + text + cur.slice(b);
            edit.value = s.draft;
            const pos = a + text.length;
            s.sel = pos;
            try { edit.setSelectionRange(pos, pos); } catch (_) {}
        } else {
            s.draft = cur + text;
            edit.value = s.draft;
            s.sel = s.draft.length;
        }
        refreshPrefixPanel(node);
    }

    // —— 「标签」下拉浮层：轻点插入草稿并收起；浮层内按住拖动排序 / ✎ 改名 / × 删除；
    //    底部「＋ 新建标签」「恢复默认」 ——

    // 行内拖动排序（与旧 chips 实现同一套手势）：位移 >5px 才算拖动，否则视为点击插入；
    // 拖动中直接 insertBefore 重排 DOM（不重建节点，否则丢指针捕获、拖动立刻中断）
    function findDropRef(x, y, dragged) {
        const list = dragged.parentNode;   // rowsBox（footer 不在其中，null=行末，不会插进底栏）
        for (const el of list.children) {
            if (el === dragged || typeof el.dataset?.tag !== "string") continue;
            const r = el.getBoundingClientRect();
            if (y < r.top) return el;                                    // 指针在更靠上的行 → 插到它前面
            if (y < r.bottom && x < r.left + r.width / 2) return el;     // 同行、指针在其左半 → 插到它前面
        }
        return null;
    }

    function beginTagDrag(ev, row) {
        if (ev.button !== 0 && ev.button !== undefined) return;
        // ✎ / × 这些行内按钮、行内改名输入框自己处理点击，不参与拖动、也不算「轻点插入」
        const tgt = ev.target;
        if (tgt && typeof tgt.closest === "function" && tgt.closest(".od-px-tmini, .od-px-tinp")) return;
        ev.stopPropagation();
        // 阻止浏览器顺手开始「拖选文本 / 原生拖拽」：拖动排序时不该选中标签文字。
        // 副作用（可选）是兼容鼠标事件被抑制、click 不再派发 —— 我们本来就在 pointerup 里判定轻点。
        if (ev.cancelable) ev.preventDefault();

        const startX = ev.clientX, startY = ev.clientY, pid = ev.pointerId;
        const sortable = prefixState.tags.length >= 2;
        const rowsBox = row.parentNode;
        let dragging = false;

        // **为什么用 window 级监听、而不是 row.setPointerCapture（2026-11-13 两次真机回归的教训）**：
        // ① 捕获生效后浏览器把随后那次 click 派发到 row 而不是内层文本 → 挂在文本上的回调永不执行
        //    （「点标签没反应」）；
        // ② 捕获目标一旦在拖动中被 insertBefore 重排位置，Chrome 会静默丢掉这次捕获，
        //    pointermove 不再送到 row → 表现为「按住拖不动、松手也不排序」（用户 2026-11-13 反馈）。
        // 监听挂到 window（捕获阶段）后，行被重排、指针拖出浮层、浮层内滚动都不影响；
        // 天然的冒泡路径也让单测里的合成事件能命中同一段逻辑。
        const onMove = (e) => {
            if (pid !== undefined && e.pointerId !== undefined && e.pointerId !== pid) return;
            if (!dragging) {
                if (!sortable) return;
                if (Math.abs(e.clientX - startX) < 5 && Math.abs(e.clientY - startY) < 5) return;
                dragging = true;
                s._suppressClick = true;   // 抬手后不要顺带把标签插进草稿
                row.classList.add("dragging");
                document.body.classList.add("od-px-dragging");
            }
            // 指针贴浮层上下边缘时自动滚动（标签多到超出一屏时也能拖）
            const pop = openPop?.el;
            if (pop) {
                const box = pop.getBoundingClientRect();
                if (e.clientY < box.top + 14) pop.scrollTop -= 8;
                else if (e.clientY > box.bottom - 14) pop.scrollTop += 8;
            }
            const ref = findDropRef(e.clientX, e.clientY, row);
            if (ref === row || ref === row.nextElementSibling) return;
            rowsBox.insertBefore(row, ref);   // ref=null → 移到行末
        };

        const cleanup = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onCancel, true);
            document.body.classList.remove("od-px-dragging");
            row.classList.remove("dragging");
        };

        const commitOrder = () => {
            // 以 DOM 实际顺序为准回写状态：编辑中的行也保留 dataset.tag（旧值），长度必然对齐；
            // 真对不上就跳过并留控制台证据，方便下次定位而不是静默失败
            const order = Array.from(rowsBox.children)
                .map((el) => el.dataset?.tag)
                .filter((x) => typeof x === "string");
            if (order.length === prefixState.tags.length) {
                prefixState.tags = order;
                persistPrefixState();
            } else {
                console.warn("[comfy_0DAYE] 标签排序未持久化：DOM 行数", order.length, "≠ 状态条数", prefixState.tags.length);
            }
        };

        const onUp = (e) => {
            e.stopPropagation();
            cleanup();
            if (dragging) {
                commitOrder();
                setTimeout(() => { s._suppressClick = false; }, 0);  // click 在 pointerup 之后同步触发
                return;
            }
            // 没拖动 = 轻点这一行 → 把标签插进编辑框并收起浮层（用户 2026-11-13 指定）
            const tag = row.dataset?.tag;
            if (typeof tag === "string" && !s._suppressClick) {
                insertAtCursor(tag);
                closePop();
            }
        };

        // pointercancel（系统手势/窗口失焦打断）只清理，不算轻点
        const onCancel = () => { cleanup(); };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
    }

    function makeTagRow(text) {
        const row = document.createElement("div");
        row.className = "od-px-trow";
        row.dataset.tag = text;

        const txt = document.createElement("div");
        txt.className = "od-px-ttxt";
        txt.textContent = text;
        txt.title = `${text}\n点击插入草稿；按住可拖动排序`;
        txt.addEventListener("mousedown", stop);
        // 插入不挂在 click 上：行上有指针捕获，click 会被派发到 row（见 beginTagDrag 注释）。
        // 这里只挡冒泡，真正的「轻点 = 插入」在 pointerup 里完成。
        txt.addEventListener("click", (ev) => ev.stopPropagation());

        const ed = document.createElement("button");
        ed.type = "button";
        ed.className = "od-px-tmini";
        ed.textContent = "✎";
        ed.title = "编辑此标签";
        ed.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        ed.addEventListener("click", (ev) => { ev.stopPropagation(); editTagInline(row, text); });

        const del = document.createElement("button");
        del.type = "button";
        del.className = "od-px-tmini";
        del.textContent = "×";
        del.title = "删除此标签（「恢复默认」可补回内置占位符）";
        del.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        del.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const i = prefixState.tags.indexOf(text);
            if (i >= 0) prefixState.tags.splice(i, 1);
            persistPrefixState();
            redrawPop();
            refreshBar();
        });

        row.append(txt, ed, del);
        row.addEventListener("pointerdown", (ev) => beginTagDrag(ev, row));
        return row;
    }

    // 行内改名：Enter/失焦提交、Esc 取消；改成已存在的标签 → 合并去重（保留那条的位置），否则原地替换保序
    function editTagInline(row, oldText) {
        let done = false;
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "od-px-tinp";
        inp.value = oldText;
        inp.maxLength = PREFIX_LABEL_MAX_LEN;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const v = String(inp.value ?? "").trim().slice(0, PREFIX_LABEL_MAX_LEN);
            if (commit && v && v !== oldText) {
                const i = prefixState.tags.indexOf(oldText);
                const dup = prefixState.tags.indexOf(v);
                if (dup >= 0) {
                    if (i >= 0) prefixState.tags.splice(i, 1);
                } else if (i >= 0) {
                    prefixState.tags[i] = v;
                } else {
                    prefixState.tags.push(v);
                }
                persistPrefixState();
            }
            redrawPop();
            refreshBar();
        };
        inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        inp.addEventListener("mousedown", stop);
        inp.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
            else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
        });
        inp.addEventListener("blur", () => finish(true));
        row.textContent = "";
        row.className = "od-px-trow editing";
        row.append(inp);
        inp.focus();
        inp.select();
    }

    // 新建标签：追加一个编辑行在行末，回车保存（落在列表末尾，顺序由拖动决定）
    function newTagRow() {
        let done = false;
        const row = document.createElement("div");
        row.className = "od-px-trow editing";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "od-px-tinp";
        inp.placeholder = "新标签内容（回车保存，Esc 取消）";
        inp.maxLength = PREFIX_LABEL_MAX_LEN;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const v = String(inp.value ?? "").trim().slice(0, PREFIX_LABEL_MAX_LEN);
            if (commit && v && !prefixState.tags.includes(v)) {
                prefixState.tags.push(v);
                if (prefixState.tags.length > PREFIX_TAGS_MAX) prefixState.tags.length = PREFIX_TAGS_MAX;
                persistPrefixState();
            }
            redrawPop();
            refreshBar();
        };
        inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        inp.addEventListener("mousedown", stop);
        inp.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
            else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
        });
        inp.addEventListener("blur", () => finish(true));
        row.append(inp);
        setTimeout(() => { inp.focus(); }, 0);
        return row;
    }

    function showTagPop() {
        showPop(tagBtn, (el) => {
            const rowsBox = document.createElement("div");
            if (!prefixState.tags.length) {
                const e = document.createElement("div");
                e.className = "od-px-pop-empty";
                e.textContent = prefixState.loaded
                    ? "暂无标签：用下方「＋ 新建标签」新建，或「恢复默认」补回内置占位符"
                    : "标签加载中…";
                rowsBox.appendChild(e);
            } else {
                for (const t of prefixState.tags) rowsBox.appendChild(makeTagRow(t));
            }

            const foot = document.createElement("div");
            foot.className = "od-px-tfoot";
            const addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.className = "od-px-btn small";
            addBtn.textContent = "＋ 新建标签";
            addBtn.title = "新增路径标签（自动保存，插件更新不丢）";
            addBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
            addBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                if (prefixState.tags.length >= PREFIX_TAGS_MAX) { flashBtn(addBtn, "已满"); return; }
                if (rowsBox.querySelector(".od-px-trow.editing")) return;   // 已有一个编辑行在输入
                rowsBox.appendChild(newTagRow());
            });
            const defBtn = document.createElement("button");
            defBtn.type = "button";
            defBtn.className = "od-px-btn small";
            defBtn.textContent = "恢复默认";
            defBtn.title = "把缺失的内置占位符标签补回列表末尾（已编辑/删除的其它标签不动）";
            defBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
            defBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const missing = prefixState.defaultTags.filter((t) => !prefixState.tags.includes(t));
                if (!missing.length) { flashBtn(defBtn, "已全"); return; }
                prefixState.tags.push(...missing);
                if (prefixState.tags.length > PREFIX_TAGS_MAX) prefixState.tags.length = PREFIX_TAGS_MAX;
                persistPrefixState();
                redrawPop();
                refreshBar();
            });
            foot.append(addBtn, defBtn);

            el.append(rowsBox, foot);
        });
        refreshBar();
    }

    // —— 应用：写回 widget + 记入最近使用（可重复点击）——
    function applyDraft() {
        const v = String(s.draft ?? "");
        writePrefixWidget(node, fw, v);
        s.base = v;
        recordPrefixHistory(v);  // 默认值由 recordPrefixHistory 过滤
        refreshPrefixPanel(node);
        refreshAllBars();
        flashBtn(applyBtn, "已应用");
    }

    // 下拉点选 = 立即应用：不再走「载入草稿 → 再点应用」两步
    function applyPrefixValue(v) {
        const val = String(v ?? "");
        closePop();
        writePrefixWidget(node, fw, val);
        s.base = val;
        s.draft = val;
        s.edit.value = val;          // 草稿强制跟随（避免残留「未应用」态）
        recordPrefixHistory(val);
        refreshPrefixPanel(node);
        refreshAllBars();
    }

    // —— 两个下拉：标题计数 + 浮层内的全文行（模板行带「删」）——
    function makeDropdown(kind) {
        const btn = kind === "hist" ? histBtn : tplBtn;
        btn.addEventListener("mousedown", stop);
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (openPop?.anchor === btn) { closePop(); return; }
            showPop(btn, (body) => {
                const items = kind === "hist" ? prefixState.history : prefixState.templates;
                if (!items.length) {
                    const e = document.createElement("div");
                    e.className = "od-px-pop-empty";
                    e.textContent = kind === "hist"
                        ? "暂无记录：实际出图后自动记录（也可展开后用「应用」手动记）"
                        : "暂无模板：展开后点「存模板」保存当前路径";
                    body.appendChild(e);
                    return;
                }
                for (const it of items) {
                    body.appendChild(popRow(
                        it,
                        () => applyPrefixValue(it),
                        kind === "tpl" ? () => {
                            const i = prefixState.templates.indexOf(it);
                            if (i >= 0) prefixState.templates.splice(i, 1);
                            persistPrefixState();
                            redrawPop();
                            refreshAllBars();
                        } : null
                    ));
                }
            });
        });
        return btn;
    }

    // 下拉标题（计数）。列表是全局共享的，别的节点执行后这里也要跟着变。
    function refreshBar() {
        histBtn.textContent = `最近使用 (${prefixState.history.length}) ▾`;
        tplBtn.textContent = `我的模板 (${prefixState.templates.length}) ▾`;
        tagBtn.textContent = `标签 (${prefixState.tags.length}) ▾`;
        histBtn.title = "最近使用：点选即直接写入上方 filename_prefix 路径框";
        tplBtn.title = "我的模板：点选即直接写入上方 filename_prefix 路径框";
        tagBtn.title = "点选标签插入下方草稿；浮层内可拖动排序 / 改名 / 删除 / 新建";
    }

    // —— 展开 / 收起：改自身固定高 + setSize 补差额（不改成弹性 widget）——
    function renderToggle() {
        toggle.textContent = s.expanded ? "▴ 收起" : "▾ 展开";
        toggle.title = s.expanded ? "收起标签编辑区" : "展开标签编辑区（标签下拉 / 编辑框 / 应用 / 存模板）";
        expand.classList.toggle("on", s.expanded);
    }

    // 双引擎面板高度（与 history_panel.js 同款，实测踩坑勿回退）：
    // Vue（Nodes 2.0）下 CSS Grid 只看 computeLayoutSize 是否为函数 → 呈现为 null（min-content 行），
    // 面板实际高度必须写死在 root 元素上，且要 flex:none（包装层 *:flex-1 的 flex:1 会覆盖内联 height）
    // ——不写这步时 Vue 下面板只显示头部行、下拉行/编辑区全被裁掉（2026-11-13 用户实测回归根因）；
    // LiteGraph 靠 computeLayoutSize 钉死 min=max 不参与弹性均分。引擎切换不刷新页面，
    // 所以 root 样式与 getter 都必须【每次现查】isVueNodes()，不能按挂载时锁存。
    // 旧引擎（LiteGraph）行高重算：DOM 元素高直接取 widget.computedHeight，而 computedHeight 只有
    // arrange() 会写（draw 时按 computedHeight ?? 50 兜底）。新建 / 切换展开态 / 从 Vue 切回旧版都要
    // 主动推一次，否则面板停在 50px 兜底值上（折叠态会裁掉下拉行）。arrange 内部在内容超出节点时
    // 还会自动把节点长高，正好补齐 ensurePanelSpace 的差额。
    function nudgeLayout(delay = 0) {
        if (isVueNodes()) return;
        const run = () => {
            try { node.arrange?.(); } catch (_) {}
            node.graph?.setDirtyCanvas?.(true, true);
        };
        if (delay) setTimeout(run, delay); else run();
    }

    function applyPxRootH() {
        if (isVueNodes()) {
            s.root.style.flex = "none";
            s.root.style.height = `${s.h}px`;
        } else {
            s.root.style.flex = "";
            s.root.style.height = "";
        }
    }

    function setPanelHeight(h) {
        const delta = h - s.h;
        if (!delta) return;
        s.h = h;
        node.properties = node.properties || {};
        node.properties.odPxH = h;
        const w = Array.isArray(node.size) ? node.size[0] : 0;
        const ch = Array.isArray(node.size) ? node.size[1] : 0;
        if (ch) node.setSize([w, ch + delta]);
        applyPxRootH();
        nudgeLayout();          // 旧引擎：让 computedHeight 立刻跟上新高度
        node.graph?.setDirtyCanvas?.(true, true);
    }

    s.refreshBar = refreshBar;
    s.applyRoot = applyPxRootH;
    s.nudge = nudgeLayout;

    toggle.addEventListener("mousedown", stop);
    toggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        s.expanded = !s.expanded;
        node.properties = node.properties || {};
        node.properties.odPxExpand = s.expanded;
        setPanelHeight(s.expanded ? PREFIX_PANEL_H_EXPANDED : PREFIX_PANEL_H_COLLAPSED);
        renderToggle();
        if (s.expanded) refreshBar();
        else closePop();   // 收起时浮层没有锚点了，直接关掉
    });

    edit.addEventListener("mousedown", stop);
    edit.addEventListener("pointerdown", stop);
    edit.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            applyDraft();
        }
    });
    edit.addEventListener("input", () => {
        s.draft = edit.value;
        refreshPrefixPanel(node);
    });
    // 记住光标位置：点浮层里的标签时焦点已离开编辑框，靠它把标签插在用户最后停的地方
    const trackSel = () => {
        if (typeof edit.selectionStart === "number") s.sel = edit.selectionStart;
    };
    edit.addEventListener("keyup", trackSel);
    edit.addEventListener("mouseup", trackSel);
    edit.addEventListener("select", trackSel);
    edit.addEventListener("blur", trackSel);

    applyBtn.addEventListener("mousedown", stop);
    applyBtn.addEventListener("click", (ev) => { ev.stopPropagation(); applyDraft(); });

    tplBtnSave.addEventListener("mousedown", stop);
    tplBtnSave.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const v = String(s.draft ?? "");
        if (!v) { flashBtn(tplBtnSave, "空"); return; }
        const i = prefixState.templates.indexOf(v);
        if (i >= 0) prefixState.templates.splice(i, 1);
        prefixState.templates.unshift(v);
        prefixState.templates.length = Math.min(prefixState.templates.length, PREFIX_TEMPLATES_MAX);
        persistPrefixState();
        refreshAllBars();
        flashBtn(tplBtnSave, "已存");
    });

    // —— 「标签」下拉按钮（展开态专属）：打开标签选择/管理浮层 ——
    tagBtn.addEventListener("mousedown", stop);
    tagBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (openPop?.anchor === tagBtn) { closePop(); return; }
        showTagPop();
    });

    makeDropdown("hist");
    makeDropdown("tpl");

    const widget = node.addDOMWidget("0daye_prefixhelper", "prefixhelper", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => s.h,
        // margin:0 是必需的：旧引擎元素高 = computedHeight - margin*2（默认 margin=10 会白吃 20px，
        // 折叠态只剩 36px → 两个下拉整行看不见）。左右留白由 .od-px 的 margin:0 10px 承担。
        margin: 0,
    });
    // 双引擎高度策略（同 history_panel.js，实测踩坑勿回退）：
    // LiteGraph：_arrangeWidgets/distributeSpace 按有 computeLayoutSize 的 widget 分配富余高度
    //   → 钉死 min=max=s.h（不参与分配），数值在这里被消费。
    // Nodes 2.0（Vue）：CSS Grid 只看 computeLayoutSize 是否为函数（hasLayoutSize），数值不被消费；
    //   呈现为 null → 面板行 min-content，实际高度由 applyPxRootH 写死在 root（flex:none + 像素高）。
    // 引擎切换不刷新页面 → 必须用动态 getter 现查 isVueNodes()，两边各自在布局时拿到正确形态，
    // 天然随切换自愈；禁止按挂载时锁存（TC 面板踩坑教训）。
    Object.defineProperty(widget, "computeLayoutSize", {
        configurable: true,
        get() {
            return isVueNodes()
                ? null
                : () => ({ minHeight: s.h, maxHeight: s.h, minWidth: 1 });
        },
        set() {},  // 本插件独占该 widget 实例，吞掉外部赋值
    });
    // Vue 反向配套：computeLayoutSize 为 null 时 node.computeSize() 会把面板按 26px 兜底 → 折叠
    // 收缩（collapseFit）会裁掉面板。Vue 下让 computeSize 直接返回 [w, s.h]（仅被 computeSize 消费，
    // 不影响 CSS Grid 行高）；LiteGraph 下不存在（走 computeLayoutSize 分支）。
    Object.defineProperty(widget, "computeSize", {
        configurable: true,
        get() {
            return isVueNodes() ? (w) => [w ?? 1, s.h] : undefined;
        },
        set() {},
    });
    s.widget = widget;

    // 挪到 filename_prefix 正下方（serialize:false 不占 widgets_values 槽位，不影响索引对齐）
    const arr = node.widgets || [];
    const domIdx = arr.indexOf(widget);
    if (domIdx >= 0) arr.splice(domIdx, 1);
    const fIdx = arr.indexOf(fw);
    arr.splice(fIdx >= 0 ? fIdx + 1 : arr.length, 0, widget);

    hookPrefixWidget(node);
    renderToggle();
    applyPxRootH();
    refreshBar();
    refreshPrefixPanel(node);
    nudgeLayout(1);         // 新建：下一拍推一次旧引擎布局（此时 node.size 可能还是 [0,0]）
    nudgeLayout(60);        // 宽高修正（onNodeCreated 里的 setTimeout）落定后再补一击
    loadPrefixState().then(() => {
        // 标签顺序以服务端为准（空/失败则在 catch 里用本地镜像兜底），返回后刷新下拉计数
        refreshBar();
        if (openPop?.anchor === tagBtn) redrawPop();   // 标签浮层已开着时就地重画
    });
}

// 面板占位高度补齐：目标高度 = 当前展开态对应值（折叠 56 / 展开 166）；
// 用 node.properties.odPxH 记录已补高度（随工作流保存），老工作流记录的旧值只补差额，避免重复加高。
function ensurePanelSpace(node) {
    const expanded = !!node.properties?.odPxExpand;
    const target = node._odPx
        ? node._odPx.h
        : (expanded ? PREFIX_PANEL_H_EXPANDED : PREFIX_PANEL_H_COLLAPSED);
    const prev = Number(node.properties?.odPxH) || 0;
    node.properties = node.properties || {};
    if (prev === target) return;
    const delta = target - prev;
    node.properties.odPxH = target;
    const h = Array.isArray(node.size) ? node.size[1] : 0;
    if (h && delta) node.setSize([node.size[0], h + delta]);
}

// 旧版默认值一次性迁移：仅当值仍是旧默认（用户没改过）才换成新默认，已自定义的值一律不动
function migrateLegacyDefault(node) {
    const fw = findWidget(node, "filename_prefix");
    if (fw && String(fw.value ?? "") === PREFIX_LEGACY_DEFAULT) fw.value = PREFIX_DEFAULT_VALUE;
}

app.registerExtension({
    name: "0DAYE.SaveImageMetadata.Defaults",

    // 记录「最近使用」：节点每次实际执行后读其 filename_prefix 当前值入历史
    setup() {
        // 引擎现场切换（不刷新页面）：切到 Vue → 本类折叠态节点统一收缩；切回旧版 → 撑回全高
        onEngineSwitch((vue) => {
            for (const n of app.graph?._nodes ?? []) {
                if (n?.comfyClass !== "SaveImageMetadata" && n?.type !== "SaveImageMetadata") continue;
                try {
                    if (vue) collapseFit(n);
                    else n.expandToFitContent?.();
                    n?._odPx?.applyRoot?.();   // root 像素高/flex 按新引擎重刷（Vue 写死、旧版清残留）
                    n?._odPx?.nudge?.(1);      // 切回旧版：补推 computedHeight（切到 Vue 时内部自动跳过）
                } catch (_) {}
            }
        });
        app.api.addEventListener("executed", (e) => {
            try {
                const id = e.detail?.node ?? e.detail?.display_node;
                const n = app.graph?.getNodeById?.(id);
                if (!n || (n.comfyClass !== "SaveImageMetadata" && n.type !== "SaveImageMetadata")) return;
                // 优先用后端返回的原始模板值（filename_prefix 被拖成输入端口时 widget 值可能过期），
                // 取不到再回退当前 widget 值
                const fromEvent = e.detail?.output?.filename_prefix;
                const fw = findWidget(n, "filename_prefix");
                const v = Array.isArray(fromEvent) && typeof fromEvent[0] === "string"
                    ? fromEvent[0]
                    : String(fw?.value ?? "");
                recordPrefixHistory(v);
                refreshAllBars();   // 历史是全局的：其它节点的下拉计数一起刷新
            } catch (_) {}
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "SaveImageMetadata") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            try {
                hookModeWidget(this);
                applyModeState(this);
                attachPrefixHelper(this);
                ensurePanelSpace(this);
                applyAdvancedFallback(this); // advanced 折叠兜底（幂等）
                // 折叠态高度自适应（仅 Nodes 2.0）：折叠只是渲染层过滤、size 不会自动收缩，
                // 新建即收缩到折叠态实际高度；工作流加载走 configure 不动保存尺寸。
                installCollapseFit(this);
                collapseFit(this);
                // 新建节点统一宽度 DEFAULT_W：新前端在 onNodeCreated 时 size 尚未计算（为 [0,0]），
                // 需延迟到下一帧 setSize，否则 setSize 被跳过、宽度停留在默认 400。
                setTimeout(() => {
                    if (this._odConfigured) return;  // 工作流加载的节点保留保存尺寸
                    const h = Array.isArray(this.size) && this.size[1] ? this.size[1] : this.computeSize?.()?.[1];
                    if (h) this.setSize([DEFAULT_W, h]);
                    // 二次收缩（双保险）：同步阶段 node.size 还是 [0,0]、computeSize 时机不稳，
                    // 若同步 collapseFit 未生效，上面 h 会取到全展开高 → 这里在宽度落定后再收一次
                    collapseFit(this);
                }, 0);
                // 新建节点自动填入最近使用第一条：仅当值仍是后端默认值、且不是工作流加载/粘贴
                // （加载/粘贴会先走 configure，_odConfigured 置位，保存值优先）
                const fw = findWidget(this, "filename_prefix");
                loadPrefixState().then(() => {
                    if (this._odConfigured) return;
                    if (fw && prefixState.history.length && String(fw.value ?? "") === PREFIX_DEFAULT_VALUE) {
                        fw.value = prefixState.history[0];
                        syncPrefixPanel(this, true); // 草稿/预览跟随自动填入值
                    }
                });
            } catch (_) {}
            return r;
        };

        // 加载已保存工作流：尺寸由保存值覆盖（configure 不动尺寸），只需补挂各增强并补面板占位高
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            this._odConfigured = true;  // 标记加载来源：onNodeCreated 的自动填入让位保存值
            const r = configure?.apply(this, arguments);
            try {
                hookModeWidget(this);
                applyModeState(this);
                attachPrefixHelper(this);
                ensurePanelSpace(this);
                migrateLegacyDefault(this); // 仍是旧默认值才迁移（加载/粘贴），自定义值不动
                syncPrefixPanel(this, true); // 加载后草稿以保存值为准（清掉默认值留下的「未应用」态）
                applyAdvancedFallback(this); // advanced 折叠兜底（幂等）
                installCollapseFit(this); // 只装访问器不收缩：加载节点尊重保存尺寸，后续手动折叠才收缩
                this._odPx?.applyRoot?.();   // Vue 下 root 按恢复的 s.h 写死像素高（LiteGraph 清残留）
                this._odPx?.nudge?.(1);      // 旧引擎：加载后补推一次布局
            } catch (_) {}
            return r;
        };

        // onAdded：graph.add 分配真实 id 后触发；顺带重刷 advanced 兜底 + 装折叠访问器（均幂等，
        // 兼兜引擎现场切换伴随的节点重建——引擎切换不刷新页面，见 history_panel.js 踩坑记录）
        const onAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            const ra = onAdded?.apply(this, arguments);
            try {
                applyAdvancedFallback(this);
                installCollapseFit(this);
                this?._odPx?.applyRoot?.();   // 幂等：引擎可能已现场切换（不刷新页面），root 高度形态重刷
                this?._odPx?.nudge?.(1);      // 旧引擎：graph.add 后补推一次布局
            } catch (_) {}
            return ra;
        };
    },
});
