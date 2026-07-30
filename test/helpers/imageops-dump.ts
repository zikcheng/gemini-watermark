/**
 * Reader for the committed cv2 operator dumps under `test/data/imageops/`.
 *
 * Each dump is a `.json` of metadata plus `.bin` siblings holding the
 * arrays. Fields named `input`, `output` or `result` hold **array keys**,
 * not filenames — they resolve through the JSON's own `arrays` block,
 * which carries the dtype and shape. Every path in this file goes through
 * {@link DumpReader.array}, so no caller ever builds a `.bin` path by hand
 * or guesses a dtype.
 *
 * See `tools/reference/dump_imageops.py` for how the dumps are produced.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DUMP_DIR = join(import.meta.dirname, '..', 'data', 'imageops');
const CASES_DIR = join(import.meta.dirname, '..', 'data', 'cases');

interface ArrayRecord {
  file: string;
  dtype: string;
  shape: number[];
}

interface DumpJson {
  format_version: number;
  name: string;
  cv2_version: string;
  arrays?: Record<string, ArrayRecord>;
  [key: string]: unknown;
}

/** An array from a dump, with the shape cv2 recorded for it. */
export interface DumpArray<T extends Float32Array | Uint8Array> {
  data: T;
  shape: number[];
  /** Convenience for the 2-D case: shape is [height, width] as numpy reports. */
  height: number;
  width: number;
}

export class DumpReader {
  readonly meta: DumpJson;

  constructor(name: string) {
    this.meta = JSON.parse(readFileSync(join(DUMP_DIR, `${name}.json`), 'utf8')) as DumpJson;
    if (this.meta.name !== name) {
      throw new Error(`dump ${name}.json declares name "${this.meta.name}"`);
    }
  }

  /** Entries of a list-valued metadata field, typed by the caller. */
  entries<T>(field: string): T[] {
    const value = this.meta[field];
    if (!Array.isArray(value)) {
      throw new Error(`dump ${this.meta.name} has no list field "${field}"`);
    }
    return value as T[];
  }

  /**
   * Load one array by its key, verifying the file is exactly the size its
   * declared dtype and shape imply. A silent size mismatch would turn into
   * a garbage comparison rather than an error.
   */
  array(key: string): DumpArray<Float32Array | Uint8Array> {
    const record = this.meta.arrays?.[key];
    if (record === undefined) {
      const available = Object.keys(this.meta.arrays ?? {}).join(', ');
      throw new Error(
        `dump ${this.meta.name} has no array "${key}"; available: ${available}`,
      );
    }

    const bytes = readFileSync(join(DUMP_DIR, record.file));
    const count = record.shape.reduce((n, d) => n * d, 1);
    const bytesPerElement = record.dtype === 'float32' ? 4 : 1;
    if (bytes.length !== count * bytesPerElement) {
      throw new Error(
        `dump ${this.meta.name} array "${key}": ${record.file} is ${bytes.length} ` +
          `bytes, expected ${count * bytesPerElement} for ${record.dtype} ` +
          `${record.shape.join('x')}`,
      );
    }

    // The .bin files are raw little-endian buffers. Copy into a fresh
    // typed array rather than viewing the Buffer, so byteOffset alignment
    // is never an issue and a caller mutating the result cannot corrupt a
    // later read.
    let data: Float32Array | Uint8Array;
    if (record.dtype === 'float32') {
      data = new Float32Array(count);
      for (let i = 0; i < count; i += 1) data[i] = bytes.readFloatLE(i * 4);
    } else if (record.dtype === 'uint8') {
      data = Uint8Array.from(bytes);
    } else {
      throw new Error(`dump ${this.meta.name} array "${key}": unsupported dtype ${record.dtype}`);
    }

    const [height = count, width = 1] = record.shape;
    return { data, shape: record.shape, height, width };
  }

  float32(key: string): DumpArray<Float32Array> {
    const loaded = this.array(key);
    if (!(loaded.data instanceof Float32Array)) {
      throw new Error(`dump ${this.meta.name} array "${key}" is not float32`);
    }
    return loaded as DumpArray<Float32Array>;
  }

  uint8(key: string): DumpArray<Uint8Array> {
    const loaded = this.array(key);
    if (!(loaded.data instanceof Uint8Array)) {
      throw new Error(`dump ${this.meta.name} array "${key}" is not uint8`);
    }
    return loaded as DumpArray<Uint8Array>;
  }
}

/** Absolute path of a committed case image referenced by a dump's `source`. */
export function casePath(relative: string): string {
  return join(CASES_DIR, relative);
}

/**
 * PLAN.md's dual tolerance for cv2-dump comparisons:
 * `absErr <= absTol + relTol * |expected|`.
 *
 * Written out instead of `toBeCloseTo`, which measures decimal places and
 * would silently accept or reject the wrong things at these magnitudes.
 */
export function withinDualTolerance(
  actual: number,
  expected: number,
  absTol: number,
  relTol: number,
): boolean {
  return Math.abs(actual - expected) <= absTol + relTol * Math.abs(expected);
}
