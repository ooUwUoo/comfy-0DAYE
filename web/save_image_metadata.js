import { app } from "../../../scripts/app.js";

// SaveImageMetadata（元数据存图）前端扩展 —— 纯显示层。
// 节点多语言显示名由 ComfyUI 官方 i18n 机制（locales/<lang>/nodeDefs.json）接管，本文件不再处理标题。
// 这里只做四件事（后端仍是唯一真源，JS 失效不影响执行）：
// ① 新建节点统一为实测默认宽度（仅宽度；高度沿用 ComfyUI 计算值 + 前缀助手面板占位）。
// ② mode=原生 ComfyUI 时灰化三个 CivitAI 嵌入开关（embed_parameters/embed_lora/embed_workflow），
//    提示用户这些开关在原生模式下不生效；后端 write_params/write_workflow 的短路逻辑不变。
// ③ quality 单控件「可输入下拉框」：前端 1.57 无原生可编辑 Combo（已核实包内无 editable 支持），
//    故用原生 HTML <input list> + <datalist> 实现——点击下拉出 95/85/78 预设、可直接键入任意数值；
//    后端 quality 是 String 输入 + _quality_value 容错解析，JS 不生效时退化为普通文本框照样可用。
// ④ filename_prefix「前缀助手」面板：下拉选「最近使用(5)/我的模板」一键写入 + 占位符 chips 追加；
//    数据经 GET/POST /comfy_0DAYE/save_image/prefix_state 持久化到服务端 user/0DAYE/（插件更新不丢），
//    路由不可用时降级为内存态（面板照常可用，只是不持久）。所有操作最终都是写原 widget 值。
const DEFAULT_W = 306;

// 原生模式下被夺权的开关（参数串/LoRA 强制不写、工作流强制嵌，与后端 L800 短路一致）
const NATIVE_DISABLED = ["embed_parameters", "embed_lora", "embed_workflow"];

// quality 下拉预设（value=写入值，label=显示注释）；行高与常规 widget 行一致
const QUALITY_PRESETS = [["95", "极高"], ["85", "高"], ["78", "低"]];
const QUALITY_ROW_H = 30;
const QUALITY_DATALIST_ID = "od-quality-presets";

// 前缀助手面板：固定高度（min=max 不参与弹性均分，同历史面板教训）；
// 条数上限与后端 save_image_metadata.py 的 PREFIX_HISTORY_MAX/PREFIX_TEMPLATES_MAX 保持一致
const PREFIX_PANEL_H = 96;
const PREFIX_HISTORY_MAX = 5;
const PREFIX_TEMPLATES_MAX = 10;
const PREFIX_STATE_URL = "/comfy_0DAYE/save_image/prefix_state";
const PREFIX_DEFAULT_VALUE = "ComfyUI_Meta"; // 后端 filename_prefix 默认值（自动填入时的判定基准）
const PLACEHOLDER_CHIPS = [
    "%seed%", "%steps%", "%cfg%", "%sampler%", "%scheduler%", "%denoise%",
    "%model%", "%width%", "%height%", "%prompt%", "%date:yyyy-MM-dd%", "%batch_num%",
];

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
// ③ quality 可输入下拉框
// ---------------------------------------------------------------------------

// 共享 datalist（全文档一个，各节点 input 用 list 属性引用）
function ensureQualityDatalist() {
    let dl = document.getElementById(QUALITY_DATALIST_ID);
    if (!dl) {
        dl = document.createElement("datalist");
        dl.id = QUALITY_DATALIST_ID;
        for (const [v, label] of QUALITY_PRESETS) {
            const op = document.createElement("option");
            op.value = v;
            op.label = label;
            dl.appendChild(op);
        }
        document.body.appendChild(dl);
    }
    return dl;
}

