/**
 * Vercel Function entry point (Build Output API, see scripts/build-vercel.mjs).
 *
 * The Fastify app is built once per function instance and reused across
 * invocations (Fluid compute). All `/api/*` requests are routed here; static
 * assets are served by Vercel's CDN.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { waitUntil } from '@vercel/functions';
import packageJson from '../../package.json' with { type: 'json' };
import { buildApp, type PrepratiApp } from './app';
import { ConfigError, loadConfig } from './config';

let instance: Promise<PrepratiApp> | null = null;

function getInstance(): Promise<PrepratiApp> {
  instance ??= (async () => {
    const config = loadConfig(
      { SERVERLESS: 'true', TRUST_PROXY: 'true', ...process.env },
      packageJson.version,
    );
    const built = await buildApp(config, { waitUntil });
    await built.app.ready();
    await built.shareReady;
    return built;
  })().catch((error: unknown) => {
    instance = null; // retry on the next request
    throw error;
  });
  return instance;
}

/**
 * Every `/api/*` path is routed to this one function with the original path in
 * `__path` (scripts/build-vercel.mjs). Depending on how the platform rewrites,
 * the URL seen here is the original one or `/api/index?__path=…`; either way
 * the app gets the original path back, without the helper parameter.
 */
export function restoreUrl(url: string): string {
  const parsed = new URL(url, 'http://function.invalid');
  const original = parsed.searchParams.get('__path');
  if (original === null) return url;
  parsed.searchParams.delete('__path');
  const rewritten = parsed.pathname === '/api/index' || parsed.pathname === '/api/index/';
  const valid = /^[A-Za-z0-9_\-/.]*$/.test(original) && !original.split('/').includes('..');
  const pathname = rewritten && valid ? `/api/${original}` : parsed.pathname;
  const query = parsed.searchParams.toString();
  return pathname + (query ? `?${query}` : '');
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let built: PrepratiApp;
  try {
    built = await getInstance();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'Server failed to start';
    console.error('preprati. startup failed:', error);
    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ error: { code: 'internal', message } }));
    return;
  }
  if (request.url) request.url = restoreUrl(request.url);
  built.app.server.emit('request', request, response);
}
