import { app } from "../../../scripts/app.js";

// 预设数值直接编码在 profile 选项文本里（cf=/gs=），后端用同一格式解析，单一数据源。
// 调整预设只需改 __init__.py 的 options 列表，本文件无需同步。
const PRESET_RE = /\[cf=([\d.]+),\s*gs=(\d+)\]/;

app.registerExtension({
    name: "0DAYE.SplitInpaint.ProfileSync",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "SplitInpaint") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            const profileWidget = this.widgets?.find((w) => w.name === "profile");
            const cfWidget = this.widgets?.find((w) => w.name === "context_factor");
            const gsWidget = this.widgets?.find((w) => w.name === "guide_size");
            if (!profileWidget || !cfWidget || !gsWidget) return r;

            // 匹配预设格式（非"自定义"）时锁定两个滑条——后端会强制覆盖，锁灰提示用户手动调节无效
            const updateLockState = (value) => {
                const locked = PRESET_RE.test(value);
                cfWidget.disabled = locked;
                gsWidget.disabled = locked;
            };

            const origCallback = profileWidget.callback;
            profileWidget.callback = function (value) {
                origCallback?.apply(this, arguments);
                updateLockState(value);
                const m = PRESET_RE.exec(value);
                if (m) {
                    cfWidget.value = parseFloat(m[1]);
                    gsWidget.value = parseInt(m[2], 10);
                }
            };
            updateLockState(profileWidget.value);

            // 加载已保存的工作流时 configure 直接赋值、不触发回调，需补一次锁定状态
            const origConfigure = this.configure;
            this.configure = function () {
                const rc = origConfigure?.apply(this, arguments);
                updateLockState(profileWidget.value);
                return rc;
            };
            return r;
        };
    },
});
