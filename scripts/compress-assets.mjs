// Writes .br and .gz siblings for text assets in dist/client so the server can
// send precompressed files (@fastify/static `preCompressed`). No extra dependencies.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = path.resolve('dist/client');
const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|txt|map)$/;
let count = 0;
let saved = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (COMPRESSIBLE.test(entry.name) && (await stat(full)).size >= 1024) {
      const data = await readFile(full);
      const br = brotliCompressSync(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      });
      const gz = gzipSync(data, { level: 9 });
      await writeFile(`${full}.br`, br);
      await writeFile(`${full}.gz`, gz);
      count += 1;
      saved += data.length - br.length;
    }
  }
}

await walk(root);
console.log(`precompressed ${count} assets (brotli saves ${(saved / 1024).toFixed(0)} KiB)`);
