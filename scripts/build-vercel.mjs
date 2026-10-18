// Produces a Vercel Build Output API (v3) bundle in .vercel/output:
//
//   static/                  the built frontend (served by Vercel's CDN)
//   functions/api/index.func the whole /api surface as one Node.js function
//   config.json              routes (security headers, SPA fallback) and the
//                            daily cleanup cron
//
// Run after `npm run build:web`:  npm run build:vercel
// See docs/DEPLOYMENT.md ("Vercel") for the required storage and settings.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const OUT = path.resolve('.vercel/output');
const FUNC = path.join(OUT, 'functions/api/index.func');
const RUNTIME = process.env.VERCEL_NODE_RUNTIME ?? 'nodejs24.x';

await rm(OUT, { recursive: true, force: true });
await mkdir(FUNC, { recursive: true });

// Static files. Vercel compresses on the fly, so skip our precompressed copies.
await cp(path.resolve('dist/client'), path.join(OUT, 'static'), {
  recursive: true,
  filter: (source) => !/\.(br|gz)$/.test(source),
});

// The API function: everything bundled (no node_modules in the function), with
// rarely used SDKs (S3) split into chunks that load only when configured.
await build({
  entryPoints: { index: 'src/server/vercel.ts' },
  outdir: FUNC,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Optional native addons of `ws`; it falls back to JavaScript without them.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: [
      "import { createRequire as __preprati_createRequire } from 'node:module';",
      "import { fileURLToPath as __preprati_fileURLToPath } from 'node:url';",
      "import { dirname as __preprati_dirname } from 'node:path';",
      'const require = __preprati_createRequire(import.meta.url);',
      'const __filename = __preprati_fileURLToPath(import.meta.url);',
      'const __dirname = __preprati_dirname(__filename);',
    ].join('\n'),
  },
  minify: true,
  // Error classes are matched by name in some libraries; keep names intact.
  keepNames: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

await writeFile(
  path.join(FUNC, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: RUNTIME,
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 60,
    },
    null,
    2,
  ),
);
await writeFile(path.join(FUNC, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

// Same policy as the Node server's HTML responses (src/server/security/headers.ts).
// Signaling is same-origin HTTP here, so connect-src needs nothing beyond 'self'.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': csp,
};

const config = {
  version: 3,
  routes: [
    // The API sets its own headers (Fastify); everything else gets the static policy.
    { src: '^/(?!api/).*', headers: securityHeaders, continue: true },
    {
      src: '^/assets/.+',
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      continue: true,
    },
    // All API paths go to the one function; the original path travels along as
    // `__path`, in case the platform passes the rewritten URL (see vercel.ts).
    { src: '^/api/(.*)$', dest: '/api/index?__path=$1' },
    { handle: 'filesystem' },
    // Client-side routes (/send, /receive, /j/…, /s/…) all load the app shell.
    { src: '^/(?!api/|assets/).*', dest: '/index.html', headers: { 'Cache-Control': 'no-cache' } },
  ],
  crons: [{ path: '/api/cron/cleanup', schedule: '17 4 * * *' }],
};
await writeFile(path.join(OUT, 'config.json'), JSON.stringify(config, null, 2));

console.log(`Vercel output written to ${path.relative(process.cwd(), OUT)} (runtime ${RUNTIME})`);
