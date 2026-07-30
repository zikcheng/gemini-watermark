#!/usr/bin/env python3
"""Bake the four calibrated alpha captures into src/alpha-maps.ts.

Upstream embeds its watermark captures as PNGs and decodes them with
OpenCV at startup. A zero-dependency package that must also run in a
browser cannot decode PNG at runtime, so the decoded bytes are baked into
a generated TypeScript module instead — base64 in, `Uint8Array` out.

What is baked is `max(R,G,B)` per pixel, i.e. the numerator of upstream's
`calculate_alpha_map` (blend_modes.cpp): it takes the per-pixel maximum
across the three colour channels and divides by 255. Keeping the uint8
stage in the module and dividing in TypeScript means the committed data is
exactly the bytes the kit extracted, and the division stays visible.

Also prints, for the tests that hardcode them (M1.md commit 2): each map's
sha256 over the uint8 bytes, and four checkpoints per map. The checkpoints
are *chosen*, not fixed coordinates — see `pick_checkpoints`.

Inputs  (env):  GWT_REFERENCE_DIR/alpha/*.png  (run extract_alpha.py first)
Outputs (arg):  src/alpha-maps.ts

Usage:  python3 tools/gen_alpha_module.py
Exits:  0 written · 2 environment or input failure
"""
import argparse
import base64
import hashlib
import sys
from pathlib import Path

import cv2
import numpy as np

# The env/exit-2 conventions live with the reference tooling; importing
# them keeps one definition rather than a second, drifting copy.
sys.path.insert(0, str(Path(__file__).resolve().parent / "reference"))
from _common import die, reference_dir, require_file  # noqa: E402

# (key, source file, expected edge length). The pairing mirrors upstream's
# six-argument WatermarkEngine constructor: bg_48/bg_96 initialise the V1
# profile, bg_b_36/bg_b_96 the V2 profile (watermark_engine.cpp).
SOURCES = [
    ("V1:small", "bg_48.png", 48),
    ("V1:large", "bg_96.png", 96),
    ("V2:small", "bg_b_36.png", 36),
    ("V2:large", "bg_b_96.png", 96),
]

MODULE_HEADER = """\
/**
 * Calibrated alpha source maps, baked as data.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: python3 tools/gen_alpha_module.py
 *
 * Ported from GeminiWatermarkTool (src/core/blend_modes.cpp
 * `calculate_alpha_map`, src/core/watermark_engine.cpp
 * `init_alpha_maps` / `init_alpha_maps_v2` / `get_alpha_map(size, variant)`),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * Upstream recovers the watermark's per-pixel opacity from captures of the
 * logo rendered on pure black: `alpha = max(R,G,B) / 255`. It embeds those
 * captures as PNGs and decodes them with OpenCV at startup; this package
 * has no decoder and no dependencies, so the `max(R,G,B)` bytes are baked
 * in directly and the division happens here.
 *
 * The bytes are byte-identical to upstream's; the division is **not**
 * bit-identical. OpenCV's `convertTo(CV_32FC1, 1.0/255.0)` multiplies in
 * float32, this divides in float64 before storing, and the two disagree by
 * one ulp on 126 of the 256 possible byte values (max 5.96e-8). That is
 * within the contract — CLAUDE.md rule 4 accepts float-width differences
 * and holds the port to +-1 per 8-bit channel on restored pixels, not to
 * identical floats. See docs/plan/DEVIATIONS.md D4 for the measurement and
 * the downstream error budget.
 *
 * These are the four *source* calibration maps only. Every other logo size
 * (the 48px half-scale class, the 42/53/101px classes) is derived from the
 * 96px sources at runtime — see `effectiveAlphaMap`.
 */
import type { WatermarkSize, WatermarkVariant } from './types.js';

interface AlphaSource {
  readonly w: number;
  readonly h: number;
  /** base64 of `w * h` bytes, each `max(R,G,B)` of the calibration capture. */
  readonly data: string;
}
"""

