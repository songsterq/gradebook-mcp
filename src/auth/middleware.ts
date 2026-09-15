import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { isDevInsecureNoAuthActive } from '../config.js';
import { createBearerAuthMiddleware } from './bearerToken.js';
import { createAccessAuthMiddleware } from './cloudflareAccess.js';

export type AuthMode = 'dev-insecure' | 'bearer' | 'cloudflare-access';

const CONFIGURE_ONE =
  'configure exactly one MCP auth mode: MCP_BEARER_TOKEN, or ACCESS_TEAM_DOMAIN + ACCESS_AUD (Cloudflare Access)';

/**
 * Which auth mode the config selects, or a startup error when it is ambiguous
 * or absent. Exactly one mode must be configured: a server that silently
 * picked one of two would leave the operator unsure which credential guards
 * the endpoint.
 */
export function resolveAuthMode(config: Config): AuthMode {
  if (isDevInsecureNoAuthActive(config)) return 'dev-insecure';
  const bearer = config.mcpBearerToken !== undefined;
  const access = config.access.teamDomain !== undefined || config.access.aud !== undefined;
  if (bearer && access) throw new Error(`both MCP_BEARER_TOKEN and ACCESS_* are set; ${CONFIGURE_ONE}`);
  if (bearer) return 'bearer';
  if (access) {
    if (!config.access.teamDomain || !config.access.aud) {
      throw new Error(`ACCESS_TEAM_DOMAIN and ACCESS_AUD must both be set; ${CONFIGURE_ONE}`);
    }
    return 'cloudflare-access';
  }
  throw new Error(`no MCP auth configured; ${CONFIGURE_ONE}`);
}

export function createAuthMiddleware(config: Config, logger: Logger): RequestHandler {
  const mode = resolveAuthMode(config);
  switch (mode) {
    case 'bearer':
      logger.info('MCP auth: static bearer token');
      return createBearerAuthMiddleware(config.mcpBearerToken!, logger);
    case 'cloudflare-access':
      logger.info({ teamDomain: config.access.teamDomain }, 'MCP auth: Cloudflare Access JWT');
      return createAccessAuthMiddleware(config, logger);
    case 'dev-insecure':
      // createAccessAuthMiddleware owns the bypass and its loud warning.
      return createAccessAuthMiddleware(config, logger);
  }
}
