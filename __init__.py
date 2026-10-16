import math
import re
import torch
import numpy as np
import cv2
import comfy.utils
import comfy.sample
import comfy.samplers
import comfy.model_management
import node_helpers
import nodes
from comfy_api.latest import ComfyExtension, io

from .text_cache import TextCacheWithHistory
from .save_image_metadata import SaveImageMetadata


# 支持 reference_latents（in-context 参考图）编辑机制的模型类名 → 该模型所需的 reference_latents_method。
# None 表示模型自带默认值、无需指定：QwenImage21 由 model_detection 按权重判定
# （index_timestep_zero / negative_index），覆盖反而会破坏它自己的默认。
# Krea2 的 default_ref_method 是 None，不显式指定方法时 SingleStreamDiT 会静默忽略参考图。
EDIT_MODELS = {
    "QwenImage21": None,
    "QwenImage": None,
    "Krea2": "index_timestep_zero",
}


def _encode_conditioning(clip, text, images_vl, keep_vision, use_vision):
    """编码提示词。

    只有带视觉塔的文本编码器（Qwen Image / KREA2 等）才传 images / keep_vision；
    其余编码器（SDXL / Anima / Z-Image 等）按纯文本编码——它们的 tokenize 全是
    **kwargs 透传，塞进去不会报错但也没有任何作用，纯文本更干净。
    调用姿势与官方 comfy_extras/nodes_qwen.py 的 TextEncodeQwenImage21 保持一致。
    """
    if use_vision:
        tokens = clip.tokenize(text, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)
    else:
        tokens = clip.tokenize(text)
    return clip.encode_from_tokens_scheduled(tokens)


# --- 颜色匹配算法（复用 mini_color_match 核心逻辑，适配 Split Inpaint 数据流） ---

def _apply_mkl_np(t_img, t_pixels, r_pixels):
    """MKL（Monge-Kantorovich Linear）颜色迁移，numpy 实现。"""
    mu_t = np.mean(t_pixels, axis=0)
    mu_r = np.mean(r_pixels, axis=0)
    t_centered = t_pixels - mu_t
    r_centered = r_pixels - mu_r
    cov_t = np.cov(t_centered, rowvar=False) + np.eye(3) * 1e-6
    cov_r = np.cov(r_centered, rowvar=False) + np.eye(3) * 1e-6
    try:
        evals_t, evecs_t = np.linalg.eigh(cov_t)
        inv_sqrt_t = evecs_t @ np.diag(1.0 / np.sqrt(np.maximum(evals_t, 1e-6))) @ evecs_t.T
        evals_r, evecs_r = np.linalg.eigh(cov_r)
        sqrt_r = evecs_r @ np.diag(np.sqrt(np.maximum(evals_r, 0))) @ evecs_r.T
        t = sqrt_r @ inv_sqrt_t
        out = (t_img - mu_t) @ t.T + mu_r
    except Exception:
        out = (t_img - mu_t) * (np.std(r_pixels, axis=0) / (np.std(t_pixels, axis=0) + 1e-6)) + mu_r
    return np.clip(out, 0, 1)


def _apply_wavelet_easy_np(t_img, r_img):
    """Wavelet（简易小波）颜色校正，用高斯模糊分离低频做色彩迁移。"""
    t_low = cv2.GaussianBlur(t_img, (0, 0), 15)
    r_low = cv2.GaussianBlur(r_img, (0, 0), 15)
    out = t_img + (r_low - t_low)
    return np.clip(out, 0, 1)


