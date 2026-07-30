#!/usr/bin/env python3
"""Generate watermark test fixtures with known ground truth.

For each fixture we take a clean content image (the ground truth),
apply the Gemini watermark exactly as the C++ engine models it
(forward alpha blend with the calibrated alpha map at the profile's
formula position), and save both.

Covered profile branches (mirrors get_watermark_config /
v2_small_config_from_dims in watermark_engine.cpp):
  V1 small  (<=1024 either dim)      : 48px logo, margin 32
  V1 large  (both > 1024)            : 96px logo, margin 64
  V2 large  (both > 1024)            : 96px logo, margin 192
  V2 small 1024-class (2752/2816/2848 canonical inference): 36px logo
  V2 small half-scale (1376-class)   : 48px logo (alpha interpolated 96->48)
Negatives: clean images with no watermark (detection must skip).
Extra: one JPEG-recompressed watermarked fixture (residual-artifact case).

Inputs  (env):  GWT_REFERENCE_DIR/alpha/*.png  (run extract_alpha.py first)
                GWT_UPSTREAM_DIR/artworks/*.png (content material)
Outputs (env):  GWT_REFERENCE_DIR/fixtures/{originals,watermarked}/*.png
                GWT_REFERENCE_DIR/fixtures/fixtures.json
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from _common import reference_dir, require_file, upstream_dir

LOGO_VALUE = 255.0


def load_alpha(alpha_dir: Path, name: str) -> np.ndarray:
    """alpha = max(R,G,B)/255, float32 — mirrors calculate_alpha_map()."""
    path = require_file(alpha_dir / name, f"alpha capture {name}",
                        "Run tools/reference/extract_alpha.py first.")
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return img.max(axis=2) / 255.0


def half_scale(alpha: np.ndarray) -> np.ndarray:
    """Exact 2x downscale via 2x2 box mean == cv::INTER_AREA for 96->48."""
    h, w = alpha.shape
    return alpha.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))


def v2_small_config(W: int, H: int):
    """Port of v2_small_config_from_dims() — canonical-source inference.

    NOTE: C++ uses std::round (half away from zero); Python's round() is
    banker's rounding. No dimension in the fixture set below lands on a .5
    boundary, so the two agree here — but this divergence is real for
    arbitrary dimensions (CLAUDE.md porting rule 1).
    """
    long_side, short_side = max(W, H), min(W, H)
    if long_side > 1100:
        doubled = 2.0 * long_side
        source = min((2752.0, 2816.0, 2848.0), key=lambda c: abs(doubled - c))
    elif short_side >= 566:
        source = 2752.0
    elif short_side >= 550:
        source = 2816.0
    else:
        source = 2848.0
    scale = long_side / source
    margin = round(192.0 * scale)
    ideal = round(96.0 * scale)
    logo = 36 if ideal <= 40 else ideal
    return margin, logo


def content(art_dir: Path, source: str, size: tuple[int, int]) -> np.ndarray:
    """Deterministic content image: center-crop to aspect, LANCZOS resize."""
    W, H = size
    path = require_file(art_dir / source, f"content source {source}",
                        "GWT_UPSTREAM_DIR must point at the "
                        "GeminiWatermarkTool checkout root.")
    img = Image.open(path).convert("RGB")
    sw, sh = img.size
    target_ratio = W / H
    if sw / sh > target_ratio:  # too wide -> crop width
        cw = int(sh * target_ratio)
        img = img.crop(((sw - cw) // 2, 0, (sw - cw) // 2 + cw, sh))
    else:
        ch = int(sw / target_ratio)
        img = img.crop((0, (sh - ch) // 2, sw, (sh - ch) // 2 + ch))
    return np.asarray(img.resize((W, H), Image.LANCZOS), dtype=np.uint8)


def apply_watermark(rgb: np.ndarray, alpha: np.ndarray, x: int, y: int) -> np.ndarray:
    """watermarked = alpha*logo + (1-alpha)*original  (forward blend)."""
    out = rgb.astype(np.float32)
    h, w = alpha.shape
    a = alpha[:, :, None]
    region = out[y:y + h, x:x + w, :]
    out[y:y + h, x:x + w, :] = a * LOGO_VALUE + (1.0 - a) * region
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()

    art_dir = upstream_dir() / "artworks"
    ref = reference_dir()
    alpha_dir = ref / "alpha"
    orig_dir = ref / "fixtures/originals"
    wm_dir = ref / "fixtures/watermarked"

    orig_dir.mkdir(parents=True, exist_ok=True)
    wm_dir.mkdir(parents=True, exist_ok=True)

    a_v1_48 = load_alpha(alpha_dir, "bg_48.png")
    a_v1_96 = load_alpha(alpha_dir, "bg_96.png")
    a_v2_36 = load_alpha(alpha_dir, "bg_b_36.png")
    a_v2_96 = load_alpha(alpha_dir, "bg_b_96.png")
    a_v2_48 = half_scale(a_v2_96)  # half-scale free-tier logo

    # name -> (W, H, variant, margin, logo, alpha, content_source)
    cases = []

    def v1_case(name, W, H, src):
        small = not (W > 1024 and H > 1024)
        margin, logo = (32, 48) if small else (64, 96)
        alpha = a_v1_48 if small else a_v1_96
        cases.append((name, W, H, "V1", margin, logo, alpha, src))

    def v2_case(name, W, H, src):
        if W > 1024 and H > 1024:
            margin, logo = 192, 96
            alpha = a_v2_96
        else:
            margin, logo = v2_small_config(W, H)
            alpha = {36: a_v2_36, 48: a_v2_48}[logo]
        cases.append((name, W, H, "V2", margin, logo, alpha, src))

    v1_case("v1-small-800x600", 800, 600, "comparison.png")
    v1_case("v1-large-1500x1200", 1500, 1200, "gui_demo.png")
    v2_case("v2-large-2752x1536", 2752, 1536, "gui_demo.png")
    # Busy-background hard case: high-contrast text edges under the logo.
    # The C++ detector itself skips this at the default threshold (spatial
    # ~0.27, grad/var collapse) -- the port must reproduce the skip.
    v2_case("v2-large-2752x1536-hard", 2752, 1536, "comparison.png")
    v2_case("v2-large-1500x1200", 1500, 1200, "preview.png")
    v2_case("v2-small-1024x572", 1024, 572, "comparison.png")   # 2752-class
    v2_case("v2-small-1024x559", 1024, 559, "gui_demo.png")     # 2816-class
    v2_case("v2-small-1024x540", 1024, 540, "preview.png")      # 2848-class
    v2_case("v2-small-1376x768", 1376, 768, "comparison.png")   # half-scale, 48px
    v2_case("v2-small-572x1024", 572, 1024, "gui_demo.png")     # portrait

    manifest = {"fixtures": [], "negatives": []}

    for name, W, H, variant, margin, logo, alpha, src in cases:
        rgb = content(art_dir, src, (W, H))
        x, y = W - margin - logo, H - margin - logo
        wm = apply_watermark(rgb, alpha, x, y)
        Image.fromarray(rgb).save(orig_dir / f"{name}.png")
        Image.fromarray(wm).save(wm_dir / f"{name}.png")
        manifest["fixtures"].append({
            "name": name, "width": W, "height": H, "variant": variant,
            "margin": margin, "logo_size": logo,
            "position": {"x": x, "y": y}, "content_source": src,
        })
        print(f"{name}: {W}x{H} {variant} logo={logo} margin={margin} pos=({x},{y})")

    # JPEG-recompressed variant of one V2-large fixture (breaks exact math)
    jpeg_src = wm_dir / "v2-large-2752x1536.png"
    jpeg_name = "v2-large-2752x1536-q90"
    Image.open(jpeg_src).save(wm_dir / f"{jpeg_name}.jpg", quality=90)
    manifest["fixtures"].append({
        "name": jpeg_name, "width": 2752, "height": 1536, "variant": "V2",
        "margin": 192, "logo_size": 96, "position": {"x": 2464, "y": 1248},
        "content_source": "gui_demo.png", "jpeg_quality": 90,
        "note": "recompressed after watermarking; exact inversion no longer holds",
    })
    print(f"{jpeg_name}: JPEG q90 recompression case")

    # Negatives: clean images, detection must skip (CLI exit code 1)
    for name, W, H, src in [
        ("clean-800x600", 800, 600, "comparison.png"),
        ("clean-2752x1536", 2752, 1536, "comparison.png"),
        ("clean-1024x572", 1024, 572, "preview.png"),
    ]:
        Image.fromarray(content(art_dir, src, (W, H))).save(wm_dir / f"{name}.png")
        manifest["negatives"].append(
            {"name": name, "width": W, "height": H, "content_source": src})
        print(f"{name}: negative (clean)")

    (ref / "fixtures/fixtures.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nWrote {len(manifest['fixtures'])} watermarked + "
          f"{len(manifest['negatives'])} clean fixtures")


if __name__ == "__main__":
    main()
