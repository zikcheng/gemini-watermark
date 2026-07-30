#!/usr/bin/env python3
"""Dump cv2 operator behavior as committed oracle data.

OpenCV's numeric behavior differs from textbook formulas in ways that
silently shift results — fixed-point grayscale, DFT-based matchTemplate,
INTER_AREA coverage weighting, and the rounding law this file pins first.
The port therefore verifies its primitives against **measured** output of
the pinned opencv-python, never against reasoning about what OpenCV
"should" do.

Covered here: the quantization law (M0) and the five primitives the
detector needs — BGR2GRAY, Sobel magnitude, meanStdDev, TM_CCOEFF_NORMED
and resize (M3.md commit 1). New dumps register with @dump and return
`(meta, arrays)`; array-valued operators land as `.bin` siblings of the
`.json`, scalar tables live in the JSON itself.

**Channel order.** cv2 works in BGR: `cv2.imread` returns BGR and
`COLOR_BGR2GRAY` expects it. This port is RGB-native — `decodePng` in the
test helpers returns RGB. The two are the same pixels with the channel
axis reversed, and the grayscale coefficients attach to *colours* (red,
green, blue), not to positions, so the port applies them to its R/G/B and
gets the same byte. Every dump below records the channel order of what cv2
was handed, so a consumer can never guess wrong.

**Inputs.** Real-image cases name a committed file under `test/data/cases/`
rather than duplicating its pixels, so the test decodes the same PNG the
dump was made from. Synthetic inputs have no such home and are written out
as `.bin` beside the outputs.

**Reading a dump.** Fields like `output`, `result` and `input` hold *array
keys*, not filenames. Resolve them through the `arrays` block, which also
carries the dtype and shape needed to read the buffer:
`arrays[key] -> {file, dtype, shape}`. The indirection is deliberate — it
keeps shape and dtype in one place — but it does mean a consumer never
constructs a `.bin` path by hand.

Environment: `GWT_REFERENCE_DIR` is needed only by the dumps that read the
calibrated alpha captures, and is resolved lazily — `--only quantize-u8`
still runs anywhere.

Usage:  python3 tools/reference/dump_imageops.py [--only NAME]...
Exits:  0 written · 2 usage or measurement failure
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import die, reference_dir, require_file  # noqa: E402

# Committed crops used as real-image inputs. Blend crops rather than the
# larger detection patches: they carry the same kind of content, and the
# whole point is to keep the dumps inside the 4 MB budget.
CASES_ROOT = Path("test/data/cases")
REAL_INPUTS = [
    ("v1-small-800x600", "blend-watermarked.png"),
    ("v2-large-2752x1536", "blend-watermarked.png"),
    ("v2-small-1024x572", "blend-watermarked.png"),
]

_alpha_cache: dict = {}


def alpha_source(name: str) -> np.ndarray:
    """A calibrated capture as float32 alpha, straight from the kit.

    `alpha = max(R,G,B) / 255` — `calculate_alpha_map`, blend_modes.cpp.
    The max is order-free, so BGR vs RGB does not arise here.
    """
    if name not in _alpha_cache:
        path = require_file(
            reference_dir() / "alpha" / name,
            f"alpha capture {name}",
            "Run tools/reference/extract_alpha.py first.",
        )
        bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if bgr is None:
            die(f"could not decode {path}")
        _alpha_cache[name] = (bgr.max(axis=2).astype(np.float32) / 255.0)
    return _alpha_cache[name]


def real_bgr(case: str, file: str) -> np.ndarray:
    """Decode a committed crop exactly as cv2 does: BGR uint8."""
    path = require_file(CASES_ROOT / case / file, f"{case}/{file}",
                        "Run tools/reference/make_patches.py first.")
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        die(f"could not decode {path}")
    return img


def divergent_triples(count: int) -> np.ndarray:
    """BGR triples where a float BT.601 formula disagrees with OpenCV's.

    OpenCV's 8-bit grayscale is fixed-point; the textbook float weights are
    a plausible-looking substitute that produces a *different byte* on
    about 0.137% of the 16.7M RGB triples. Photographic content hits that
    thinly — on the real crops the substitution moves a single pixel — so
    without help the dump would let the wrong formula through almost
    unnoticed.

    These triples make the difference deterministic instead: every one of
    them changes value under the substitution. Chosen by scanning all
    triples in a fixed order and taking an evenly spaced subset, so the
    selection is reproducible and spread across the colour cube rather
    than clustered in one corner.

    "The substitution" is not one formula but two, because the float
    version still has to round: half-to-even (numpy's `rint`) and half-up
    (JavaScript's `Math.round`) disagree on exact .5 sums. Requiring
    divergence under *both* costs little — 19358 triples qualify against
    22906 and 22411 for either alone — and means the probe catches the
    wrong formula whichever rounding its author reached for.
    """
    axis = np.arange(256, dtype=np.int64)
    r, g, b = np.meshgrid(axis, axis, axis, indexing="ij")
    fixed = (9798 * r + 19235 * g + 3735 * b + 16384) >> 15
    exact = 0.299 * r + 0.587 * g + 0.114 * b
    half_even = np.rint(exact).astype(np.int64)
    half_up = np.floor(exact + 0.5).astype(np.int64)

    found = np.argwhere((fixed != half_even) & (fixed != half_up))
    if len(found) < count:
        die(f"only {len(found)} divergent triples available, needed {count}")
    picked = found[:: len(found) // count][:count]
    # argwhere gives (R, G, B); cv2 wants BGR.
    return picked[:, ::-1].astype(np.uint8)


def synthetic_full_range() -> np.ndarray:
    """A 16x32 BGR image: a full-range walk above, divergence probes below.

    Deterministic by construction, no randomness anywhere.

    The top 16 rows carry 256 pixels, one per intensity, with the three
    channels rolled against each other so no two channels share a value at
    the same pixel — that is what makes a channel mix-up move every pixel
    rather than a fraction of them.

    The bottom 16 rows are `divergent_triples`, which do the complementary
    job: they separate OpenCV's fixed-point grayscale from the float
    formula that superficially matches it.
    """
    values = np.arange(256, dtype=np.uint8)
    walk = np.stack([values, np.roll(values, 85), np.roll(values, 170)], axis=1)
    return np.concatenate([walk, divergent_triples(256)]).reshape(32, 16, 3)

FORMAT_VERSION = 1

# name -> producer, populated by @dump
PRODUCERS: dict = {}


def dump(name: str):
    """Register a dump producer returning `(meta, arrays)`.

    Names must not prefix one another. The stale-file cleanup identifies a
    dump's own output as `<name>.json` or anything starting `<name>-`, so
    adding a dump called `resize` beside `resize-alpha` would make the
    first one delete the second's arrays. Cheap to check here, very
    confusing to debug later.
    """

    def register(fn):
        for existing in PRODUCERS:
            longer, shorter = sorted((name, existing), key=len, reverse=True)
            if longer.startswith(f"{shorter}-"):
                die(f"dump name {longer!r} is prefixed by {shorter!r}; the "
                    f"stale-file cleanup would delete one dump's arrays when "
                    f"regenerating the other. Rename one of them.")
        PRODUCERS[name] = fn
        return fn

    return register


def write_dump(out_dir: Path, name: str, meta: dict, arrays: dict | None) -> list:
    """Write `<name>.json` plus one `.bin` per array, return filenames.

    Arrays are raw little-endian buffers of their declared dtype; the JSON
    records dtype and shape so a reader never has to guess. Scalar tables
    stay in the JSON — a ten-value `.bin` would be harder to read than the
    numbers themselves, and duplicating them in both places would give the
    oracle two sources of truth.
    """
    if arrays and sys.byteorder != "little":
        die("the .bin dump format is little-endian (docs/plan/M3.md); this "
            f"host is {sys.byteorder}-endian, so the bytes would be wrong.")

    written = []
    array_meta = {}
    for key, array in (arrays or {}).items():
        if array.dtype.byteorder not in ("=", "|"):
            die(f"{name}.{key}: expected native byte order, got {array.dtype}")
        filename = f"{name}-{key}.bin"
        (out_dir / filename).write_bytes(array.tobytes())
        array_meta[key] = {
            "file": filename,
            "dtype": str(array.dtype),
            "shape": list(array.shape),
        }
        written.append(filename)

    payload = {
        "format_version": FORMAT_VERSION,
        "name": name,
        "cv2_version": cv2.__version__,
        "command": f"python3 tools/reference/dump_imageops.py --only {name}",
        **meta,
    }
    if array_meta:
        payload["arrays"] = array_meta
    (out_dir / f"{name}.json").write_text(json.dumps(payload, indent=2) + "\n")
    written.append(f"{name}.json")
    return written


# Values chosen to separate the three rounding laws that coexist in this
# port (CLAUDE.md rule 5) and to pin saturation on both ends:
#   .5 ties      -- half-even returns 0/2/2/128/254, half-up would give
#                   1/2/3/128/255, half-away-from-zero the same as half-up
#   tie boundary -- the two float32 neighbours of 0.5 isolate the tie rule
#                   itself from ordinary rounding
#   out of range -- negative and >255 inputs pin the saturate_cast clamp
TIE_BELOW = float(np.nextafter(np.float32(0.5), np.float32(0)))
TIE_ABOVE = float(np.nextafter(np.float32(0.5), np.float32(1)))

QUANTIZE_INPUTS = [
    ("-0.6", -0.6), ("-0.5", -0.5), ("0.0", 0.0), ("0.4", 0.4),
    ("nextafter(0.5, 0)", TIE_BELOW), ("0.5", 0.5), ("nextafter(0.5, 1)", TIE_ABOVE),
    ("1.5", 1.5), ("2.5", 2.5), ("3.5", 3.5),
    ("127.5", 127.5), ("128.5", 128.5),
    ("253.5", 253.5), ("254.5", 254.5), ("255.0", 255.0),
    ("255.4", 255.4), ("255.5", 255.5), ("256.4", 256.4),
]


def reference_quantize(value: float) -> int:
    """clamp(half-to-even(v), 0, 255) — the law CLAUDE.md rule 5 states.

    Written out so the dump can record whether the stated law actually
    reproduces the measurement, instead of asserting it in prose.
    """
    # Python's round() is half-to-even, which is the point here.
    return int(min(255, max(0, round(value))))


@dump("quantize-u8")
def quantize_u8():
    """Measure `saturate_cast<uchar>` on float input.

    C++ writes blend results back with `convertTo(CV_8UC3)`, i.e.
    `saturate_cast<uchar>` == `cvRound` + clamp. opencv-python exposes no
    `Mat::convertTo`, so the conversion is driven through ops carrying an
    output depth — the same code path inside OpenCV. Several independent
    ops are compared so the numbers are a property of the conversion
    rather than of one API.
    """
    src = np.array([v for _, v in QUANTIZE_INPUTS], dtype=np.float32).reshape(1, -1)
    zeros = np.zeros_like(src)

    routes = {
        "cv2.add(src, 0, dtype=CV_8U)": cv2.add(src, 0.0, dtype=cv2.CV_8U),
        "cv2.subtract(src, 0, dtype=CV_8U)": cv2.subtract(src, 0.0, dtype=cv2.CV_8U),
        "cv2.addWeighted(src, 1, zeros, 0, 0, dtype=CV_8U)": cv2.addWeighted(
            src, 1.0, zeros, 0.0, 0.0, dtype=cv2.CV_8U),
    }

    # normalize() is the one route that literally calls Mat::convertTo
    # internally. NORM_MINMAX with alpha/beta set to the data's own extremes
    # makes the rescale an exact identity (the scale divides a quantity by
    # itself), leaving the conversion as the only thing being measured.
    lo, hi = float(src.min()), float(src.max())
    scale = (hi - lo) / (hi - lo)
    if scale != 1.0:
        die(f"normalize() rescale is {scale!r}, not exactly 1.0 — it would be "
            f"measuring its own arithmetic instead of the conversion.")
    routes["cv2.normalize(src, NORM_MINMAX, alpha=min, beta=max, dtype=CV_8U)"] = (
        cv2.normalize(src, None, alpha=lo, beta=hi,
                      norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U))

    measured = routes["cv2.add(src, 0, dtype=CV_8U)"]
    for route, result in routes.items():
        if not np.array_equal(result, measured):
            die(f"cv2 quantization routes disagree ({route}); the measurement "
                f"is not a stable property of the conversion — stop and "
                f"record this before generating any oracle data.")

    samples = []
    mismatches = []
    for i, (label, _) in enumerate(QUANTIZE_INPUTS):
        # The float32 value cv2 actually saw, widened to a double so a
        # JSON reader tests the same number (255.4 is not representable in
        # float32, and a JS `255.4` literal is a different value again).
        exact = float(src.flat[i])
        out = int(measured.flat[i])
        expected = reference_quantize(exact)
        samples.append({
            "label": label,
            "input": exact,
            "output": out,
            "matches_clamped_half_even": out == expected,
        })
        if out != expected:
            mismatches.append((label, exact, out, expected))

    meta = {
        "description":
            "saturate_cast<uchar> applied to float32, as measured in "
            f"opencv-python {cv2.__version__}. This is the operation C++ uses "
            "to write blend results back (convertTo(CV_8UC3)), but measured "
            "in a different OpenCV build than the reference binary — see "
            "measured_against. Consumed by src/quantize.ts (M2).",
        "measured_via": sorted(routes),
        "routes_agree": True,
        "route_notes": {
            "cv2.normalize(src, NORM_MINMAX, alpha=min, beta=max, dtype=CV_8U)":
                "The only route that literally calls Mat::convertTo. It is an "
                "identity rescale only because alpha/beta are this sample "
                "set's own extremes, so it corroborates the arithmetic routes "
                "on exactly these values and cannot be reused to probe other "
                "inputs independently.",
        },
        "measured_against": {
            "opencv_python": cv2.__version__,
            "reference_binary_opencv": "4.11.0",
            "reference_binary_opencv_source":
                "statically linked; version string read out of "
                "$GWT_REFERENCE_DIR/bin/gwt-mini",
            "caveat":
                "The two OpenCV versions differ. cvRound is documented as "
                "implementation- and FP-rounding-mode-dependent, so this dump "
                "pins the law for the port's own arithmetic but is not "
                "self-sufficient proof that the reference binary rounds the "
                "same way. What actually ties the law to the binary is the "
                "golden-force pixel comparison in M2 (restored pixels within "
                "+-1, outside-region byte-exact); if that ever disagrees, the "
                "golden images win over this dump.",
        },
        "reference_law": "clamp(half-to-even(v), 0, 255)",
        "reference_law_matches_measurement": not mismatches,
        "samples": samples,
    }
    if mismatches:
        # Not fatal here: the measurement is authoritative and must be
        # recorded either way. The caller decides what a divergence means.
        meta["reference_law_mismatches"] = [
            {"label": lb, "input": v, "measured": got, "reference_law": want}
            for lb, v, got, want in mismatches
        ]
    return meta, None


def gray_inputs() -> list:
    """(label, source description, BGR uint8) for every grayscale input."""
    entries = []
    for case, file in REAL_INPUTS:
        entries.append((case, {"kind": "case_file", "path": f"{case}/{file}"},
                        real_bgr(case, file)))
    entries.append(("synthetic-16x32",
                    {"kind": "array", "note": "generated by synthetic_full_range()"},
                    synthetic_full_range()))
    return entries


@dump("bgr2gray")
def bgr2gray():
    """cv2.cvtColor(..., COLOR_BGR2GRAY) on uint8.

    Upstream calls this on the detection ROI before every stage
    (detect_one_variant, watermark_engine.cpp). OpenCV's 8-bit path is
    fixed-point, not the float textbook formula, which is why it is
    measured here rather than derived.
    """
    arrays, inputs = {}, []
    for label, source, bgr in gray_inputs():
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        arrays[f"{label}-gray"] = gray
        if source["kind"] == "array":
            arrays[f"{label}-input"] = bgr
        inputs.append({
            "label": label, "source": source,
            "height": int(bgr.shape[0]), "width": int(bgr.shape[1]),
            "channel_order": "BGR",
            "output": f"{label}-gray",
        })
    return {
        "description":
            "COLOR_BGR2GRAY on uint8 BGR input; output uint8. The port "
            "applies the fixed-point coefficients to its RGB buffer, which "
            "is the same pixels with the channel axis reversed.",
        "operation": "cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)",
        "inputs": inputs,
    }, arrays


@dump("sobel-magnitude")
def sobel_magnitude():
    """sqrt(gx^2 + gy^2) from two 3x3 Sobel passes, exactly as stage 2 does.

    Upstream feeds `gray_f` (the uint8 gray scaled by 1/255) and the alpha
    region through `Sobel(..., CV_32F, 1, 0, 3)` / `(0, 1, 3)` and combines
    them with `magnitude`. Every default is left alone: scale 1, delta 0,
    BORDER_DEFAULT.
    """
    arrays, inputs = {}, []
    for label, source, bgr in gray_inputs():
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        # Dumped rather than left for the consumer to recompute. The scaling
        # is OpenCV's float32 multiply and the port's float64 divide, which
        # disagree by one ulp on about half the byte values (DEVIATIONS D4);
        # recomputing it test-side would fold that into the Sobel comparison
        # and make an operator test fail for an input reason.
        gray_f = gray.astype(np.float32) * np.float32(1.0 / 255.0)
        gx = cv2.Sobel(gray_f, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray_f, cv2.CV_32F, 0, 1, ksize=3)
        arrays[f"{label}-gray-f32"] = gray_f
        arrays[f"{label}-magnitude"] = cv2.magnitude(gx, gy)
        inputs.append({
            "label": label, "source": source,
            "input": f"{label}-gray-f32",
            "output": f"{label}-magnitude",
        })

    alpha = alpha_source("bg_b_96.png")
    gx = cv2.Sobel(alpha, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(alpha, cv2.CV_32F, 0, 1, ksize=3)
    arrays["v2-96-alpha-magnitude"] = cv2.magnitude(gx, gy)
    arrays["v2-96-alpha"] = alpha
    inputs.append({
        "label": "v2-96-alpha",
        "source": {"kind": "alpha_map", "variant": "V2", "size": "large"},
        "input": "v2-96-alpha", "output": "v2-96-alpha-magnitude",
    })

    return {
        "description":
            "3x3 Sobel magnitude on float32 input, the stage-2 edge "
            "signature. Every `input` is an array key holding the exact "
            "float32 cv2 was handed — the grayscale scaling uses OpenCV's "
            "float32 work type while the port divides in float64 "
            "(docs/plan/DEVIATIONS.md D4), so the input is dumped rather "
            "than recomputed.",
        "operation":
            "magnitude(Sobel(src, CV_32F, 1, 0, ksize=3), "
            "Sobel(src, CV_32F, 0, 1, ksize=3))",
        "sobel_params": {"ddepth": "CV_32F", "ksize": 3, "scale": 1, "delta": 0,
                         "borderType": "BORDER_DEFAULT (BORDER_REFLECT_101)"},
        "inputs": inputs,
    }, arrays


@dump("mean-stddev")
def mean_stddev():
    """cv2.meanStdDev on each image, for the stage-3 variance ratio.

    Upstream calls this on the **uint8** grayscale regions, not on the
    scaled float — `meanStdDev(gray_region, ...)` in detect_one_variant.
    Getting that wrong would rescale the standard deviation by 255 and
    silently change every variance score, so the uint8 inputs are dumped
    here and the float alpha map is dumped alongside for contrast.
    """
    samples = []
    for label, source, bgr in gray_inputs():
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        mean, stddev = cv2.meanStdDev(gray)
        samples.append({
            "label": label, "source": source, "dtype": "uint8",
            "mean": float(mean[0][0]), "stddev": float(stddev[0][0]),
        })

    alpha = alpha_source("bg_b_96.png")
    mean, stddev = cv2.meanStdDev(alpha)
    samples.append({
        "label": "v2-96-alpha",
        "source": {"kind": "alpha_map", "variant": "V2", "size": "large"},
        "dtype": "float32",
        "mean": float(mean[0][0]), "stddev": float(stddev[0][0]),
    })

    return {
        "description":
            "meanStdDev over whole single-channel images. OpenCV's stddev "
            "is the population form (divides by N, not N-1). Upstream feeds "
            "it uint8 grays.",
        "operation": "cv2.meanStdDev(src)",
        "samples": samples,
    }, None


@dump("match-template-ccoeff-normed")
def match_template():
    """TM_CCOEFF_NORMED, including the degenerate cases.

    Stages 1 and 2 both slide a template with this. The degenerate rows are
    the calibration for the denominator guard the port needs: OpenCV does
    not return NaN for zero-variance inputs, it returns particular numbers,
    and they are **asymmetric** — a constant template scores 1, while a
    flat search region under a varied template scores 0. Reasoning would
    not have produced that; measuring did.
    """
    arrays, cases = {}, []

    def record(label, image, template, note, source=None):
        result = cv2.matchTemplate(image, template, cv2.TM_CCOEFF_NORMED)
        arrays[f"{label}-result"] = result
        finite = np.isfinite(result)
        cases.append({
            "label": label, "note": note,
            "source": source or {"kind": "array"},
            "image_shape": [int(n) for n in image.shape],
            "template_shape": [int(n) for n in template.shape],
            "result": f"{label}-result",
            "min": float(np.min(result[finite])) if finite.any() else None,
            "max": float(np.max(result[finite])) if finite.any() else None,
            "nonfinite_count": int((~finite).sum()),
        })
        return result

    # Two real pairs: a grayscale crop searched with the alpha template of
    # its own profile, which is exactly what stage 1 does.
    for case, file, alpha_file in [
        ("v2-large-2752x1536", "blend-watermarked.png", "bg_b_96.png"),
        ("v2-small-1024x572", "blend-watermarked.png", "bg_b_36.png"),
    ]:
        gray = cv2.cvtColor(real_bgr(case, file), cv2.COLOR_BGR2GRAY)
        gray_f = gray.astype(np.float32) * np.float32(1.0 / 255.0)
        arrays[f"{case}-gray-f32"] = gray_f
        record(case, gray_f, alpha_source(alpha_file),
               "real grayscale crop searched with its profile's alpha template",
               {"kind": "case_file", "path": f"{case}/{file}",
                "template": alpha_file})

    flat = np.full((12, 12), 0.5, np.float32)
    varied = (np.arange(16, dtype=np.float32).reshape(4, 4) / 16.0).copy()
    constant = np.full((4, 4), 0.5, np.float32)

    arrays["degenerate-flat-image"] = flat
    arrays["degenerate-varied-template"] = varied
    arrays["degenerate-constant-template"] = constant

    record("flat-image-varied-template", flat, varied,
           "zero-variance search region, varying template")
    # Dumped rather than left implicit: a consumer that had to rebuild this
    # by hand would be encoding the generator's upscaling rule in a second
    # place, where nothing would notice the two drifting apart.
    varied_image = varied.repeat(3, 0).repeat(3, 1).copy()
    arrays["degenerate-varied-image"] = varied_image
    record("varied-image-constant-template", varied_image,
           constant, "varying search region, zero-variance template")
    record("both-constant", flat, constant, "both zero-variance")

    perturbed = flat.copy()
    perturbed[6, 6] = np.float32(0.6)
    arrays["degenerate-perturbed-image"] = perturbed
    record("single-pixel-perturbation-constant-template", perturbed, constant,
           "one pixel away from flat, against a constant template")
    # The interesting one: the image variance is tiny but non-zero, so the
    # denominator is near underflow rather than exactly zero. Windows that
    # miss the perturbed pixel are still exactly flat, so this single case
    # spans both sides of the guard.
    record("single-pixel-perturbation-varied-template", perturbed, varied,
           "near-zero image variance against a varying template")

    return {
        "description":
            "TM_CCOEFF_NORMED result matrices. Result size is "
            "(H-h+1) x (W-w+1). The degenerate cases pin what OpenCV "
            "returns when a variance is zero — the port must reproduce "
            "these numbers, not invent a NaN guard.",
        "operation": "cv2.matchTemplate(image, template, cv2.TM_CCOEFF_NORMED)",
        "cases": cases,
    }, arrays


@dump("resize-alpha")
def resize_alpha():
    """The derived alpha sizes `create_interpolated_alpha` produces.

    It resizes the 96px source of the active profile, choosing INTER_LINEAR
    when either target dimension grows and INTER_AREA otherwise
    (watermark_engine.cpp). 48 is the exact-half case, 42 and 53 are
    general downscales, 101 is the upscale that picks the other kernel.
    """
    source = alpha_source("bg_b_96.png")
    arrays = {"v2-96-alpha": source}
    outputs = []
    for size in (42, 48, 53, 101):
        interp = cv2.INTER_LINEAR if size > source.shape[0] else cv2.INTER_AREA
        resized = cv2.resize(source, (size, size), 0, 0, interpolation=interp)
        arrays[f"v2-96-to-{size}"] = resized
        outputs.append({
            "size": size,
            "interpolation": "INTER_LINEAR" if interp == cv2.INTER_LINEAR else "INTER_AREA",
            "output": f"v2-96-to-{size}",
        })
    return {
        "description":
            "V2 96px alpha source resized to the derived logo sizes. "
            "The kernel choice follows create_interpolated_alpha: linear "
            "when upscaling, area otherwise.",
        "operation": "cv2.resize(src, (n, n), 0, 0, interpolation=...)",
        "source": {"kind": "alpha_map", "variant": "V2", "size": "large",
                   "array": "v2-96-alpha"},
        "outputs": outputs,
    }, arrays


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("test/data/imageops"),
                        help="output directory (default: test/data/imageops)")
    parser.add_argument("--only", action="append", metavar="NAME",
                        help="generate just this dump (repeatable); "
                             f"available: {', '.join(sorted(PRODUCERS))}")
    args = parser.parse_args()

    selected = args.only or sorted(PRODUCERS)
    unknown = [n for n in selected if n not in PRODUCERS]
    if unknown:
        die(f"unknown dump(s): {', '.join(unknown)}\n"
            f"  available: {', '.join(sorted(PRODUCERS))}")

    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    for name in selected:
        meta, arrays = PRODUCERS[name]()
        written = write_dump(out_dir, name, meta, arrays)

        # Drop files this dump wrote on an earlier run but no longer does.
        # Renaming or removing a case would otherwise leave an orphaned
        # `.bin` behind to be committed and puzzled over later. Only this
        # dump's own files are considered, so `--only` never disturbs the
        # others.
        keep = set(written)
        stale = sorted(
            path for path in out_dir.iterdir()
            if path.is_file() and path.name not in keep
            and (path.name == f"{name}.json" or path.name.startswith(f"{name}-"))
        )
        for path in stale:
            path.unlink()

        note = f"  (removed {len(stale)} stale: {', '.join(p.name for p in stale)})" if stale else ""
        print(f"{name}: {', '.join(written)}{note}")

    quant = out_dir / "quantize-u8.json"
    if "quantize-u8" in selected:
        payload = json.loads(quant.read_text())
        law = payload["reference_law"]
        agrees = payload["reference_law_matches_measurement"]
        print(f"\ncv2 {cv2.__version__} measured behavior vs `{law}`: "
              f"{'agrees on every sample' if agrees else 'DIVERGES — see meta'}")
        for s in payload["samples"]:
            print(f"  {s['label']:>18} -> {s['output']:>3}")


if __name__ == "__main__":
    main()
