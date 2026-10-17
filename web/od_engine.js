// comfy_0DAYE 共享引擎检测助手
// ComfyUI 有两套画布渲染引擎：LiteGraph（传统 Canvas）与 Nodes 2.0（Vue 渲染），
// 两套引擎前端 JS API 不完全互通，需要运行时检测后分支适配（见 AGENTS.md §10）。
import { app } from "../../../scripts/app.js";

// 运行时引擎检测：true = Nodes 2.0（Vue 渲染），false = LiteGraph 旧画布
// 官方设置键 Comfy.VueNodes.Enabled（前端包自身同款用法）；
// 注意（2026-10-17 bundle 实测）：切换该设置【不刷新页面】（设置项无 onChange/reload，
// 同一批节点实例会在两套引擎间往返）→ 任何依赖引擎的显示逻辑都必须每次现查本函数、禁止锁存；
// 读取失败（旧前端无 extensionManager）保守按 LiteGraph 处理。
export function isVueNodes() {
    try {
        return !!app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled");
    } catch {
        return false;
    }
}

// —— 折叠态高度自适应（仅 Nodes 2.0）——
// 背景（2026-10-17 实测）：advanced 折叠只是渲染层过滤（不渲染该行），节点 size 不会自动收缩——
// 创建时 size 按全展开控件数计算，折叠后富余高度全被 auto 行均分吃掉 → 节点中部大片空白。
// 原生 toggleAdvanced() 只调 expandToFitContent()（只放大不缩小）；且 Vue 节点头部的
// 「显示高级输入」按钮是直接赋值 node.showAdvanced=!node.showAdvanced（bundle 实锤），
// 连 toggleAdvanced 都不走 → 收缩/展开必须自己挂钩（installCollapseFit 的访问器）。
// 原理：node.computeSize()（LiteGraph 尺寸数学，双引擎通用）的行高累加循环会跳过
// 「isWidgetRowVisible=false」的行，而该判定消费 surfaces.canvas——平时刻意保持 canvas='shown'
// （旧版点击命中共用此面，见各 JS 的 applyAdvancedFallback）→ 这里临时翻成 'advanced'
// 让 computeSize 跳过折叠行，算完立即还原（try/finally），对旧版渲染/命中零影响。
// 只收缩不放大：展开方向由原生 expandToFitContent / 访问器负责。
export function collapseFit(node) {
    try {
        if (!node || !isVueNodes()) return; // 仅 Vue：旧版全平铺，收缩会截断可见控件
        if (node.flags?.collapsed) return; // 整节点折叠交给原生
        if (node.showAdvanced) return; // 展开态不收缩（原生 expandToFitContent 负责）
        const flipped = [];
        for (const w of node.widgets ?? []) {
            if (!w?.options?.advanced) continue;
            const vis = w._visibility ?? w.visibility;
            if (vis?.surfaces && vis.surfaces.canvas === "shown") {
                vis.surfaces.canvas = "advanced";
                flipped.push(vis);
            }
        }
        try {
            const h = node.computeSize?.()?.[1];
            if (h && h > 0) node.setSize([node.size?.[0] ?? 0, h]);
        } finally {
            for (const vis of flipped) vis.surfaces.canvas = "shown";
        }
    } catch (e) {
        // 不再静默：收缩失败 = 节点留全展开高（空白回归），控制台留证据便于排查
        console.warn("[0DAYE] collapseFit 收缩失败:", e);
    }
}

// —— showAdvanced 链式委托访问器：在原生写入后追加高度适配（仅 Vue 分支做动作）——
// 原生事实（bundle 实锤，2026-10-17）：LGraphNode 原型上 showAdvanced 是访问器——
//   get showAdvanced(){return this._state.showAdvanced}
//   set showAdvanced(e){setTrackedNodeState(this,`showAdvanced`,e)}
// setter 是 Vue 响应链的跟踪写入点（渲染管线/序列化都消费 _state）。
// 【最大踩坑】实例上用 defineProperty 装"闭包存值"访问器会遮蔽原型 → setTrackedNodeState
// 永远不执行 → Vue 读不到变化 → 点「显示高级输入」选项不显示、节点被按折叠内容回缩、
// 折叠状态不随工作流保存。正解 = 链式委托：实例访问器 get/set 转调原型描述符（原生逻辑
// 原样先行），ours 只在写入后 setTimeout(0) 追加高度适配（展开→expandToFitContent、
// 折叠→collapseFit）。Vue 按钮直赋值与右键 toggleAdvanced 两条路径都被覆盖。
export function installCollapseFit(node) {
    try {
        if (!node || node._odCollapseHooked) return;
        // 沿原型链找原生 showAdvanced 描述符
        let desc = null;
        let proto = Object.getPrototypeOf(node);
        while (proto && !desc) {
            desc = Object.getOwnPropertyDescriptor(proto, "showAdvanced");
            proto = Object.getPrototypeOf(proto);
        }
        if (!desc?.set) return; // 找不到原生访问器（异常旧前端）→ 不装，保持纯原生行为
        node._odCollapseHooked = true;
        Object.defineProperty(node, "showAdvanced", {
            configurable: true,
            get() {
                return desc.get.call(this); // 委托原生（读 _state）
            },
            set(v) {
                desc.set.call(this, v); // 委托原生（setTrackedNodeState 先行，Vue 响应链完整）
                setTimeout(() => {
                    try {
                        node.graph?.incrementVersion?.();
                        if (!isVueNodes()) return;
                        if (node.showAdvanced) node.expandToFitContent?.();
                        else collapseFit(node);
                        node.setDirtyCanvas?.(true, true);
                    } catch (e) {
                        console.warn("[0DAYE] showAdvanced 切换后高度适配失败:", e);
                    }
                }, 0);
            },
        });
    } catch (_) {}
}

// —— 引擎切换监听：切到 Vue 时收缩折叠态节点、切回旧版时重新撑开 ——
// 背景：Comfy.VueNodes.Enabled 设置项无 onChange/reload（bundle 实锤），菜单切换只调
// setting.set → 页面不刷新、节点实例不重建 → 从旧版（全平铺高节点）切到 Vue（折叠）后
// 节点保留旧高度，富余全成空白；反向切换则折叠态短节点会裁掉平铺控件。只能包装
// setting.set 拦截该键（纯显示层包装，原逻辑原样透传）。回调统一推迟一拍执行。
const _engineWatchCbs = [];
let _engineWatchInstalled = false;
export function onEngineSwitch(cb) {
    if (typeof cb === "function") _engineWatchCbs.push(cb);
    if (_engineWatchInstalled) return;
    _engineWatchInstalled = true;
    try {
        const setting = app.extensionManager?.setting;
        const origSet = setting?.set?.bind(setting);
        if (!origSet) return;
        setting.set = (key, value, ...rest) => {
            const r = origSet(key, value, ...rest);
            if (key === "Comfy.VueNodes.Enabled") {
                const vue = !!value;
                setTimeout(() => {
                    for (const f of _engineWatchCbs) {
                        try { f(vue); } catch (_) {}
                    }
                }, 0);
            }
            return r;
        };
    } catch (_) {}
}
