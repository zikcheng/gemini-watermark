#!/usr/bin/env node
/**
 * Timing for the per-pixel primitives. Prints; never fails.
 *
 * This is a stethoscope, not a gate. It is deliberately outside `check`
 * and CI: wall-clock numbers on a shared runner vary far more than the
 * changes worth noticing, so a threshold here would mostly produce false
 * alarms and get muted. Run it by hand when touching a hot loop and
 * compare against the numbers in the same session — not against numbers
 * from another machine.
 *
 * Sizes mirror real work: a 96x96 template swept over a 112x112 ROI is
 * what detection actually does, and the full-HD grayscale pass is the
 * worst case a caller can hand the port.
 *
 * Usage: node tools/bench.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WARMUP = 20;
const ITERATIONS = 100;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Bundle `src/` so this runs without a build step or a TypeScript loader.
 * esbuild is already present as a tsup dependency.
 */
function bundle() {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-bench-'));
  const entry = join(dir, 'entry.ts');
  const out = join(dir, 'bundle.mjs');
  const src = join(ROOT, 'src');
  const body = [
    `export { toGrayscale, meanStdDev, sobelMagnitude, matchTemplateCcoeffNormed } from ${JSON.stringify(join(src, 'imageops.js'))};`,
    `export { removeWatermarkRegion, addWatermarkRegion } from ${JSON.stringify(join(src, 'blend.js'))};`,
    `export { resizeArea, resizeBilinear } from ${JSON.stringify(join(src, 'resize.js'))};`,
    `export { getSourceAlphaMap } from ${JSON.stringify(join(src, 'alpha-maps.js'))};`,
  ].join('\n');
  writeFileSync(entry, body);
  execFileSync(join(ROOT, 'node_modules', '.bin', 'esbuild'), [
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${out}`,
    '--log-level=warning',
  ]);
  return { dir, out };
}

/** Median of `ITERATIONS` timed runs, after `WARMUP` untimed ones. */
function median(label, run) {
  for (let i = 0; i < WARMUP; i += 1) run();
  const samples = new Float64Array(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = performance.now();
    run();
    samples[i] = performance.now() - started;
  }
  samples.sort();
  const mid = samples[Math.floor(ITERATIONS / 2)];
  const lo = samples[Math.floor(ITERATIONS * 0.05)];
  const hi = samples[Math.floor(ITERATIONS * 0.95)];
  console.log(
    `  ${label.padEnd(46)} ${mid.toFixed(3).padStart(9)} ms   ` +
      `(p5 ${lo.toFixed(3)} / p95 ${hi.toFixed(3)})`,
  );
}

/** Deterministic content: the same LCG the round-trip tests use. */
function lcgBytes(count, seed) {
  let state = seed >>> 0;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

const { dir, out } = bundle();
try {
  const m = await import(`file://${out}`);

  console.log(
    `\ngemini-watermark primitives — median of ${ITERATIONS} runs ` +
      `after ${WARMUP} warmups\n` +
      `node ${process.version}\n`,
  );

  // Full-HD grayscale: the largest single pass a caller can trigger.
  const hd = { data: lcgBytes(1920 * 1080 * 3, 0x2545f491), width: 1920, height: 1080, channels: 3 };
  const hdGray = m.toGrayscale(hd);
  const hdFloat = Float32Array.from(hdGray, (v) => v / 255);

  console.log('imageops');
  median('toGrayscale 1920x1080 RGB', () => m.toGrayscale(hd));
  median('meanStdDev 1920x1080 uint8', () => m.meanStdDev(hdGray));
  median('sobelMagnitude 1920x1080 f32', () => m.sobelMagnitude(hdFloat, 1920, 1080));

  // Detection's real shape: a 96x96 template over a 112x112 ROI.
  const roi = Float32Array.from(lcgBytes(112 * 112, 0x9e3779b9), (v) => v / 255);
  const alpha96 = m.getSourceAlphaMap('V2', 'large');
  const alpha36 = m.getSourceAlphaMap('V2', 'small');
  const roiSmall = Float32Array.from(lcgBytes(52 * 52, 0x85ebca6b), (v) => v / 255);
  median('matchTemplate 112x112 vs 96x96 (17x17)', () =>
    m.matchTemplateCcoeffNormed(roi, 112, 112, alpha96, 96, 96),
  );
  median('matchTemplate 52x52 vs 36x36 (17x17)', () =>
    m.matchTemplateCcoeffNormed(roiSmall, 52, 52, alpha36, 36, 36),
  );

  console.log('\nresize');
  median('resizeArea 96 -> 48', () => m.resizeArea(alpha96, 96, 96, 48, 48));
  median('resizeBilinear 96 -> 101', () => m.resizeBilinear(alpha96, 96, 96, 101, 101));

  console.log('\nblend (in place, so each run gets a fresh buffer)');
  const canvas = lcgBytes(2752 * 1536 * 3, 0xc2b2ae35);
  median('removeWatermarkRegion 96x96 on 2752x1536', () => {
    const image = { data: canvas.slice(), width: 2752, height: 1536, channels: 3 };
    m.removeWatermarkRegion(image, alpha96, 96, 96, { x: 2464, y: 1248 });
  });
  median('addWatermarkRegion 96x96 on 2752x1536', () => {
    const image = { data: canvas.slice(), width: 2752, height: 1536, channels: 3 };
    m.addWatermarkRegion(image, alpha96, 96, 96, { x: 2464, y: 1248 });
  });
  // The buffer copy dominates the two above; time it alone so the blend
  // cost can be read out by subtraction rather than guessed at.
  median('  (baseline: buffer copy only)', () => canvas.slice());

  console.log('');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
