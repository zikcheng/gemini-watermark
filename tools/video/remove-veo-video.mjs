#!/usr/bin/env node
/**
 * Remove the Veo watermark from a video file.
 *
 * Two-pass, self-calibrating: pass 1 decodes every frame and feeds the
 * temporal calibrator; pass 2 decodes again, reverse-blends each frame
 * with the calibrated alpha map, and re-encodes. Audio streams are
 * copied bit-exact from the source.
 *
 * This is deliberately a tool, not part of the published package: the
 * core stays environment-agnostic (pixels in, pixels out), and the
 * ffmpeg/CLI glue lives here. Requires `ffmpeg`/`ffprobe` on PATH and a
 * prior `npm run build` (imports from dist/).
 *
 * Usage: node tools/video/remove-veo-video.mjs <input> <output> [crf]
 *   crf: x264 quality, default 16 (visually near-lossless).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createVideoCalibrator,
  removeVideoWatermark,
} from '../../dist/index.js';

const [input, output, crfArg] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/video/remove-veo-video.mjs <input> <output> [crf]');
  process.exit(2);
}
const crf = crfArg ?? '16';

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'csv=p=0', file,
    ]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffprobe failed: ${err.trim()}`));
      else resolve(out.trim().split(','));
    });
  });
}

/** Yield each decoded frame of `file` as an rgb24 Buffer. */
async function* decodeFrames(file, width, height) {
  const frameBytes = width * height * 3;
  const dec = spawn('ffmpeg', [
    '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  dec.stderr.on('data', (d) => process.stderr.write(d));
  const exited = new Promise((resolve, reject) => {
    dec.on('error', reject);
    dec.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg decode exited ${code}`));
      else resolve();
    });
  });
  let pending = Buffer.alloc(0);
  for await (const chunk of dec.stdout) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      yield pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
    }
  }
  await exited;
  if (pending.length !== 0) {
    throw new Error(`decoder left ${pending.length} trailing bytes (not a whole frame)`);
  }
}

const [w, h, fps] = await probe(input);
const width = Number(w);
const height = Number(h);

// Pass 1: temporal calibration.
const calibrator = createVideoCalibrator(width, height);
for await (const frame of decodeFrames(input, width, height)) {
  calibrator.addFrame({ data: frame, width, height, channels: 3 });
}
const calibration = calibrator.calibrate();
console.log(
  `calibrated over ${calibrator.frameCount} frames: ` +
    `source=${calibration.source} ` +
    `templateNcc=${calibration.templateNcc.toFixed(4)} ` +
    `gain=${calibration.templateGain.toFixed(3)} ` +
    `logo at (${calibration.position.x}, ${calibration.position.y})`,
);

// Pass 2: remove and re-encode.
const enc = spawn('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`,
  '-r', fps, '-i', '-',
  '-i', input,
  '-map', '0:v', '-map', '1:a?',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p',
  '-c:a', 'copy', '-movflags', '+faststart',
  output,
]);
enc.stderr.on('data', (d) => process.stderr.write(d));
const encoded = new Promise((resolve, reject) => {
  enc.on('error', reject);
  enc.on('close', (code) => {
    if (code !== 0) reject(new Error(`ffmpeg encode exited ${code}`));
    else resolve();
  });
});

let outFrames = 0;
for await (const frame of decodeFrames(input, width, height)) {
  removeVideoWatermark({ data: frame, width, height, channels: 3 }, calibration);
  outFrames += 1;
  if (!enc.stdin.write(frame)) await once(enc.stdin, 'drain');
}
enc.stdin.end();
await encoded;
console.log(`done: ${outFrames} frames -> ${output}`);
