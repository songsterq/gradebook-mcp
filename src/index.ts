import pino from 'pino';
import type { Server } from 'node:http';
import { loadEnvFile } from 'node:process';
import {
  assertRunnable,
  isMcpEnabled,
  isUiEnabled,
  loadConfig,
  StartupError,
  type Config,
} from './config.js';
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

// Stands in until the config is parsed, so a bad config still has somewhere to
// report. LOG_LEVEL is read raw because loadConfig may be the thing that failed.
const bootLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Report a startup failure as one actionable line and exit.
 *
 * A StartupError is something the operator can fix from the message alone, so
 * the stack would be noise; anything else is a bug and keeps its stack.
 */
function fail(log: pino.Logger, err: unknown): never {
  if (err instanceof StartupError) log.fatal(err.message);
  else log.fatal({ err }, 'unexpected startup failure');
  process.exit(1);
}

function startupMessage(mcp: boolean, ui: boolean): string {
  if (mcp && ui) return 'starting: MCP endpoint + dashboard';
  if (mcp) return 'starting: MCP endpoint only (dashboard disabled: UI_PORT is blank)';
  return 'starting: dashboard only (MCP disabled: PORT is blank)';
}

let config: Config;
try {
  config = loadConfig();
  assertRunnable(config);
} catch (err) {
  fail(bootLogger, err);
}

// From here on, everything logs through one instance: two pino streams buffer
// independently, which would let a fatal print ahead of a warning that happened
// before it.
const logger = pino({ level: config.logLevel });
const modules: HomeModule[] = [];
const servers: Server[] = [];

try {
  logger.info(startupMessage(isMcpEnabled(config), isUiEnabled(config)));

  modules.push(createGradebookModule(config, logger));

  // Each listener is independently optional; assertRunnable has already
  // guaranteed at least one of them starts, which the shutdown path relies on.
  if (isMcpEnabled(config)) {
    const app = createApp(config, logger, modules);
    const server = app.listen(config.port, config.host, () => {
      logger.info({ port: config.port, host: config.host }, 'MCP endpoint listening');
    });
    server.on('error', (err) => {
      logger.fatal({ err }, 'MCP listener failed');
      process.exit(1);
    });
    servers.push(server);
  }

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
} catch (err) {
  for (const module of modules) module.dispose?.();
  fail(logger, err);
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
