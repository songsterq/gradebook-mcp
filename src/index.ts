import pino from 'pino';
import type { Server } from 'node:http';
import { loadEnvFile } from 'node:process';
import { isUiEnabled, loadConfig } from './config.js';
import { createGradebookModule } from './modules/gradebook/index.js';
import type { HomeModule } from './modules/types.js';
import { createApp } from './server.js';
import { createUiApp } from './ui/server.js';

// Local commands read .env; deployments may supply the environment directly.
try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const modules: HomeModule[] = [createGradebookModule(config, logger)];

const app = createApp(config, logger, modules);

const server = app.listen(config.port, config.host, () => {
  logger.info({ port: config.port, host: config.host }, 'gradebook-mcp listening');
});
server.on('error', (err) => {
  logger.fatal({ err }, 'gradebook-mcp listener failed');
  process.exit(1);
});

const servers: Server[] = [server];

if (isUiEnabled(config)) {
  const uiServer = createUiApp({ config, logger }, modules).listen(config.ui.port, config.ui.host, () => {
    logger.warn(
      { port: config.ui.port, host: config.ui.host },
      `*** The gradebook dashboard on ${config.ui.host}:${config.ui.port} is UNAUTHENTICATED. Anyone who can reach this port can read every student's grades and trigger a ParentVUE sync. It is network-isolated only: never publish it to the Internet and never point a tunnel or public reverse-proxy route at it. ***`,
    );
  });
  uiServer.on('error', (err) => {
    logger.fatal({ err }, 'dashboard listener failed');
    process.exit(1);
  });
  servers.push(uiServer);
}

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  // Dispose only once in-flight requests have drained: a module's dispose
  // closes its database, and a request still holding it would fail.
  let remaining = servers.length;
  for (const listeningServer of servers) {
    listeningServer.close(() => {
      remaining -= 1;
      if (remaining > 0) return;
      for (const module of modules) module.dispose?.();
      process.exit(0);
    });
  }
  // Force exit if close hangs (e.g. lingering keep-alive sockets).
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
