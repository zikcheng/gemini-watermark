/**
 * Loading committed cases as images the engine can actually be handed.
 *
 * `test/data/cases/<name>/` holds a crop, not an image: the bytes cover the
 * watermark's neighbourhood and nothing else, because a full-size corpus
 * would not fit in the repository. Handing a crop to the engine changes
 * every geometry decision, so each one is placed back into a zero-filled
 * buffer of the original size first — the "patch + reconstruction" format
 * from PLAN.md, implemented in `reconstruct.ts`.
 *
 * Which roles a case carries is meaningful rather than incidental: a
 * skipped default run wrote no output, so it has no `golden_default`; the
 * JPEG case has no `original`; only the three forced-size runs have a
 * `golden_forced_size`. Asking for a role a case does not have is a
 * mistake in the test, so it fails by name here instead of surfacing as an
 * unreadable error from inside `readFileSync`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ImageBuffer } from '../../src/types.js';
import { decodePng } from './png.js';
import { reconstructImage, type CaseMeta, type PatchRole } from './reconstruct.js';

const CASES_DIR = join(import.meta.dirname, '..', 'data', 'cases');

export function caseMeta(name: string): CaseMeta {
  return JSON.parse(readFileSync(join(CASES_DIR, name, 'meta.json'), 'utf8')) as CaseMeta;
}

/**
 * One role of one case, decoded and rebuilt to the original image size.
 *
 * @throws Error when the case carries no image for that role
 */
export function caseImage(name: string, role: PatchRole): ImageBuffer {
  const meta = caseMeta(name);
  const entry = meta.patch.files[role];
  if (entry === undefined) {
    throw new Error(
      `${name}: no "${role}" image; available roles: ${Object.keys(meta.patch.files).join(', ')}`,
    );
  }
  const patch = decodePng(new Uint8Array(readFileSync(join(CASES_DIR, name, entry.file))));
  return reconstructImage(patch, meta);
}
