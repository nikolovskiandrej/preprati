/**
 * Process entry point: loads configuration, starts the HTTP/WebSocket server
 * and shuts down gracefully on SIGINT/SIGTERM.
 */
import packageJson from '../../package.json' with { type: 'json' };
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, packageJson.version);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const { app, shareReady } = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  await shareReady;

  const share = config.share.enabled
    ? `hosted sharing via ${config.share.driver} storage`
    : `hosted sharing off (${config.share.unavailableReason})`;
  app.log.info(`preprati. backend listening on http://${config.host}:${config.port} — ${share}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
