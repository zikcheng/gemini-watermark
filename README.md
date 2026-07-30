# gemini-watermark

> ⚠️ **Work in progress** — not yet published to npm.

Detect, remove, and add Gemini visible image watermarks via deterministic
**reverse alpha blending**. A faithful TypeScript port of
[GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) by
Allen Kuo. Zero dependencies, environment-agnostic — runs in browsers,
Web Workers, Node, Deno, and Bun.

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

## Port fidelity

This port targets **behavioral equivalence with GeminiWatermarkTool v0.3.2**:

- Same alpha maps (V1 legacy + V2 / Gemini 3.5+ profiles)
- Same position formulas, including V2 canonical-source inference
- Same three-stage NCC detection (spatial / gradient / variance) with
  identical thresholds, circuit breaker, and spatial-rescue rules
- Verified against golden outputs produced by the reference C++ binary
  (pixel-exact within ±1 quantization on the removal path)

## Status

| Module | Status |
|---|---|
| Position config (V1/V2, canonical inference) | ✅ ported + tested |
| Alpha maps (baked calibration data) | ⏳ |
| Reverse alpha blend (remove / add) | ⏳ |
| Three-stage NCC detection | ⏳ |
| Guided multi-scale detection (snap) | ⏳ |
| Soft inpaint residual cleanup | ⏳ |

## License & attribution

MIT. The algorithm, calibrated alpha-map data, and position formulas are
derived from [GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool)
(MIT, Copyright © 2025 Allen Kuo). See [LICENSE](LICENSE).

This tool removes **visible** watermarks only. It does not affect SynthID
invisible watermarks. Use responsibly and in compliance with applicable laws
and terms of service.
