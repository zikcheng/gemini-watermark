/**
 * uint8 quantization for blended pixels.
 *
 * Ported from GeminiWatermarkTool: the `convertTo(CV_8UC3)` that ends both
 * blend loops in `src/core/blend_modes.cpp`
 * (`remove_watermark_alpha_blend`, `add_watermark_alpha_blend`),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * `convertTo(CV_8UC3)` is `saturate_cast<uchar>`, which is `cvRound`
 * followed by a clamp. `cvRound` is documented as implementation- and
 * FP-rounding-mode-dependent, so its law is not assumed here but measured:
 * `test/data/imageops/quantize-u8.json` records what the pinned cv2
 * actually does over ties, both saturation ends and the two float32
 * neighbours of 0.5. That measurement is **half to even**.
 *
 * This is one of three distinct rounding laws in this port, and they must
 * never be conflated (CLAUDE.md rule 5):
 *
 * | law | used for | lives in |
 * |---|---|---|
 * | half away from zero (`std::round`) | integer geometry: margins, logo sizes, positions | `position.ts` |
 * | fixed-point half up (`(x + 16384) >> 15`) | OpenCV 8-bit grayscale | `imageops.ts` (M3) |
 * | half to even (`cvRound`) | writing blended pixels back to uint8 | here |
 *
 * A caveat worth carrying: the oracle was measured with opencv-python
 * 5.0.0 while the reference binary statically links OpenCV 4.11.0, so the
 * dump alone does not prove the binary rounds this way. What does is the
 * golden-force pixel comparison — 7 of the 10 canonical blend crops come
 * back byte-identical, which a wrong rounding law could not survive. If
 * the two ever disagree, the golden images win. See
 * `docs/plan/DEVIATIONS.md` D5.
 */

/**
 * Round to the nearest integer, sending exact ties to the even neighbour.
 *
 * Differs from `Math.round` (ties go up, so `2.5` becomes `3` and `-0.5`
 * becomes `-0`) and from `roundHalfAwayFromZero` in `position.ts`. Ties are
 * the only inputs on which the three disagree.
 */
export function roundHalfToEven(v: number): number {
  const lower = Math.floor(v);
  const fraction = v - lower;
  if (fraction > 0.5) return lower + 1;
  if (fraction < 0.5) return lower;
  // Exact tie: keep whichever neighbour is even. `lower % 2` is -0 for
  // even negatives, and -0 === 0, so this reads correctly on both signs.
  return lower % 2 === 0 ? lower : lower + 1;
}

/**
 * Quantize a blended sample to a byte, exactly as OpenCV's
 * `saturate_cast<uchar>` does: clamp into [0, 255], then round half to
 * even.
 *
 * The blend loops already clamp to [0, 255] before this runs, so in
 * practice the clamp here is redundant for them — it is kept because
 * `saturate_cast` performs it too, and because this function is the one
 * place the law is defined. (Clamping before rounding and rounding before
 * clamping agree on every sample in the oracle, including 255.5 and -0.6.)
 */
export function quantizeU8(v: number): number {
  const clamped = v < 0 ? 0 : v > 255 ? 255 : v;
  return roundHalfToEven(clamped);
}
