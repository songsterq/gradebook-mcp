import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { isDevInsecureNoAuthActive, StartupError } from '../config.js';
import type { Identity } from './identity.js';
import { describeIdentity } from './identity.js';

const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export class AuthError extends Error {
  constructor(
    public readonly statusCode: 403,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface AccessJwtPayload extends JWTPayload {
  email?: string;
  // Cloudflare puts the service token's Client ID here, not its display name.
  common_name?: string;
}

/**
 * Cloudflare Access JWT verifier. Holds a cached remote JWKS fetcher so we
 * don't refetch keys on every request; jose handles its own key-rotation
 * caching internally.
 */
export class CloudflareAccessVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly teamDomain: string;
  private readonly audience: string;

  constructor(teamDomain: string, audience: string) {
    this.teamDomain = teamDomain.replace(/\/$/, '');
    this.audience = audience;
    this.jwks = createRemoteJWKSet(new URL(`${this.teamDomain}/cdn-cgi/access/certs`));
  }

  async verify(token: string): Promise<AccessJwtPayload> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.teamDomain,
      audience: this.audience,
    });
    return payload as AccessJwtPayload;
  }
}

function resolveIdentity(
  payload: AccessJwtPayload,
  allowedEmails: string[],
  allowedServiceTokens: string[],
): Identity {
  const allowedEmailsLower = allowedEmails.map((e) => e.toLowerCase());
  const allowedServiceTokensLower = allowedServiceTokens.map((s) => s.toLowerCase());

  if (payload.common_name) {
    if (!allowedServiceTokensLower.includes(payload.common_name.toLowerCase())) {
      throw new AuthError(403, `service token '${payload.common_name}' is not on the allowlist`);
    }
    return { kind: 'service', id: payload.sub || payload.common_name, name: payload.common_name };
  }

  if (payload.email) {
    if (!allowedEmailsLower.includes(payload.email.toLowerCase())) {
      throw new AuthError(403, `email '${payload.email}' is not on the allowlist`);
    }
    return { kind: 'user', id: String(payload.sub ?? payload.email), email: payload.email };
  }

  throw new AuthError(403, 'JWT has neither email nor common_name claim');
}

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

export function createAccessAuthMiddleware(config: Config, logger: Logger) {
  const devBypass = isDevInsecureNoAuthActive(config);

  if (devBypass) {
    logger.warn(
      '*** DEV_INSECURE_NO_AUTH is active: all Cloudflare Access verification is BYPASSED. ' +
        'This is only permitted outside production while bound to loopback. Never use in compose/production. ***',
    );
  }

  let verifier: CloudflareAccessVerifier | undefined;
  if (!devBypass) {
    if (!config.access.teamDomain || !config.access.aud) {
      throw new StartupError(
        'ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set unless DEV_INSECURE_NO_AUTH is active',
      );
    }
    verifier = new CloudflareAccessVerifier(config.access.teamDomain, config.access.aud);
  }

  return async function accessAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    if (devBypass) {
      req.identity = { kind: 'dev-insecure' };
      next();
      return;
    }

    const token = req.header(ACCESS_JWT_HEADER);
    if (!token) {
      logger.warn({ path: req.path }, 'auth: missing Cf-Access-Jwt-Assertion header');
      res.status(401).json({ error: 'missing Cf-Access-Jwt-Assertion header' });
      return;
    }

    try {
      const payload = await verifier!.verify(token);
      const identity = resolveIdentity(payload, config.access.allowedEmails, config.access.allowedServiceTokens);
      req.identity = identity;
      logger.info({ identity: describeIdentity(identity), path: req.path }, 'auth: verified');
      next();
    } catch (err) {
      if (err instanceof AuthError) {
        logger.warn({ path: req.path, reason: err.message }, 'auth: forbidden');
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      if (
        err instanceof joseErrors.JWTExpired ||
        err instanceof joseErrors.JWTClaimValidationFailed ||
        err instanceof joseErrors.JWSSignatureVerificationFailed ||
        err instanceof joseErrors.JWTInvalid
      ) {
        logger.warn({ path: req.path, reason: (err as Error).message }, 'auth: invalid JWT');
        res.status(401).json({ error: 'invalid or expired token' });
        return;
      }
      logger.error({ path: req.path, err }, 'auth: unexpected verification error');
      res.status(401).json({ error: 'token verification failed' });
    }
  };
}