def _apply_color_match(target, ref, method, strength, mask_np=None):
    """对 target 做基于 ref 的颜色匹配。只处理 RGB 通道，alpha 不动。

    target / ref: [B, H, W, C] torch tensor, float32, 0~1
    mask_np: [H, W] numpy float32，最终混合蒙版（1=重绘区），统计在蒙版外采样
    """
    if method == "none" or strength <= 0:
        return target
    device = target.device
    t = target.cpu().numpy()
    r = ref.cpu().numpy()
    out = []
    for i in range(t.shape[0]):
        img = t[i][..., :3]
        ref_img = r[i][..., :3]
        m = mask_np if mask_np is not None else np.ones(img.shape[:2], dtype=np.float32)
        if m.ndim == 3:
            m = m[..., 0]

        # 在蒙版"之外"采样：蒙版内是重新生成的内容，若拿它与原图蒙版区（被替换掉的旧内容）
        # 做统计，会把新内容的颜色强行拉向旧内容，像罩了一层色罩。正确锚点是蒙版外未被
        # 改动的周边——测出生成相对原图的整体色漂，再把校正应用到整幅裁剪图。
        outside = m < 0.1
        t_pixels = img[outside]
        r_pixels = ref_img[outside]
        if len(t_pixels) < 16 or len(r_pixels) < 16:
            # 蒙版几乎占满裁剪图，没有可锚定的周边，跳过校正
            out.append(t[i])
            continue

        if method == "Linear":
            t_mean, t_std = np.mean(t_pixels, axis=0), np.std(t_pixels, axis=0)
            r_mean, r_std = np.mean(r_pixels, axis=0), np.std(r_pixels, axis=0)
            scale = r_std / (t_std + 1e-5)
            corrected = (img - t_mean) * scale + r_mean
        elif method == "Mean":
            t_mean = np.mean(t_pixels, axis=0)
            r_mean = np.mean(r_pixels, axis=0)
            corrected = img + (r_mean - t_mean)
        elif method == "MKL":
            corrected = _apply_mkl_np(img, t_pixels, r_pixels)
        elif method == "Wavelet":
            if ref_img.shape[:2] != img.shape[:2]:
                ref_resized = cv2.resize(ref_img, (img.shape[1], img.shape[0]))
            else:
                ref_resized = ref_img
            # 蒙版区是重新生成的内容：ref 的蒙版区换成生成图再做低频迁移，
            # 否则旧内容的低频色块会重新罩回新内容上
            m3 = m[..., None] if m.ndim == 2 else m
            ref_for_low = m3 * img + (1.0 - m3) * ref_resized
            corrected = _apply_wavelet_easy_np(img, ref_for_low)
        else:
            corrected = img.copy()

        final_rgb = img + (corrected - img) * strength
        final_rgb = np.clip(final_rgb, 0, 1)
        if t[i].shape[-1] > 3:
            final = np.concatenate([final_rgb, t[i][..., 3:]], axis=-1)
        else:
            final = final_rgb
        out.append(final)
    return torch.from_numpy(np.array(out)).to(device)