MODULE_BODY = """
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_PAD = '='.charCodeAt(0);

const B64_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

function sextet(input: string, index: number): number {
  const code = input.charCodeAt(index);
  if (code === B64_PAD) return 0;
  const value = B64_LOOKUP[code];
  if (value === undefined || value < 0) {
    throw new RangeError(
      `invalid base64 character ${JSON.stringify(input[index])} at index ${index}`,
    );
  }
  return value;
}

/**
 * Decode standard base64 (RFC 4648, padded) to bytes.
 *
 * Hand-rolled on purpose: `atob` exists only in browsers and Node's
 * byte-buffer global only in Node, while this module has to work in both.
 * (Naming that global here would trip tools/check-imports.mjs, which scans
 * text rather than syntax — deliberately, since the constraint is hard.)
 * Exported for tests; not part of the package's public API — see
 * `src/index.ts`.
 *
 * Padding handling is deliberately permissive: `=` decodes as zero bits
 * wherever it appears, and only the output length (derived from trailing
 * padding) decides how many bytes are kept. The sole input is the trusted
 * base64 baked into this file, so rejecting misplaced padding would add a
 * validation path nothing exercises. This is the pinned contract, not an
 * oversight — the tests assert the permissive behaviour rather than
 * tightening it.
 */
export function decodeBase64(input: string): Uint8Array {
  const { length } = input;
  if (length % 4 !== 0) {
    throw new RangeError(`base64 length ${length} is not a multiple of 4`);
  }
  if (length === 0) return new Uint8Array(0);

  let padding = 0;
  if (input.charCodeAt(length - 1) === B64_PAD) padding += 1;
  if (input.charCodeAt(length - 2) === B64_PAD) padding += 1;

  const out = new Uint8Array((length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < length; i += 4) {
    const chunk =
      (sextet(input, i) << 18) |
      (sextet(input, i + 1) << 12) |
      (sextet(input, i + 2) << 6) |
      sextet(input, i + 3);
    // Padding shortens `out`, so the bounds check is what drops the
    // trailing bytes a padded quantum does not carry.
    if (o < out.length) out[o++] = (chunk >>> 16) & 0xff;
    if (o < out.length) out[o++] = (chunk >>> 8) & 0xff;
    if (o < out.length) out[o++] = chunk & 0xff;
  }
  return out;
}

/** Decoded uint8 maps, kept so the base64 is walked once per map. */
const cache = new Map<string, Uint8Array>();

/**
 * Edge length of a source map, without decoding it.
 *
 * The C++ side reads `base.cols` off a reference it already holds; this is
 * the equivalent that does not force the caller to materialise a
 * Float32Array just to learn how big it is. `effectiveAlphaMap` needs
 * exactly that when deciding whether to resample.
 */

/**
 * The calibrated alpha map for one profile and size class.
 *
 * Corresponds to `WatermarkEngine::get_alpha_map(size, variant)` combined
 * with `calculate_alpha_map` (blend_modes.cpp): V1 small is 48x48, V2
 * small is 36x36, both large maps are 96x96.
 *
 * Returns a **fresh** `Float32Array` on every call — callers scale, clamp
 * and otherwise mutate these buffers, and the cached bytes must survive
 * that untouched.
 */
export function getSourceAlphaMapEdge(
  variant: WatermarkVariant,
  size: WatermarkSize,
): number {
  const source = SOURCES[`${variant}:${size}`];
  if (source === undefined) {
    throw new RangeError(`no alpha source map for variant ${variant}, size ${size}`);
  }
  if (source.w !== source.h) {
    throw new RangeError(`alpha source ${variant}:${size} is ${source.w}x${source.h}, not square`);
  }
  return source.w;
}

export function getSourceAlphaMap(
  variant: WatermarkVariant,
  size: WatermarkSize,
): Float32Array {
  const key = `${variant}:${size}`;
  const source = SOURCES[key];
  if (source === undefined) {
    throw new RangeError(`no alpha source map for variant ${variant}, size ${size}`);
  }

  let bytes = cache.get(key);
  if (bytes === undefined) {
    bytes = decodeBase64(source.data);
    if (bytes.length !== source.w * source.h) {
      throw new RangeError(
        `alpha map ${key} decoded to ${bytes.length} bytes, ` +
          `expected ${source.w * source.h} (${source.w}x${source.h})`,
      );
    }
    cache.set(key, bytes);
  }

  // `set` widens uint8 to float in one native pass; the loop then applies
  // the `/ 255` of calculate_alpha_map. (`?? 0` is unreachable — it only
  // satisfies noUncheckedIndexedAccess without a non-null assertion.)
  const alpha = new Float32Array(bytes.length);
  alpha.set(bytes);
  for (let i = 0; i < alpha.length; i += 1) {
    alpha[i] = (alpha[i] ?? 0) / 255;
  }
  return alpha;
}
"""


