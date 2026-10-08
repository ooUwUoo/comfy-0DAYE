import math
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
                io.Float.Input("context_factor", default=1.58, min=1.0, max=4.0, step=0.01),
                io.Int.Input("guide_size", default=768, min=256, max=2048, step=32),
                io.Int.Input("steps", default=30, min=1, max=200),
                io.Float.Input("cfg", default=1.0, min=0.0, max=20.0, step=0.1),
                io.Combo.Input("sampler_name", options=comfy.samplers.KSampler.SAMPLERS, default="euler"),
                io.Combo.Input("scheduler", options=comfy.samplers.KSampler.SCHEDULERS, default="simple"),
                io.Float.Input("denoise", default=0.6, min=0.0, max=1.0, step=0.01,
                               tooltip="图生图模式的降噪强度，0.3~0.7 较自然；编辑模式内部固定使用 1.0"),
                io.Int.Input("seed", default=0, min=0, max=0x7fffffffffffffff),
                io.Int.Input("mask_expand", default=0, min=0, max=100, step=1),
                io.Float.Input("mask_blur", default=4.0, min=0.0, max=64.0, step=0.1),
                io.Int.Input("min_area", default=64, min=1, max=10000, step=1),
                io.Boolean.Input("process_alpha", default=False, label_on="RGBA:重算透明通道", label_off="RGBA:忽略"),
                io.Boolean.Input("img2img_mode", default=False, label_on="图生图模式", label_off="编辑模式"),
            ],
            outputs=[
                io.Image.Output(),
            ],
            description="按蒙版连通域切分，每块独立裁剪重绘后贴回；图生图通用，编辑模式需模型支持 reference_latents。cfg 按模型调整：Qwen≈1.0，SDXL≈7",
        )

    @classmethod
    def execute(cls, model, clip, vae, image, mask, prompt, negative_prompt,
                context_factor, guide_size, steps, cfg, sampler_name, scheduler,
                denoise, seed, mask_expand, mask_blur, min_area, process_alpha, img2img_mode):

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

            # 蒙版膨胀
            if mask_expand > 0:
                kernel = np.ones((mask_expand * 2 + 1, mask_expand * 2 + 1), np.uint8)
                region_mask = cv2.dilate(region_mask, kernel, iterations=1)

            # 2.3 计算目标尺寸（保持长宽比，对齐到32）
            if crop_w >= crop_h:
                target_w = guide_size
                target_h = int(round(guide_size * crop_h / crop_w / 32)) * 32
            else:
                target_h = guide_size
                target_w = int(round(guide_size * crop_w / crop_h / 32)) * 32
            target_w = max(32, target_w)
            target_h = max(32, target_h)

            # 2.4 缩放裁剪图
            resized_img = comfy.utils.common_upscale(
                crop_img.movedim(-1, 1), target_w, target_h, "lanczos", "disabled"
            ).movedim(1, -1)

            # 2.5 对齐到约 1MP（与 TextEncodeQwenImage21 的参考图规格一致）
            resolution = 1024
            samples = resized_img.movedim(-1, 1)
            ratio = samples.shape[3] / samples.shape[2]
            ref_w = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
            ref_h = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
            ref_w, ref_h = max(32, ref_w), max(32, ref_h)

            if (ref_w, ref_h) == (samples.shape[3], samples.shape[2]):
                ref_img = resized_img
            else:
                ref_img = comfy.utils.common_upscale(
                    samples, ref_w, ref_h, "lanczos", "disabled"
                ).movedim(1, -1)

            rgb = ref_img[:, :, :, :3]
            if ref_img.shape[-1] > 3:
                rgb = rgb * ref_img[:, :, :, 3:] + (1.0 - ref_img[:, :, :, 3:])  # 视觉塔看alpha叠白底，VAE保留4通道
            crop_latent = vae.encode(ref_img)

            # 2.6 起始 latent 与参考条件（通道数/尺寸全部由编码结果推导，不硬编码）
            if img2img_mode:
                # 图生图模式：图像只经起始 latent 进入。若同时把裁剪图喂给视觉塔，
                # 视觉 embeds 与起始 latent 同源 → 锚定过强，denoise<1 时几乎不改动（出原图）。
                latent = crop_latent
                ref_latents = []
                images_vl = []
            else:
                # 编辑模式：零张量起点 + 裁剪图作为 in-context 参考（denoise 应为 1.0）
                # 用 zeros_like 而不是手写形状：Krea2 / Anima 等 Wan21 系 VAE 会返回 5D latent，
                # 手写 [1, c, h, w] 会造出错误形状。
                latent = torch.zeros_like(
                    crop_latent, device=comfy.model_management.intermediate_device()
                )
                ref_latents = [crop_latent]
                images_vl = [rgb]

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

            # 2.7 解码并缩放回裁剪尺寸
            decoded = vae.decode(latent_out["samples"])
            if decoded.ndim == 5:  # 视频类 VAE（如 Wan21 系）：只取第一帧
                decoded = decoded[:, 0]
            if not has_alpha and decoded.shape[-1] == 4:
                decoded = decoded[..., :3]
            decoded_resized = comfy.utils.common_upscale(
                decoded.movedim(-1, 1), crop_w, crop_h, "lanczos", "disabled"
            ).movedim(1, -1)

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

            # 2.9 混合贴回（RGBA 模式下 alpha 通道一起被混合，由模型原生重绘）
            crop_old = current_image[:, y0:y1, x0:x1, :]
            blended = mask_t.unsqueeze(0) * decoded_resized + (1.0 - mask_t.unsqueeze(0)) * crop_old
            current_image[:, y0:y1, x0:x1, :] = blended

        return io.NodeOutput(current_image)


class SplitInpaintExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [SplitInpaint]


async def comfy_entrypoint() -> SplitInpaintExtension:
    return SplitInpaintExtension()


# Fallback: old-style node registration for backward compatibility
NODE_CLASS_MAPPINGS = {
    "SplitInpaint": SplitInpaint,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "SplitInpaint": "Split Inpaint",
}
