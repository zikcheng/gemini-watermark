#!/usr/bin/env python3
"""Crop the committed CI test data out of the full-size reference kit.

The kit's images are far too large to commit, but the port's tests only
need the pixels the engine actually touches. Two crops per case:

- **detection patch** — every region `detect_one_variant` reads for either
  variant (template ROI + variance reference strip), unioned and padded.
  Tests rebuild a zero-filled full-size buffer and place the patch back at
  its recorded origin (`test/helpers/reconstruct.ts`); a bare crop must
  never be fed in as an image, since its dimensions would change every
  geometry inference.
- **blend crop** — the watermark region ±8px, for region-math tests only.

The JPEG case is cropped from cv2-decoded pixels: that is what the
reference binary consumed, and the TypeScript side never decodes JPEG.

Inputs  (env):  GWT_REFERENCE_DIR/fixtures/, GWT_REFERENCE_DIR/golden/
Inputs  (arg):  test/data/manifest.json (geometry, eligibility, run results)
Outputs (arg):  test/data/cases/<name>/
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (decoded_pixel_sha256, die,  # noqa: E402
                     require_file, resolve_env_dirs)
from _geometry import (Rect, contains, detection_rects,  # noqa: E402
                       expand_clamp, union_rects)

# Padding around the unioned detection regions and around the watermark
# region for blend crops (M0.md commit 3).
PATCH_PAD = 8
BLEND_PAD = 8

# Committed test data budget (KiB). M0.md acceptance: test/data < 4MB.
MAX_TEST_DATA_KB = 4096


def load_bgr(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        die(f"could not decode image: {path}")
    return img


def crop(img: np.ndarray, rect: Rect) -> np.ndarray:
    return img[rect.y:rect.y2, rect.x:rect.x2]


def write_crop(img: np.ndarray, rect: Rect, out: Path) -> dict:
    """Write one crop and return its manifest entry (name + pixel identity)."""
    region = crop(img, rect)
    if region.shape[0] != rect.h or region.shape[1] != rect.w:
        die(f"{out.name}: crop is {region.shape[1]}x{region.shape[0]}, "
            f"expected {rect.w}x{rect.h}")
    if not cv2.imwrite(str(out), region):
        die(f"failed to write {out}")
    # Self-check: the file must decode back to exactly the pixels we cropped.
    if not np.array_equal(load_bgr(out), region):
        die(f"{out}: re-decoded pixels differ from the crop")
    return {"file": out.name, "decoded_pixel_sha256": decoded_pixel_sha256(out)}


def patch_rects(case: dict) -> list:
    """Every region the detector reads for this case, in try order.

    Mirrors the default run (V2 first, then the V1 fallback) plus, for
    forced-size cases, the combination that run actually used -- read from
    the manifest rather than re-derived, since the forced template is what
    upstream resolved, not what the flag names (DEVIATIONS D3).
    """
    w, h = case["input"]["width"], case["input"]["height"]
    rects = []
    for variant in ("V2", "V1"):
        rects += detection_rects(w, h, variant)

    forced = case["runs"].get("forced_size")
    if forced:
        rects += detection_rects(w, h, forced["removal_variant"],
                                 force_size=forced["removal_size"].lower())
    if not rects:
        die(f"{case['name']}: no detection regions -- refusing to emit a patch")
    return rects


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("test/data/manifest.json"),
                        help="manifest produced by gen_golden.py")
    parser.add_argument("--out", type=Path, default=Path("test/data/cases"),
                        help="output directory for the per-case patch data")
    parser.add_argument("--budget-root", type=Path, default=Path("test/data"),
                        help="directory the size budget applies to; stated "
                             "explicitly so a scratch --out cannot silently "
                             "measure some other tree (default: test/data)")
    args = parser.parse_args()

    ref = resolve_env_dirs("GWT_REFERENCE_DIR")["GWT_REFERENCE_DIR"]
    manifest_path = require_file(args.manifest, "manifest",
                                 "Run tools/reference/gen_golden.py first.")
    manifest = json.loads(manifest_path.read_text())

    wm_dir = ref / "fixtures/watermarked"
    orig_dir = ref / "fixtures/originals"
    golden = ref / "golden"

    out_root = args.out
    if out_root.exists():
        # Regenerate from scratch so a renamed or dropped case cannot leave
        # a stale directory behind in the committed data.
        shutil.rmtree(out_root)
    out_root.mkdir(parents=True)

    for case in manifest["cases"]:
        name = case["name"]
        w, h = case["input"]["width"], case["input"]["height"]
        fx, runs = case["fixture"], case["runs"]

        rects = patch_rects(case)
        bbox = expand_clamp(union_rects(rects), PATCH_PAD, w, h)
        # Enforced self-check: the patch must cover every region the
        # detector reads, or the reconstructed image would silently differ.
        for rect in rects:
            if not contains(bbox, rect):
                die(f"{name}: patch bbox {tuple(bbox)} does not cover "
                    f"detector region {tuple(rect)}")

        case_dir = out_root / name
        case_dir.mkdir()

        ext = "jpg" if case["input"]["format"] == "jpg" else "png"
        sources = {"watermarked": wm_dir / f"{name}.{ext}"}
        if (orig_dir / f"{name}.png").is_file():
            sources["original"] = orig_dir / f"{name}.png"
        if runs["default"]["output_written"]:
            sources["golden_default"] = golden / "default" / f"{name}.png"
        if runs.get("force", {}).get("output_written"):
            sources["golden_force"] = golden / "force" / f"{name}.png"
        if runs.get("forced_size", {}).get("output_written"):
            sources["golden_forced_size"] = golden / "forced_size" / f"{name}.png"

        images = {}
        for role, path in sources.items():
            require_file(path, f"{name} {role} image",
                         "Regenerate the kit (see tools/reference/README.md).")
            img = load_bgr(path)
            if img.shape[1] != w or img.shape[0] != h:
                die(f"{name} {role}: image is {img.shape[1]}x{img.shape[0]}, "
                    f"manifest says {w}x{h}")
            images[role] = img

        patch_files = {
            role: write_crop(img, bbox, case_dir / f"patch-{role.replace('_', '-')}.png")
            for role, img in images.items()
        }

        blend = None
        if fx is not None:
            region = Rect(fx["position"]["x"], fx["position"]["y"],
                          fx["logo_size"], fx["logo_size"])
            blend_bbox = expand_clamp(region, BLEND_PAD, w, h)
            if not contains(blend_bbox, region):
                die(f"{name}: blend bbox does not cover the watermark region")
            blend_files = {
                role: write_crop(images[role], blend_bbox,
                                 case_dir / f"blend-{role.replace('_', '-')}.png")
                for role in ("watermarked", "original", "golden_force")
                if role in images
            }
            blend = {
                "bbox": bbox_json(blend_bbox),
                # Where the watermark sits inside the crop: blend tests call
                # the region functions in crop coordinates.
                "watermark_region_in_crop": {
                    "x": region.x - blend_bbox.x, "y": region.y - blend_bbox.y,
                    "w": region.w, "h": region.h,
                },
                "files": blend_files,
            }

        meta = {
            "name": name,
            "original_size": {"width": w, "height": h},
            "input_format": case["input"]["format"],
            "eligible_for": list(case["eligible_for"]),
            "fixture": fx,
            "patch": {
                "bbox": bbox_json(bbox),
                "channels": 3,
                "files": patch_files,
            },
            "blend": blend,
        }
        (case_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

        print(f"{name}: patch {bbox.w}x{bbox.h} at ({bbox.x},{bbox.y}) "
              f"[{len(patch_files)} files]"
              + (f" | blend {blend['bbox']['w']}x{blend['bbox']['h']} "
                 f"[{len(blend['files'])} files]" if blend else " | no blend"))

    check_size(args.budget_root)


def bbox_json(rect: Rect) -> dict:
    return {"x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h}


def check_size(test_data: Path) -> None:
    """Enforce the committed-data budget at generation time.

    Measured in allocated blocks so the number matches `du -sk test/data`,
    which is how M0.md states the budget: with ~100 small files the block
    overhead is a non-trivial fraction, and a byte sum would under-report.
    """
    if not test_data.is_dir():
        die(f"budget root is not a directory: {test_data}")
    total = 0
    for path in test_data.rglob("*"):
        if not path.is_file():
            continue
        stat = path.stat()
        blocks = getattr(stat, "st_blocks", None)
        total += blocks * 512 if blocks is not None else stat.st_size
    kb = total // 1024
    if kb >= MAX_TEST_DATA_KB:
        die(f"{test_data} is {kb} KiB, over the {MAX_TEST_DATA_KB} KiB budget")
    print(f"\n{test_data}: {kb} KiB (budget {MAX_TEST_DATA_KB} KiB, du -sk semantics)")


if __name__ == "__main__":
    main()
