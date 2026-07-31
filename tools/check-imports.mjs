#!/usr/bin/env node
/**
 * Fail the build if `src/` reaches for an environment.
 *
 * The package's core promise is that the engine is environment-agnostic:
 * pixels go in as an ImageBuffer and come out the same way, so the exact
 * same code runs in Node, a browser, or a worker. A single `node:fs` or
 * `document.` in `src/` silently breaks that for one of those consumers,
 * and a bundler will happily let it through. TypeScript will not catch it
 * either — the DOM and Node globals are ambient.
 *
 * This is a deliberately dumb textual scan (CLAUDE.md / M0.md): it does
 * not parse, so a forbidden token inside a comment or string also fails.
 * That trade is intentional — the constraint is hard, and a false positive
 * costs a reword while a false negative ships a broken package.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIR = join(ROOT, 'src');

/**
 * Node built-ins are importable without the `node:` prefix, and TypeScript
 * only rejects them today because `@types/node` is absent. The golden
 * tests will pull those types in (M2), and from that point tsc stops
 * objecting to `import { readFileSync } from 'fs'` anywhere in the repo —
 * this scan becomes the only thing standing between `src/` and a Node-only
 * build. Subpaths (`fs/promises`, `stream/web`) count as the same import.
 */
const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs',
  'http', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'readline', 'stream', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib',
];

/**
 * `(?:from|import)\s*\(?\s*` covers all three import shapes in one go:
 * `from 'x'`, the bare side-effect `import 'x'`, and dynamic `import('x')`.
 *
 * Word boundaries matter elsewhere: `ImageBuffer` and `ArrayBuffer` are
 * ours and must not trip the `Buffer` rule. Both quote styles are checked
 * because the repo writes single quotes while M0.md spells the rule with
 * double.
 */
const IMPORT_PREFIX = String.raw`(?:from|import)\s*\(?\s*`;

const RULES = [
  { name: 'node: import', pattern: new RegExp(`${IMPORT_PREFIX}['"]node:`) },
  {
    name: 'node builtin',
    pattern: new RegExp(
      `${IMPORT_PREFIX}['"](?:${NODE_BUILTINS.join('|')})(?:/[^'"]*)?['"]`,
    ),
  },
  { name: 'require()', pattern: /\brequire\s*\(/ },
  { name: 'Buffer', pattern: /\bBuffer\b/ },
  { name: 'process.', pattern: /\bprocess\./ },
  { name: 'document.', pattern: /\bdocument\./ },
  { name: 'window.', pattern: /\bwindow\./ },
];

/**
 * Escape hatch for a reviewed, justified exception. It must stay empty:
 * an entry here is a hole in the environment-agnostic guarantee, so it
 * needs a comment naming the reason and the reviewer.
 * Shape: { file: 'src/foo.ts', rule: 'process.' }
 */
const ALLOWLIST = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function isAllowed(file, rule) {
  return ALLOWLIST.some((a) => a.file === file && a.rule === rule);
}

const violations = [];
const files = walk(SCAN_DIR).sort();

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { name, pattern } of RULES) {
      if (pattern.test(line) && !isAllowed(rel, name)) {
        violations.push({ file: rel, line: i + 1, rule: name, text: line.trim() });
      }
    }
  });
}

if (violations.length > 0) {
  console.error(
    `check-imports: ${violations.length} environment dependency/dependencies in src/\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`    ${v.text}`);
  }
  console.error(
    '\nsrc/ must stay environment-agnostic: no Node APIs, no DOM, no globals.',
  );
  console.error(
    'Move environment-specific code to a dedicated entry point.',
  );
  process.exit(1);
}

console.log(
  `check-imports: ${files.length} file(s) in src/ clean ` +
    `(${RULES.length} rules, ${ALLOWLIST.length} allowlisted)`,
);