def pick_checkpoints(values: np.ndarray) -> list:
    """Four spot-check pixels that each detect a transposed or flipped map.

    A fixed coordinate pair like (5,9)/(9,5) reads as asymmetric but is
    worthless on this data: the logo sits in the middle, so those corners
    are near-black background and (5,9) == (9,5) == 1 on the V1 small map —
    a transposed map would sail through. So the coordinates are derived
    from the data instead.

    Each candidate is scored by how much it changes under the *weakest* of
    the three degenerate transforms (transpose, horizontal flip, vertical
    flip), and the best-scoring pixel in each quadrant wins. Scoring on the
    minimum means every checkpoint independently catches all three; taking
    one per quadrant keeps them spread instead of clustered on one edge.
    Deterministic: ties break on (y, x), so reruns reproduce the values the
    tests hardcode.
    """
    v = values.astype(int)
    h, w = v.shape
    strength = np.minimum.reduce([
        np.abs(v - v.T),            # transpose
        np.abs(v - v[:, ::-1]),     # horizontal flip
        np.abs(v - v[::-1, :]),     # vertical flip
    ])

    picks = []
    for y0, y1 in ((0, h // 2), (h // 2, h)):
        for x0, x1 in ((0, w // 2), (w // 2, w)):
            best = None
            for y in range(y0, y1):
                for x in range(x0, x1):
                    score = int(strength[y, x])
                    if best is None or score > best[0]:
                        best = (score, x, y)
            if best is None or best[0] == 0:
                die(f"no transform-discriminating pixel in quadrant "
                    f"x[{x0},{x1}) y[{y0},{y1}) — the map may be symmetric, "
                    f"which would make these checkpoints meaningless.")
            picks.append((best[1], best[2], int(values[best[2], best[1]]), best[0]))
    return picks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("src/alpha-maps.ts"),
                        help="generated module path (default: src/alpha-maps.ts)")
    args = parser.parse_args()

    alpha_dir = reference_dir() / "alpha"
    entries = []
    report = []

    for key, filename, expected in SOURCES:
        path = require_file(alpha_dir / filename, f"alpha capture {filename}",
                            "Run tools/reference/extract_alpha.py first.")
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is None:
            die(f"could not decode {path}")
        h, w = img.shape[:2]
        if (w, h) != (expected, expected):
            die(f"{filename} is {w}x{h}, expected {expected}x{expected}; upstream "
                f"resizes off-size captures with INTER_AREA and this generator "
                f"deliberately does not guess — re-extract the kit.")

        # max over the three colour channels: order-free, so the BGR/RGB
        # question does not arise (calculate_alpha_map, blend_modes.cpp).
        values = img.max(axis=2).astype(np.uint8)
        raw = values.tobytes()
        entries.append((key, w, h, base64.b64encode(raw).decode("ascii")))

        report.append({
            "key": key, "file": filename, "w": w, "h": h,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "checkpoints": pick_checkpoints(values),
        })

    lines = [MODULE_HEADER, "const SOURCES: Record<string, AlphaSource> = {"]
    for key, w, h, data in entries:
        lines.append(f"  '{key}': {{")
        lines.append(f"    w: {w},")
        lines.append(f"    h: {h},")
        lines.append(f"    data:\n      '{data}',")
        lines.append("  },")
    lines.append("};")
    lines.append(MODULE_BODY)

    out = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines))
    total = sum(len(d) for _, _, _, d in entries)
    print(f"wrote {out} ({out.stat().st_size} bytes, {total} base64 chars)\n")

    for r in report:
        print(f"{r['key']:<9} {r['file']:<12} {r['w']}x{r['h']}")
        print(f"  sha256(uint8) {r['sha256']}")
        pts = "  ".join(f"({x},{y})={v}" for x, y, v, _ in r["checkpoints"])
        print(f"  checkpoints   {pts}")
        margins = ", ".join(str(m) for *_, m in r["checkpoints"])
        print(f"  (each differs by >= [{margins}] under transpose/flip-x/flip-y)")


if __name__ == "__main__":
    main()
