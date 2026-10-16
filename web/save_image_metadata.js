import { app } from "../../../scripts/app.js";

// SaveImageMetadata（元数据存图）前端扩展 —— 纯显示层。
// 节点多语言显示名由 ComfyUI 官方 i18n 机制（locales/<lang>/nodeDefs.json）接管，本文件不再处理标题。
// 这里只做：新建节点统一为实测默认宽度（仅宽度；高度沿用 ComfyUI 计算值）。
const DEFAULT_W = 306;

app.registerExtension({
    name: "0DAYE.SaveImageMetadata.Defaults",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "SaveImageMetadata") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            try {
                const h = Array.isArray(this.size) ? this.size[1] : 0;
                if (h) this.setSize([DEFAULT_W, h]);
            } catch (_) {}
            return r;
        };
        // 加载已保存工作流：尺寸由保存值覆盖（configure 不动尺寸）
    },
});
