// Bundles the Node backend into dist/server/index.js. Runtime dependencies stay
// external (installed via npm in production); shared TypeScript is inlined.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