// 把后端自动生成的 quality 文本 widget 换成「可输入下拉框」DOM widget（原位替换、保持序号不变，
// 使工作流 widgets_values 按索引回填仍然对齐；幂等，onNodeCreated / configure 都会调）。
function upgradeQualityWidget(node) {
    if (node._odQualityUpgraded) return;
    node._odQualityUpgraded = true;
    ensureQualityDatalist();

    const widgets = node.widgets || [];
    const idx = widgets.findIndex((w) => w?.name === "quality");
    const oldVal = idx >= 0 ? widgets[idx]?.value : null;

    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("list", QUALITY_DATALIST_ID);
    input.value = oldVal != null && oldVal !== "" ? String(oldVal) : "85";
    input.placeholder = "选预设或输入 1-100";
    Object.assign(input.style, {
        width: "100%", height: "100%", boxSizing: "border-box",
        background: "var(--comfy-input-bg, #222)", color: "var(--input-text, #ddd)",
        border: "1px solid var(--border-color, #444)", borderRadius: "4px",
        padding: "0 6px", fontSize: "12px", outline: "none",
    });

    const domW = node.addDOMWidget("quality", "quality", input, {
        hideOnZoom: false,
        getMinHeight: () => QUALITY_ROW_H,
    });
    // 固定高度（min=max），不参与弹性均分（与历史面板同一条前端教训）
    domW.computeLayoutSize = () => ({ minHeight: QUALITY_ROW_H, maxHeight: QUALITY_ROW_H, minWidth: 1 });
    // 序列化：值随工作流保存，执行时按名字映射回后端 quality 输入
    domW.serializeValue = () => input.value;
    // configure 回填：litegraph 会按索引给 widget.value 赋值，转发进输入框
    let _v = input.value;
    Object.defineProperty(domW, "value", {
        get: () => input.value,
        set: (v) => { _v = v == null ? "" : String(v); input.value = _v; },
        configurable: true,
    });
    input.addEventListener("input", () => { _v = input.value; node.graph?.setDirtyCanvas?.(true, true); });

    // 把 DOM widget 从尾部挪回原 widget 的槽位，并删掉自动生成的那个
    if (idx >= 0) {
        const arr = node.widgets;
        const domIdx = arr.indexOf(domW);
        if (domIdx >= 0) arr.splice(domIdx, 1);
        const autoIdx = arr.findIndex((w) => w?.name === "quality" && w !== domW);
        if (autoIdx >= 0) arr.splice(autoIdx, 1, domW);
        else arr.splice(Math.min(idx, arr.length), 0, domW);
        node.setSize([node.size[0], node.computeSize()[1]]);
    }
}

// ---------------------------------------------------------------------------
// ④ filename_prefix 前缀助手面板
// ---------------------------------------------------------------------------

const PREFIX_STYLE_ID = "0daye-prefix-helper-style";
function ensurePrefixStyle() {
    if (document.getElementById(PREFIX_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = PREFIX_STYLE_ID;
    el.textContent = `
    .od-px{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;
      padding:4px 6px;border-top:1px solid #33333c;background:#16161b;}
    .od-px-row{display:flex;gap:4px;align-items:center;flex:none;}
    .od-px-sel{flex:1 1 auto;min-width:0;height:22px;background:#222;color:#ddd;
      border:1px solid #444;border-radius:4px;font-size:11px;outline:none;}
    .od-px-btn{flex:none;height:22px;padding:0 8px;border:1px solid #4a4a55;background:#26262d;
      color:#cfcfd6;border-radius:3px;font-size:11px;cursor:pointer;}
    .od-px-btn:hover:not(:disabled){border-color:#7a7a88;background:#33333c;}
    .od-px-btn:disabled{opacity:.4;cursor:default;}
    .od-px-chips{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-wrap:wrap;
      gap:3px;align-content:flex-start;}
    .od-px-chip{height:18px;padding:0 5px;border:1px solid #3f3f48;background:#1e1e24;color:#9aa0a8;
      border-radius:3px;font-size:10px;cursor:pointer;font-family:Consolas,monospace;}
    .od-px-chip:hover{border-color:#7a7a88;color:#e0e0e6;background:#2a2a31;}
    `;
    document.head.appendChild(el);
}

// 模块级状态缓存（全插件共用一份；loaded=false 表示尚未拉取，拉取失败按空处理、仍可写）
const prefixState = { loaded: false, history: [], templates: [] };
let prefixStatePromise = null;

function loadPrefixState() {
    if (!prefixStatePromise) {
        prefixStatePromise = fetch(PREFIX_STATE_URL)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (d && Array.isArray(d.history) && Array.isArray(d.templates)) {
                    prefixState.history = d.history.filter((s) => typeof s === "string" && s).slice(0, PREFIX_HISTORY_MAX);
                    prefixState.templates = d.templates.filter((s) => typeof s === "string" && s).slice(0, PREFIX_TEMPLATES_MAX);
                }
                prefixState.loaded = true;
                return prefixState;
            })
            .catch(() => { prefixState.loaded = true; return prefixState; });
    }
    return prefixStatePromise;
}

