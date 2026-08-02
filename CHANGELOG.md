# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this is a **port**, one extra rule applies: an entry that changes
behavior must say which upstream version it tracks. Behavior never changes
here on its own initiative — it changes because upstream changed, or because
the port was wrong about upstream.

## [Unreleased]

### Added

- **Veo video watermark removal** — an extension beyond the upstream
  port (upstream v0.3.2 has no video path; measurements and rationale in
  `docs/plan/DEVIATIONS.md` D8). New exports `getVideoWatermarkConfig`,
  `createVideoCalibrator`, `removeVideoWatermark`, the
  `VIDEO_LOGO_SIZE`/`VIDEO_MARGIN` constants and their types: a
  two-pass, self-calibrating pipeline that estimates the per-video
  alpha map from temporal statistics (biharmonic background inpainting
  of the temporal mean), validates it against the V1-48 template, and
  reverse-blends every frame, then smooths the sparkle's edge band
  where the division amplifies codec noise (`smoothEdges: false` opts
  out). The template fallback's opacity is calibrated by a 1-D search
  that zeroes the sparkle outline's edge energy. Every algorithmic
  choice was raced against alternatives on the sample videos — the
  variant table lives in the D8 addendum. An ffmpeg-driven CLI lives in
  `tools/video/remove-veo-video.mjs`, outside the published package.

## [0.1.2] - 2026-08-02

Documentation-only patch; no behavior change.

### Added

- `homepage` in package.json and a "try it online" link in the README, both
  pointing at [gemini-watermark.org](https://gemini-watermark.org). (The
  README ships inside the package, which is what makes this a release.)

## [0.1.1] - 2026-07-31

Documentation-only patch; no behavior change.

### Changed

- README no longer carries the pre-release banner and the install
  placeholder — the package is on npm, `npm install gemini-watermark` is
  real. (The README ships inside the package, which is what makes this a
  release.)
- The browser example page and the retired planning document referenced by
  the 0.1.0 README are gone from the repository; the README's inline usage
  samples and compatibility matrix are the reference now.

## [0.1.0] - 2026-07-31

First release. A faithful TypeScript port of
[GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool)
**v0.3.2** (commit `7c6a99f`), verified against golden outputs produced by
that release's own binary (macOS universal build, SHA256
`8f4796a1450a6471d29dc670627c73d6506c3fd686370c258b7d986b8de453d1`).

### Added

- **`processImage(image, options?)`** — the full pipeline: detect, gate, and
  remove (or add) a watermark, in place on the caller's buffer. Covers the
  V2→V1 fallback, the confidence gate, `force`, explicit `variant`/`size`,
  and `logoValue`. A skipped image is returned byte-identical.
- **`detectWatermark(image, options?)`** — three-stage detection for one
  variant: spatial NCC against the calibrated alpha template, gradient NCC
  over Sobel magnitudes, and the texture-variance ratio, fused
  `0.50/0.30/0.20`, with the circuit breaker, the spatial rescue, and the
  ±3px V2-small snap.
- **`passesThreshold(confidence, threshold)`** — the gate itself, exported so
  a caller holding a result can re-apply it and get the same answer the
  pipeline would.
- **Geometry**: `getWatermarkSize`, `getWatermarkConfig`,
  `getWatermarkTopLeft` — the size class, margins and logo size derived from
  image dimensions, including V2 canonical-source inference.
- **Region-level blend**: `getSourceAlphaMap`, `removeWatermarkRegion`,
  `addWatermarkRegion` — for callers driving placement themselves.
- **Types**: `ImageBuffer`, `Point`, `Rect`, `WatermarkVariant`,
  `WatermarkSize`, `WatermarkPosition`, `DetectionScores`, `DetectionResult`,
  `DetectOptions`, `ProcessResult`, `ProcessStatus`, `ProcessOptions`.
- The four calibrated alpha maps (V1 48/96, V2 36/96) baked in as data — no
  PNG decode at runtime and no asset files to ship.

### Compatibility with upstream v0.3.2

| Upstream capability | 0.1.0 | Notes |
|---|---|---|
| Auto detection (three stages + circuit breaker + rescue + snap) | ✅ equivalent | |
| V2→V1 fallback, threshold gate, skip semantics | ✅ equivalent | |
| Reverse removal (V1 + V2, all profiles, incl. the forced-size quirk) | ✅ equivalent | `force` keeps the internal snap detection |
| Forward add V1 | ✅ equivalent | |
| Forward add V2 | ⚠️ extension | not upstream equivalence — see below |
| Region/snap search, Soft Inpaint | ❌ not included | planned, later |
| NS/TELEA/AI denoise, file I/O | ❌ excluded by design | the core takes and returns pixel buffers |

Equivalence means: decisions (detect vs skip, circuit breaker, chosen
variant, region, status) match the reference binary **exactly**; rewritten
pixels match within **±1 per 8-bit channel**; everything the removal should
not touch is **byte-exact**, outside the region and on the alpha channel.
Upstream quirks are reproduced rather than corrected — including a
busy-background fixture upstream's own detector misses, which this port also
skips, and the `--force-small` size-override no-op recorded as D3 in
`docs/plan/DEVIATIONS.md`.

**Forward add for V2 is a TypeScript extension, not a port.** Upstream's CLI
cannot add a watermark at all and its engine's `add_watermark` implements
only the V1 geometry, so there is no upstream behavior to be equivalent to.
It is verified by round trip instead: the reference C++ binary must restore
the original from what this port adds, within ±1 per channel. That proves the
forward blend inverts the reverse one; it does **not** claim Gemini or
upstream would produce the same watermarked image. Forward add for **V1** is
upstream-equivalent.

### Package

- Zero runtime dependencies. ESM only, `"type": "module"`, types bundled as
  `dist/index.d.ts`.
- Environment-agnostic core: no DOM, no Node APIs, no file I/O. Node ≥ 20 and
  browsers are both exercised in CI — the built bundle is loaded in Chromium
  and its output compared byte for byte against Node's. Those two are the
  supported environments; **nothing else is promised**.
- Published files: `dist/`, `LICENSE`, `README.md`.

### Known limitations

- Removes the **visible** watermark only. Google's invisible SynthID
  watermark is a different mechanism and is unaffected.
- Colour management changes pixel values and therefore detection scores; in
  browsers, decode with `colorSpaceConversion: 'none'`.
- JPEG decoders disagree with each other, and detection scores move with
  them. This library never decodes anything, so the decoder is the caller's
  choice and part of their result.
- The fixture corpus is synthetic. Equivalence is proven against generated
  fixtures processed by the reference binary, not against collected real
  Gemini output.

[Unreleased]: https://github.com/zikcheng/gemini-watermark/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/zikcheng/gemini-watermark/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zikcheng/gemini-watermark/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zikcheng/gemini-watermark/releases/tag/v0.1.0
