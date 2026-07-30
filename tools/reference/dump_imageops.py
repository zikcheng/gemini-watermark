#!/usr/bin/env python3
"""Dump cv2 operator behavior as committed oracle data.

OpenCV's numeric behavior differs from textbook formulas in ways that
silently shift results — fixed-point grayscale, DFT-based matchTemplate,
INTER_AREA coverage weighting, and the rounding law this file pins first.
The port therefore verifies its primitives against **measured** output of
the pinned opencv-python, never against reasoning about what OpenCV
"should" do.

M0 ships the quantization probe only. M3 completes this script with the
five detector primitives (BGR2GRAY, Sobel magnitude, meanStdDev,
TM_CCOEFF_NORMED, resize) — see docs/plan/M3.md commit 1. New dumps
register with @dump and return `(meta, arrays)`; array-valued operators
land as float32/uint8 `.bin` siblings of the `.json`, scalar tables live
in the JSON itself.

Needs no environment variables: it reads nothing but cv2 and writes into
the repository.

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
from _common import die  # noqa: E402

FORMAT_VERSION = 1

# name -> producer, populated by @dump
PRODUCERS: dict = {}


def dump(name: str):
    """Register a dump producer returning `(meta, arrays)`."""

    def register(fn):
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
        print(f"{name}: {', '.join(written)}")

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