// 持久化（失败静默：后端路由不可用时退化为内存态，不影响面板使用）
function persistPrefixState() {
    try {
        fetch(PREFIX_STATE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ history: prefixState.history, templates: prefixState.templates }),
        }).catch(() => {});
    } catch (_) {}
}

// 记录一次实际执行使用的 prefix（executed 事件调用）：去重、新的在前、截到上限
function recordPrefixHistory(v) {
    if (typeof v !== "string" || !v) return;
    const i = prefixState.history.indexOf(v);
    if (i >= 0) prefixState.history.splice(i, 1);
    prefixState.history.unshift(v);
    prefixState.history.length = Math.min(prefixState.history.length, PREFIX_HISTORY_MAX);
    persistPrefixState();
}

// 按钮文字短暂反馈（如 存→已存）
function flashBtn(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 800);
}

// 把当前值写入 filename_prefix 原 widget（等价手动输入：值 + 回调 + 画布标脏）
function writePrefixWidget(node, fw, v) {
    fw.value = v;
    fw.callback?.(v);
    node.graph?.setDirtyCanvas?.(true, true);
}

function attachPrefixHelper(node) {
    if (node._odPx) return;
    const fw = findWidget(node, "filename_prefix");
    if (!fw) return;
    ensurePrefixStyle();

    const root = document.createElement("div");
    root.className = "od-px";

    // 第 1 行：历史/模板下拉 + 存/删按钮
    const row1 = document.createElement("div");
    row1.className = "od-px-row";
    const sel = document.createElement("select");
    sel.className = "od-px-sel";
    sel.title = "选择即写入 filename_prefix";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "od-px-btn";
    saveBtn.textContent = "存";
    saveBtn.title = "把当前 filename_prefix 存为我的模板";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "od-px-btn";
    delBtn.textContent = "删";
    delBtn.title = "删除下拉中选中的我的模板";
    delBtn.disabled = true;
    row1.appendChild(sel);
    row1.appendChild(saveBtn);
    row1.appendChild(delBtn);

    // 第 2 行：占位符 chips（点击追加到原值末尾）
    const row2 = document.createElement("div");
    row2.className = "od-px-chips";
    for (const ph of PLACEHOLDER_CHIPS) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "od-px-chip";
        chip.textContent = ph;
        chip.title = `追加 ${ph}`;
        chip.addEventListener("click", (ev) => {
            ev.stopPropagation();
            writePrefixWidget(node, fw, String(fw.value ?? "") + ph);
        });
        row2.appendChild(chip);
    }

    root.appendChild(row1);
    root.appendChild(row2);
    node._odPx = { root, sel, saveBtn, delBtn };

    const widget = node.addDOMWidget("0daye_prefixhelper", "prefixhelper", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => PREFIX_PANEL_H,
    });
    // 固定高度（min=max），不参与多余高度均分
    widget.computeLayoutSize = () => ({ minHeight: PREFIX_PANEL_H, maxHeight: PREFIX_PANEL_H, minWidth: 1 });

    // 挪到 filename_prefix 正下方（serialize:false 不占 widgets_values 槽位，不影响索引对齐）
    const arr = node.widgets || [];
    const domIdx = arr.indexOf(widget);
    if (domIdx >= 0) arr.splice(domIdx, 1);
    const fIdx = arr.indexOf(fw);
    arr.splice(fIdx >= 0 ? fIdx + 1 : arr.length, 0, widget);

    function rebuildSelect() {
        sel.textContent = "";
        const ph = new Option("选历史 / 模板写入前缀…", "");
        ph.disabled = true;
        sel.appendChild(ph);
        if (prefixState.history.length) {
            const g = document.createElement("optgroup");
            g.label = "最近使用";
            for (const h of prefixState.history) {
                const op = new Option(h, h);
                op.dataset.kind = "hist";
                g.appendChild(op);
            }
            sel.appendChild(g);
        }
        if (prefixState.templates.length) {
            const g = document.createElement("optgroup");
            g.label = "我的模板";
            for (const t of prefixState.templates) {
                const op = new Option(t, t);
                op.dataset.kind = "tpl";
                g.appendChild(op);
            }
            sel.appendChild(g);
        }
        sel.selectedIndex = 0;
        delBtn.disabled = true;
    }

    sel.addEventListener("mousedown", rebuildSelect); // 打开前刷新（历史可能已被其它节点更新）
    sel.addEventListener("change", () => {
        const opt = sel.selectedOptions[0];
        if (!opt || !opt.value) return;
        writePrefixWidget(node, fw, opt.value);
        delBtn.disabled = opt.dataset.kind !== "tpl"; // 只有选中我的模板时可删
    });
    saveBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const v = String(fw.value ?? "");
        if (!v) { flashBtn(saveBtn, "空"); return; }
        const i = prefixState.templates.indexOf(v);
        if (i >= 0) prefixState.templates.splice(i, 1);
        prefixState.templates.unshift(v);
        prefixState.templates.length = Math.min(prefixState.templates.length, PREFIX_TEMPLATES_MAX);
        persistPrefixState();
        rebuildSelect();
        flashBtn(saveBtn, "已存");
    });
    delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const opt = sel.selectedOptions[0];
        if (!opt || opt.dataset.kind !== "tpl" || !opt.value) return;
        const i = prefixState.templates.indexOf(opt.value);
        if (i >= 0) {
            prefixState.templates.splice(i, 1);
            persistPrefixState();
        }
        rebuildSelect();
    });

    loadPrefixState().then(rebuildSelect);
}

