import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './core/config/config.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Before the logger exists. ConfigError lists names and rules, never values.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildApp(config);

  // Finish in-flight requests, then close the pool, when the platform asks the container to stop.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ host: config.HOST, port: config.PORT });
}

void main();
