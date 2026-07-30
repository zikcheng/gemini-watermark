# gemini-watermark

> ⚠️ **Work in progress** — not yet published to npm.

Detect, remove, and add Gemini visible image watermarks via deterministic
**reverse alpha blending**. A faithful TypeScript port of
[GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) by
Allen Kuo.

Zero dependencies and environment-agnostic: the core has no DOM, no Node
APIs and no file I/O, so it works wherever you can hand it a pixel buffer.
Browsers and **Node ≥ 20** are the environments CI tests, and the only two
the package promises.

## How it works

Gemini applies its visible watermark with standard alpha blending against a
white logo:

```
watermarked = α × 255 + (1 − α) × original
```

The alpha map `α` is a fixed, calibrated pattern. Removal inverts the
equation exactly:

```
original = (watermarked − α × 255) / (1 − α)
```

No generative inpainting, no hallucination — pixels are reconstructed
mathematically. See the original author's write-up:
[Removing Gemini AI Watermarks: A Deep Dive into Reverse Alpha Blending](https://allenkuo.medium.com/removing-gemini-ai-watermarks-a-deep-dive-into-reverse-alpha-blending-bbbd83af2a3f).

## Scope and port fidelity

v0.1.0 targets **subset equivalence**: a defined subset of
GeminiWatermarkTool v0.3.2's behavior, reproduced exactly, with the
boundary stated rather than left to inference. The full matrix is in
[PLAN.md](PLAN.md); in short:

**Equivalent to upstream v0.3.2**

- The same four calibrated alpha maps (V1 legacy, V2 / Gemini 3.5+)
- The same position formulas, including V2 canonical-source inference
- Three-stage NCC detection (spatial / gradient / variance): thresholds,
  fusion weights, circuit breaker, spatial rescue and the ±3px V2-small
  snap are copied verbatim from the C++ source, never re-tuned
- V2→V1 fallback, the confidence gate, and skip semantics
- Reverse removal across every V1 and V2 profile, including upstream's
  forced-size quirk

**A TypeScript extension, not upstream equivalence**

- Forward *add* for V2. Upstream's CLI cannot add a watermark at all, and
  its engine's `add_watermark` implements only the V1 geometry — there is
  no upstream behavior to match. It is verified by round trip instead: the
  reference C++ binary must restore the original from what this port adds.
  Forward add for **V1** is upstream-equivalent.

**Not in v0.1.0**

- Region/snap search and Soft Inpaint residual cleanup — planned, later
- NS/TELEA/AI denoising and file I/O — excluded by design; the core takes
  and returns pixel buffers and never touches a filesystem

**How equivalence is checked**

Each ported module ships with tests against oracles generated from the
reference C++ binary (v0.3.2, pinned by SHA256). Decisions — detect vs
skip, circuit breaker, chosen variant, region, and the resulting status —
must match **exactly**. Pixels the removal rewrites match within **±1 per
8-bit channel**; everything it should not touch is **byte-exact**, both
outside the watermark region and on the alpha channel of an RGBA buffer.
Upstream quirks are reproduced rather than corrected: that includes a
busy-background fixture its own detector misses, which this port must also
skip.

## Status

| Module | Status |
|---|---|
| Position config (V1/V2, canonical inference) | ✅ ported + tested |
| Alpha maps (baked calibration data) | ✅ ported + tested |
| Reverse alpha blend (remove / add) | ✅ ported + tested |
| Three-stage NCC detection | ✅ ported + tested |
| Guided multi-scale detection (snap) | ❌ M7 (not in v0.1.0) |
| Soft inpaint residual cleanup | ❌ M7 (not in v0.1.0) |

Everything v0.1.0 promises is implemented: `detectWatermark` runs the three
weighted stages with the circuit breaker, the spatial rescue and the V2
small snap, and `processImage` wraps them in the V2→V1 fallback, the
confidence gate and the removal itself. What is left before a first release
is packaging and a release rehearsal, not behavior.

Underneath the detector are primitives checked against measured output of
the pinned OpenCV rather than against a textbook formula: grayscale, Sobel
magnitude, mean/standard deviation, normalized cross-correlation and the
two resampling kernels that derive the non-canonical alpha sizes.

The equivalence infrastructure all of it is tested against is in place too:
`tools/reference/` regenerates the reference kit from the pinned C++ binary
and validates it, and `test/data/` carries the committed oracle — geometry
fixtures, the detection/score manifest, per-case image patches for CI, and
the cv2 operator dumps. Detection is held against that manifest case by
case, and against a branch matrix for the paths no fixture reaches.

## License & attribution

MIT. The algorithm, calibrated alpha-map data, and position formulas are
derived from [GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool)
(MIT, Copyright © 2025 Allen Kuo). See [LICENSE](LICENSE).

This tool removes **visible** watermarks only. It does not affect SynthID
invisible watermarks. Use responsibly and in compliance with applicable laws
and terms of service.
