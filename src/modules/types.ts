import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Router } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Identity } from '../auth/identity.js';

export interface ModuleContext {
  config: Config;
  logger: Logger;
  identity: Identity;
}

/** Context for a module's optional dashboard. No Identity: the UI app performs no
 * authentication. `config` is needed for `config.tz`. */
export interface UiContext {
  config: Config;
  logger: Logger;
}

export interface HomeModule {
  name: string;
  instructions?: string;
  register(server: McpServer, ctx: ModuleContext): void;
  /** Optional server-rendered dashboard, mounted at /<name> by the UI app. */
  createUiRouter?(ctx: UiContext): Router;
  dispose?(): void;
}
