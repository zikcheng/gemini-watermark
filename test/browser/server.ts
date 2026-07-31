/**
 * The smallest HTTP server that can host the smoke test.
 *
 * A server is needed at all because Chromium refuses `file://` module
 * imports, and the whole point of the page is that `import '/dist/index.js'`
 * resolves the way a consumer's would. `127.0.0.1` rather than a LAN address
 * because the page hashes with `crypto.subtle`, which only exists in a
 * secure context — and loopback counts as one, while `192.168.x.x` does not.
 *
 * Routing is an allowlist rather than a static file handler: three exact
 * paths plus one prefix. A test fixture is not the place to write path
 * normalization that has to be right, and nothing here needs to serve a
 * directory.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface SmokeServer {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Serve the built bundle, the test page, and one raw pixel buffer per case.
 *
 * @param pixels case name → the reconstructed RGB bytes that case should see
 */
export async function startSmokeServer(pixels: Map<string, Uint8Array>): Promise<SmokeServer> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';

      const pixelMatch = /^\/__pixels\/(?<name>[A-Za-z0-9._-]+)\.bin$/.exec(path);
      const name = pixelMatch?.groups?.['name'];
      if (name !== undefined) {
        const bytes = pixels.get(name);
        if (bytes === undefined) {
          response.writeHead(404).end(`no pixels registered for ${name}`);
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
        });
        response.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        return;
      }

      const served =
        path === '/page.html'
          ? 'test/browser/page.html'
          : path === '/dist/index.js' || path === '/dist/index.js.map'
            ? path.slice(1)
            : undefined;
      if (served === undefined) {
        response.writeHead(404).end(`not served: ${path}`);
        return;
      }

      try {
        const body = await readFile(join(REPO_ROOT, served));
        const extension = served.slice(served.lastIndexOf('.'));
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        });
        response.end(body);
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
