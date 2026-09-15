import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

/**
 * Compare two secrets in constant time. Both sides are hashed first so a
 * length mismatch cannot short-circuit the comparison and leak the token's
 * length.
 */
export function secretsMatch(expected: string, presented: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

function bearerFrom(req: Request): string | undefined {
  const header = req.header('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Static bearer-token auth for the MCP endpoint: `Authorization: Bearer <token>`.
 *
 * The 401 is deliberately bare, with no `WWW-Authenticate`: this server serves
 * no OAuth discovery document, so a challenge would point clients at
 * something that does not exist. Configure the token client-side instead.
 */
export function createBearerAuthMiddleware(token: string, logger: Logger) {
  if (token.length < 16) {
    throw new Error('MCP_BEARER_TOKEN must be at least 16 characters; generate one with `openssl rand -hex 32`');
  }

  return function bearerAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    const presented = bearerFrom(req);
    if (!presented) {
      logger.warn({ path: req.path }, 'auth: missing bearer token');
      res.status(401).json({ error: 'missing or invalid bearer token' });
      return;
    }
    if (!secretsMatch(token, presented)) {
      logger.warn({ path: req.path }, 'auth: bearer token mismatch');
      res.status(401).json({ error: 'missing or invalid bearer token' });
      return;
    }
    req.identity = { kind: 'bearer' };
    next();
  };
}