// 面板占位高度一次性补齐：老工作流保存的节点高度没有算面板，加载时 +PREFIX_PANEL_H 一次；
// 用 node.properties.odPxH 做标记（随工作流保存），避免每次加载重复加高。
function ensurePanelSpace(node) {
    if (node.properties?.odPxH) return;
    node.properties = node.properties || {};
    node.properties.odPxH = PREFIX_PANEL_H;
    const h = Array.isArray(node.size) ? node.size[1] : 0;
    if (h) node.setSize([node.size[0], h + PREFIX_PANEL_H]);
}

app.registerExtension({
    name: "0DAYE.SaveImageMetadata.Defaults",

    // 记录「最近使用」：节点每次实际执行后读其 filename_prefix 当前值入历史
    setup() {
        app.api.addEventListener("executed", (e) => {
            try {
                const id = e.detail?.node ?? e.detail?.display_node;
                const n = app.graph?.getNodeById?.(id);
                if (!n || (n.comfyClass !== "SaveImageMetadata" && n.type !== "SaveImageMetadata")) return;
                const fw = findWidget(n, "filename_prefix");
                recordPrefixHistory(String(fw?.value ?? ""));
            } catch (_) {}
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "SaveImageMetadata") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            try {
                const h = Array.isArray(this.size) ? this.size[1] : 0;
                if (h) this.setSize([DEFAULT_W, h]);
                hookModeWidget(this);
                applyModeState(this);
                upgradeQualityWidget(this);
                attachPrefixHelper(this);
                ensurePanelSpace(this);
                // 新建节点自动填入最近使用第一条：仅当值仍是后端默认值、且不是工作流加载/粘贴
                // （加载/粘贴会先走 configure，_odConfigured 置位，保存值优先）
                const fw = findWidget(this, "filename_prefix");
                loadPrefixState().then(() => {
                    if (this._odConfigured) return;
                    if (fw && prefixState.history.length && String(fw.value ?? "") === PREFIX_DEFAULT_VALUE) {
                        fw.value = prefixState.history[0];
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
                upgradeQualityWidget(this);  // 原 configure 已把保存值写进自动 widget，此处读出并接管
                attachPrefixHelper(this);
                ensurePanelSpace(this);
            } catch (_) {}
            return r;
        };
    },
});
