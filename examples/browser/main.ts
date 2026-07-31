/**
 * Remove a Gemini watermark entirely in the browser.
 *
 * The library never decodes or encodes anything — it takes a pixel buffer
 * and gives one back — so the interesting part of this file is the two
 * conversions on either side of the one call to `processImage`. Both have a
 * way to get them wrong that produces a plausible-looking image and a wrong
 * result, which is what the comments below are about.
 *
 * Nothing here needs a bundler or a server-side step: `index.html` maps the
 * bare specifier to the built ESM bundle with an import map.
 */
import { processImage } from 'gemini-watermark';
import type { ImageBuffer, ProcessResult } from 'gemini-watermark';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`index.html has no ${selector}`);
  return element;
}

const picker = required<HTMLInputElement>('#file');
const status = required<HTMLParagraphElement>('#status');
const detail = required<HTMLPreElement>('#detail');
const preview = required<HTMLImageElement>('#preview');
const download = required<HTMLAnchorElement>('#download');

/** Revoked before each new one, so repeated runs do not leak object URLs. */
let currentUrl: string | undefined;

/**
 * Hiding the anchor is not enough: `href` would keep pointing at an object
 * URL that the next run revokes, so a hidden-but-live link would be a
 * dangling one. Clearing both leaves no stale reference behind.
 */
function hideDownload(): void {
  download.hidden = true;
  download.removeAttribute('href');
  download.removeAttribute('download');
}

interface Decoded {
  image: ImageBuffer;
  /** The same pixels, in the form the canvas takes back. */
  imageData: ImageData;
  canvas: OffscreenCanvas;
}

/**
 * Decode a file into pixels the engine can be handed.
 *
 * `colorSpaceConversion: 'none'` is the load-bearing option. By default a
 * browser converts an image's embedded colour profile to the display
 * profile while decoding, which *changes the pixel values*. Detection
 * correlates against a calibrated alpha template and removal algebraically
 * inverts a blend — both read the exact bytes, so a colour transform
 * anywhere upstream lowers the confidence score and leaves a visible
 * residue where the watermark was.
 *
 * `imageOrientation: 'from-image'` applies the EXIF rotation. The watermark
 * sits at the bottom-right of the image *as displayed*, and every geometry
 * decision follows the dimensions, so an unrotated buffer would send the
 * detector to the wrong corner. The spec's default has changed over time;
 * saying it explicitly costs nothing.
 */
async function decode(file: File): Promise<Decoded> {
  const bitmap = await createImageBitmap(file, {
    colorSpaceConversion: 'none',
    imageOrientation: 'from-image',
  });

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser gave no 2d context for an OffscreenCanvas');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  // `getImageData` hands back non-premultiplied sRGB bytes, which is what
  // ImageBuffer means by RGBA. Worth knowing for images that are partly
  // transparent: the canvas stores premultiplied internally, so a round trip
  // through it is lossy at low alpha. The engine itself never reads or
  // writes the alpha channel — it passes through byte for byte.
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    image: { data: imageData.data, width: canvas.width, height: canvas.height, channels: 4 },
    imageData,
    canvas,
  };
}

function describe(result: ProcessResult): string {
  const lines = [`status: ${result.status}`, `confidence: ${result.confidence.toFixed(3)}`];
  if (result.status === 'processed' && result.region !== undefined) {
    lines.push(
      `variant: ${result.variant} (${result.size})`,
      `region: ${result.region.width}x${result.region.height} at ` +
        `(${result.region.x}, ${result.region.y})`,
    );
  }
  for (const attempt of result.attempts) {
    lines.push(
      `  tried ${attempt.variant}: confidence ${attempt.confidence.toFixed(3)} ` +
        `(spatial ${attempt.scores.spatial.toFixed(3)}` +
        `${attempt.circuitBreaker ? ', circuit breaker' : ''})`,
    );
  }
  return lines.join('\n');
}

async function run(file: File): Promise<void> {
  status.textContent = `decoding ${file.name}…`;
  detail.textContent = '';
  hideDownload();

  const { image, imageData, canvas } = await decode(file);

  // In place: `image.data` *is* `imageData.data`, so the canvas gets the
  // result back without a copy. On a skip the engine leaves every byte
  // alone, which is the property that makes running this over a folder of
  // holiday photos safe.
  const result = processImage(image);

  status.textContent =
    result.status === 'processed'
      ? `removed a ${result.variant} watermark from ${file.name}`
      : `no watermark found in ${file.name} — the image is untouched`;
  detail.textContent = describe(result);

  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser gave no 2d context for an OffscreenCanvas');
  context.putImageData(imageData, 0, 0);

  // PNG, not JPEG: the removal is exact to within a bit, and a lossy
  // re-encode would throw that away on the way out.
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  if (currentUrl !== undefined) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  preview.src = currentUrl;

  // No download on a skip. The bytes are unmodified, so the only thing this
  // could hand back is the same image re-encoded — which would look like the
  // tool did something. Offering nothing is the honest report, and it is
  // also the contract's safety property made visible.
  if (result.status === 'processed') {
    download.href = currentUrl;
    download.download = file.name.replace(/\.[^.]+$/, '') + '-clean.png';
    download.hidden = false;
  }
}

picker.addEventListener('change', () => {
  const file = picker.files?.[0];
  if (file === undefined) return;
  run(file).catch((error: unknown) => {
    status.textContent = `failed: ${String(error)}`;
    detail.textContent = '';
  });
});