class SplitInpaint(io.ComfyNode):
    """
    切分重绘：按蒙版连通域自动切分，每块独立裁剪 → 编码 → 采样 → 贴回。
    图生图模式通用（Qwen / Z-Image / Anima / SDXL 等）；
    编辑模式依赖模型的 reference_latents 支持（Qwen Image Edit、KREA2 等）。
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SplitInpaint",
            display_name="Split Inpaint",
            category="0DAYE",
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input("vae"),
                io.Image.Input("image"),
                io.Mask.Input("mask"),
                io.String.Input("prompt", multiline=True, default=""),
                io.String.Input("negative_prompt", multiline=True, default=""),
                io.Combo.Input("profile", options=[
                                   "极速轻绘(0.6MP) [cf=1.5, gs=768]",
                                   "快速轻绘(1.0MP) [cf=2.0, gs=1024]",
                                   "日常均衡(1.4MP) [cf=1.6, gs=1216]",
                                   "小物精修(1.8MP) [cf=1.3, gs=1344]",
                                   "关联融合(2.3MP) [cf=2.2, gs=1536]",
                                   "极致画质(4.0MP) [cf=1.3, gs=2048]",
                                   "自定义"],
                               default="日常均衡(1.4MP) [cf=1.6, gs=1216]",
                               tooltip="采样画布预设（cf=上下文倍数，gs=画布长边；速度由gs决定，区域有效像素≈gs/cf）：极速=最省资源，适合SDXL等传统模型快速试效果；日常=默认；小物精修=首饰五官等小物件；关联融合=上下文多，适合天空背景大区域；极致画质=Qwen2.1原生2K，16GB显存建议不接额外参考图；自定义=使用下面两个滑条"),
                io.Float.Input("context_factor", default=1.6, min=1.0, max=4.0, step=0.01,
                               tooltip="上下文扩展倍数，仅 profile=自定义 时生效"),
                io.Int.Input("guide_size", default=1216, min=256, max=2048, step=32,
                               tooltip="采样画布长边，仅 profile=自定义 时生效"),
                io.Combo.Input("crop_mode", options=["自动", "自由比例", "方形裁切"], default="自动",
                               tooltip="裁切形状：自动=按模型判断（SDXL/Illustrious等UNet桶训练模型用方形；Qwen2.1/Krea2/Z-Image/ANIMA/Flux等DiT模型用自由比例）；自由比例=跟随蒙版长宽比，像素利用率最高；方形裁切=强制正方形，贴边自动内移，兼容传统桶训练模型"),
                io.Int.Input("steps", default=30, min=1, max=200),
                io.Float.Input("cfg", default=1.0, min=0.0, max=20.0, step=0.1),
                io.Combo.Input("sampler_name", options=comfy.samplers.KSampler.SAMPLERS, default="euler"),
                io.Combo.Input("scheduler", options=comfy.samplers.KSampler.SCHEDULERS, default="simple"),
                io.Float.Input("denoise", default=0.6, min=0.0, max=1.0, step=0.01,
                               tooltip="图生图模式的降噪强度，0.3~0.7 较自然；编辑模式内部固定使用 1.0"),
                io.Int.Input("seed", default=0, min=0, max=0x7fffffffffffffff),
                io.Int.Input("mask_expand", default=4, min=0, max=100, step=1),
                io.Float.Input("mask_blur", default=4.0, min=0.0, max=64.0, step=0.1),
                io.Int.Input("min_area", default=64, min=1, max=10000, step=1),
                io.Boolean.Input("process_alpha", default=False, label_on="RGBA:重算透明通道", label_off="RGBA:忽略"),
                io.Boolean.Input("img2img_mode", default=False, label_on="图生图模式", label_off="编辑模式"),
                io.Combo.Input("color_match", options=["Mean", "Linear", "MKL", "Wavelet", "none"], default="Mean",
                               tooltip="重绘块贴回前自动做颜色匹配：Mean=均值平移，遮罩校色最稳定(推荐默认)；Linear=RGB独立缩放，更强力；MKL=全局映射；Wavelet=相同构图矫正偏色，最自然；none=关闭"),
                io.Float.Input("color_strength", default=1.0, min=0.0, max=1.0, step=0.01,
                               tooltip="颜色匹配强度，1.0=完全校正，0.0=不校正"),
                io.Autogrow.Input(
                    "extra_refs",
                    template=io.Autogrow.TemplateNames(
                        io.Image.Input("image"),
                        names=[f"image_{i}" for i in range(2, 11)],
                        min=0,
                    ),
                    tooltip="额外参考图（仅编辑模式生效），与官方 TextEncodeQwenImage21 同款动态端口。image_1 由区域自动裁剪图占据，这里从 image_2 开始，提示词中用 <image2> 等引用；连同裁剪图总数不超过 10 张",
                ),
            ],
            outputs=[
                io.Image.Output(),
            ],
            description="按蒙版连通域切分，每块独立裁剪重绘后贴回；图生图通用，编辑模式需模型支持 reference_latents。cfg 按模型调整：Qwen≈1.0，SDXL≈7",
        )

    @classmethod
    def execute(cls, model, clip, vae, image, mask, prompt, negative_prompt,
                profile, context_factor, guide_size, crop_mode, steps, cfg, sampler_name, scheduler,
                denoise, seed, mask_expand, mask_blur, min_area, process_alpha, img2img_mode,
                color_match, color_strength, extra_refs: io.Autogrow.Type = None):

        # 0. 应用参数预设（自定义时保留滑条值）
        # 速度只由 guide_size（画布大小）决定；区域有效像素 ≈ guide_size / context_factor
        # 预设数值直接编码在选项文本里（cf=/gs=），前端 JS 解析同一格式，单一数据源
        m = re.match(r"^(.+?)\s*\[cf=([\d.]+),\s*gs=(\d+)\]$", profile)
        if m:
            context_factor, guide_size = float(m.group(2)), int(m.group(3))
            print(f"[Split Inpaint] 预设={m.group(1)} context_factor={context_factor} guide_size={guide_size}")
            if "极致画质" in profile and extra_refs:
                n_extra = sum(1 for v in extra_refs.values() if v is not None)
                if n_extra > 0:
                    print(f"[Split Inpaint] 提示：4MP 画布 + {n_extra} 张额外参考图，16GB 显存可能吃紧")

        # 1. 提取蒙版并找连通域
        if mask.shape[0] > 1:
            mask = mask[:1]  # 只处理第一张
        mask_np = (mask[0].cpu().numpy() > 0.5).astype(np.uint8)

        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask_np, connectivity=8)

        regions = []
        for i in range(1, num_labels):
            area = stats[i, cv2.CC_STAT_AREA]
            if area >= min_area:
                regions.append(i)

        if len(regions) == 0:
            print(f"[Split Inpaint] 未检测到有效蒙版区域（mask总量={float(mask.sum()):.1f}, min_area={min_area}），原样输出")
            return io.NodeOutput(image)
        print(f"[Split Inpaint] 检测到 {len(regions)} 个区域")

        model_name = type(model.model).__name__
        use_vision = model_name in EDIT_MODELS
        ref_method = EDIT_MODELS.get(model_name)
        if not img2img_mode and not use_vision:
            # 编辑模式依赖 reference_latents，非视觉模型读不到该条件，会退化成纯文本生成
            print(f"[Split Inpaint] {model_name} 不支持 reference_latents，编辑模式自动改用图生图模式")
            img2img_mode = True
        if not img2img_mode and denoise != 1.0:
            # 起始 latent 与 reference_latents 同源时，denoise<1 会双重锚定，输出必然≈原图
            print(f"[Split Inpaint] 编辑模式内部固定 denoise=1.0（输入值 {denoise} 已被忽略）")
            denoise = 1.0

        print(f"[Split Inpaint] 模式={'图生图' if img2img_mode else '编辑'} 模型={model_name} "
              f"denoise={denoise} cfg={cfg} 视觉输入={'有' if use_vision and not img2img_mode else '无'}")

        # 1.4 裁切形状解析：自动档按模型类名判断。
        # 命中关键词的 DiT 新模型（原生任意长宽比）用自由比例；
        # 其余（SD1.5/SDXL/Illustrious/Pony 等 UNet 桶训练模型，类名均为 BaseModel）用方形。
        _FREE_RATIO_KEYWORDS = ("qwenimage", "krea", "zimage", "mingimage", "lumina",
                                "anima", "flux", "hidream", "hunyuan", "wan", "sd3", "auraflow")
        if crop_mode == "自动":
            square_crop = not any(k in model_name.lower() for k in _FREE_RATIO_KEYWORDS)
            print(f"[Split Inpaint] 裁切=自动 → {'方形裁切' if square_crop else '自由比例'}（模型类名 {model_name}）")
        else:
            square_crop = (crop_mode == "方形裁切")

        # 1.5 额外参考图：与官方 TextEncodeQwenImage21 相同的预处理（约1MP、32对齐），
        # 只编码一次，所有区域复用。仅编辑模式使用；图生图模式忽略（避免多锚定出原图）。
        extra_ref_latents = []
        extra_images_vl = []
        extra_refs = extra_refs or {}
        n_extra = sum(1 for name in sorted(extra_refs, key=lambda n: int(n.rsplit("_", 1)[-1])) if extra_refs[name] is not None)
        if n_extra > 0:
            if img2img_mode:
                print(f"[Split Inpaint] 图生图模式忽略 {n_extra} 张额外参考图")
            elif not use_vision:
                print(f"[Split Inpaint] {model_name} 不支持视觉输入，忽略 {n_extra} 张额外参考图")
            else:
                for name in sorted(extra_refs, key=lambda n: int(n.rsplit("_", 1)[-1])):
                    ref = extra_refs[name]
                    if ref is None:
                        continue
                    samples = ref[:1].movedim(-1, 1)
                    ratio = samples.shape[3] / samples.shape[2]
                    rw = round(math.sqrt(1024 * 1024 * ratio) / 32) * 32
                    rh = round(math.sqrt(1024 * 1024 / ratio) / 32) * 32
                    rw, rh = max(32, rw), max(32, rh)
                    if (rw, rh) != (samples.shape[3], samples.shape[2]):
                        s = comfy.utils.common_upscale(samples, rw, rh, "lanczos", "disabled").movedim(1, -1)
                    else:
                        s = ref[:1]
                    rgb = s[:, :, :, :3]
                    if s.shape[-1] > 3:
                        rgb = rgb * s[:, :, :, 3:] + (1.0 - s[:, :, :, 3:])  # 视觉塔看alpha叠白底，VAE保留4通道
                    extra_images_vl.append(rgb)
                    extra_ref_latents.append(vae.encode(s))
                print(f"[Split Inpaint] 已编码 {len(extra_ref_latents)} 张额外参考图（连同区域裁剪图共 {len(extra_ref_latents) + 1} 张）")

        # 2. 逐区域处理（RGBA 图全程 4 通道，仅 Qwen2.1 VAE 原生支持 alpha）
        has_alpha = image.shape[-1] == 4 and process_alpha
        current_image = image.clone() if has_alpha else image[..., :3].clone()
        H, W = image.shape[1], image.shape[2]

        for idx, region_id in enumerate(regions):
            # 2.1 获取区域 bbox 并扩展上下文
            x = int(stats[region_id, cv2.CC_STAT_LEFT])
            y = int(stats[region_id, cv2.CC_STAT_TOP])
            w = int(stats[region_id, cv2.CC_STAT_WIDTH])
            h = int(stats[region_id, cv2.CC_STAT_HEIGHT])

            cx, cy = x + w / 2.0, y + h / 2.0
            if square_crop:
                # 方形裁切：边长=蒙版bbox长边×CF，以蒙版中心定位；
                # 越界时整体内移（不填充不镜像，避免伪影）；图像本身不够大时钳制成矩形
                side = max(w, h) * context_factor
                x0 = cx - side / 2
                y0 = cy - side / 2
                if x0 + side > W:
                    x0 = W - side
                if y0 + side > H:
                    y0 = H - side
                x0 = int(max(0, x0))
                y0 = int(max(0, y0))
                x1 = int(min(W, x0 + side))
                y1 = int(min(H, y0 + side))
            else:
                new_w = w * context_factor
                new_h = h * context_factor

                x0 = int(max(0, cx - new_w / 2))
                y0 = int(max(0, cy - new_h / 2))
                x1 = int(min(W, cx + new_w / 2))
                y1 = int(min(H, cy + new_h / 2))

            crop_w, crop_h = x1 - x0, y1 - y0
            if crop_w < 8 or crop_h < 8:
                continue

            # 2.2 裁剪当前图和区域蒙版
            crop_img = current_image[:, y0:y1, x0:x1, :].clone()
            region_mask = (labels[y0:y1, x0:x1] == region_id).astype(np.float32)

            # 颜色匹配参考：取原始输入图同位置，避免被前面已重绘块污染
            orig_crop = image[:, y0:y1, x0:x1, :]

            # 蒙版膨胀
            if mask_expand > 0:
                kernel = np.ones((mask_expand * 2 + 1, mask_expand * 2 + 1), np.uint8)
                region_mask = cv2.dilate(region_mask, kernel, iterations=1)

            # 2.3 计算画布尺寸（长边=guide_size，32对齐）
            if crop_w >= crop_h:
                target_w = guide_size
                target_h = int(round(guide_size * crop_h / crop_w / 32)) * 32
            else:
                target_h = guide_size
                target_w = int(round(guide_size * crop_w / crop_h / 32)) * 32
            target_w = max(32, target_w)
            target_h = max(32, target_h)

            # 画布 32 对齐取整后，宽高比与裁剪框可能相差最多 ~2%。若直接 squash
            # 缩放，贴回时两个方向缩放比不同（各向异性拉伸），离锚点越远漂移越大，
            # 症状与 DiT 偏移一致（边缘大、中心小）。先把裁剪图用边缘复制填充到与
            # 画布"严格同宽高比"的最小整数尺寸（GCD 求解，保证两方向缩放比完全相等），
            # 解码后再裁掉填充边——几何全程只有等比缩放+平移，位置零漂移。
            g = math.gcd(target_w, target_h)
            ratio_w, ratio_h = target_w // g, target_h // g
            k = max(math.ceil(crop_w / ratio_w), math.ceil(crop_h / ratio_h))
            pad_w = k * ratio_w - crop_w
            pad_h = k * ratio_h - crop_h
            pad_l, pad_r = pad_w // 2, pad_w - pad_w // 2
            pad_t, pad_b = pad_h // 2, pad_h - pad_h // 2
            padded_w, padded_h = crop_w + pad_w, crop_h + pad_h

            # 2.4 填充（replicate，不引入镜像/黑边伪影）后等比缩放到画布。
            # 蒙版不填充：填充区只用于几何对齐，不参与贴回混合。
            padded_chw = crop_img.movedim(-1, 1)
            if pad_w or pad_h:
                padded_chw = torch.nn.functional.pad(
                    padded_chw, (pad_l, pad_r, pad_t, pad_b), mode="replicate"
                )
            resized_img = comfy.utils.common_upscale(
                padded_chw, target_w, target_h, "lanczos", "disabled"
            ).movedim(1, -1)

            # 2.5 参考潜变量与采样画布同网格：直接用画布尺寸的裁剪图编码。
            # DiT 全局注意力对网格一致性极敏感——参考图若缩到别的尺寸（如旧版对齐 ~1MP），
            # 模型需跨网格缩放"照抄"周边内容，会产生边缘大、中心小的缩放型偏移；
            # 官方整图工作流也正是让输出 latent 与参考图 latent 同尺寸。
            crop_latent = vae.encode(resized_img)
            # 采样画布 latent：与参考同一编码结果（编辑模式只取 zeros_like 形状，图生图模式直接作起点）
            canvas_latent = crop_latent

            # 视觉塔输入仍对齐约 1MP（与 TextEncodeQwenImage21 一致，控制视觉 token 开销；
            # VL 特征只提供语义，不参与输出网格对齐）
            samples = resized_img.movedim(-1, 1)
            ratio = samples.shape[3] / samples.shape[2]
            ref_w = round(math.sqrt(1024 * 1024 * ratio) / 32) * 32
            ref_h = round(math.sqrt(1024 * 1024 / ratio) / 32) * 32
            ref_w, ref_h = max(32, ref_w), max(32, ref_h)
            if (ref_w, ref_h) == (samples.shape[3], samples.shape[2]):
                vl_img = resized_img
            else:
                vl_img = comfy.utils.common_upscale(
                    samples, ref_w, ref_h, "lanczos", "disabled"
                ).movedim(1, -1)

            rgb = vl_img[:, :, :, :3]
            if vl_img.shape[-1] > 3:
                rgb = rgb * vl_img[:, :, :, 3:] + (1.0 - vl_img[:, :, :, 3:])  # 视觉塔看alpha叠白底，VAE保留4通道

            # 2.6 起始 latent 与参考条件（通道数/尺寸全部由编码结果推导，不硬编码）
            if img2img_mode:
                # 图生图模式：图像只经起始 latent 进入。若同时把裁剪图喂给视觉塔，
                # 视觉 embeds 与起始 latent 同源 → 锚定过强，denoise<1 时几乎不改动（出原图）。
                latent = canvas_latent
                ref_latents = []
                images_vl = []
            else:
                # 编辑模式：零张量起点 + 裁剪图作为 in-context 参考（denoise 应为 1.0）
                # 参考潜变量与画布同尺寸同网格（见 2.5），保证 DiT 位置一一对应、消除缩放型偏移
                # 用 zeros_like 而不是手写形状：Krea2 / Anima 等 Wan21 系 VAE 会返回 5D latent，
                # 手写 [1, c, h, w] 会造出错误形状。
                latent = torch.zeros_like(
                    canvas_latent, device=comfy.model_management.intermediate_device()
                )
                # 裁剪图固定占 image_1 位，额外参考图依次排在后面（总数≤10）
                ref_latents = [crop_latent] + extra_ref_latents
                images_vl = [rgb] + extra_images_vl

            keep_vision = len(ref_latents) == 0
            positive = _encode_conditioning(clip, prompt, images_vl, keep_vision, use_vision)
            negative = _encode_conditioning(clip, negative_prompt, images_vl, keep_vision, use_vision)
            if len(ref_latents) > 0:
                try:
                    positive = node_helpers.conditioning_set_values(
                        positive, {"reference_latents": ref_latents}, append=True
                    )
                    negative = node_helpers.conditioning_set_values(
                        negative, {"reference_latents": ref_latents}, append=True
                    )
                    if ref_method is not None:
                        # 与官方 FluxKontextMultiReferenceLatentMethod 节点写入的 key 一致，
                        # 缺了它 Krea2 会静默忽略参考图（编辑模式等于没生效）
                        positive = node_helpers.conditioning_set_values(
                            positive, {"reference_latents_method": ref_method}
                        )
                        negative = node_helpers.conditioning_set_values(
                            negative, {"reference_latents_method": ref_method}
                        )
                except Exception as e:
                    print(f"[Split Inpaint] reference_latents 附加失败，本区域退回普通重绘：{e}")

            # 每块用不同种子避免重复模式
            region_seed = seed + idx

            latent_out = nodes.common_ksampler(
                model, region_seed, steps, cfg, sampler_name, scheduler,
                positive, negative, {"samples": latent}, denoise=denoise
            )[0]

            # 2.7 解码：先等比缩回填充尺寸，再裁掉填充边恢复原始裁剪框尺寸。
            # 全程两方向缩放比相同，贴回内容与原图网格几何对齐，无各向异性漂移。
            decoded = vae.decode(latent_out["samples"])
            if decoded.ndim == 5:  # 视频类 VAE（如 Wan21 系）：只取第一帧
                decoded = decoded[:, 0]
            if not has_alpha and decoded.shape[-1] == 4:
                decoded = decoded[..., :3]
            decoded_padded = comfy.utils.common_upscale(
                decoded.movedim(-1, 1), padded_w, padded_h, "lanczos", "disabled"
            ).movedim(1, -1)
            decoded_resized = decoded_padded[
                :, pad_t:pad_t + crop_h, pad_l:pad_l + crop_w, :
            ]

            # 2.8 蒙版羽化
            if mask_blur > 0:
                region_mask = cv2.GaussianBlur(
                    region_mask, (0, 0), mask_blur
                )
            mask_t = torch.from_numpy(region_mask).to(
                device=current_image.device, dtype=current_image.dtype
            )
            if mask_t.ndim == 2:
                mask_t = mask_t.unsqueeze(-1)

            # 2.9 颜色匹配（只处理 RGB，alpha 不动；传入膨胀+羽化后的最终蒙版，统计在蒙版外采样）
            if color_match != "none" and color_strength > 0:
                ref_crop = orig_crop if orig_crop.shape[-1] <= 3 else orig_crop[..., :3]
                decoded_resized = _apply_color_match(
                    decoded_resized, ref_crop, color_match, color_strength, mask_np=region_mask
                )

            # 2.10 混合贴回（RGBA 模式下 alpha 通道一起被混合，由模型原生重绘）
            crop_old = current_image[:, y0:y1, x0:x1, :]
            blended = mask_t.unsqueeze(0) * decoded_resized + (1.0 - mask_t.unsqueeze(0)) * crop_old
            current_image[:, y0:y1, x0:x1, :] = blended

        return io.NodeOutput(current_image)


# 前端 JS 扩展目录（profile 切换时同步 context_factor / guide_size 滑条显示）
WEB_DIRECTORY = "./web"


class SplitInpaintExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [SplitInpaint, TextCacheWithHistory, SaveImageMetadata]


async def comfy_entrypoint() -> SplitInpaintExtension:
    return SplitInpaintExtension()


# Fallback: old-style node registration for backward compatibility
NODE_CLASS_MAPPINGS = {
    "SplitInpaint": SplitInpaint,
    "TextCacheWithHistory": TextCacheWithHistory,
    "SaveImageMetadata": SaveImageMetadata,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    # 英文基准（ComfyUI 官方 i18n 约定）；中文显示名由 locales/zh/nodeDefs.json 提供
    "SplitInpaint": "Split Inpaint",
    "TextCacheWithHistory": "Text Cache",
    "SaveImageMetadata": "Save Image Metadata",
}
