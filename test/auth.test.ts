import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pino from 'pino';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessAuthMiddleware } from '../src/auth/cloudflareAccess.js';
import type { Config } from '../src/config.js';

const AUD = 'test-audience';
const KID = 'test-key-1';
const ALLOWED_EMAIL = 'song@example.com';
const ALLOWED_SERVICE_TOKEN = 'e367826f93b8d71185e03fe518aff3b4.access';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '0.0.0.0',
    ui: { port: undefined, host: '0.0.0.0' },
    nodeEnv: 'test',
    logLevel: 'silent',
    tz: 'UTC',
    dataDir: './data',
    mcpBearerToken: undefined,
    access: {
      teamDomain: undefined,
      aud: AUD,
      allowedEmails: [ALLOWED_EMAIL],
      allowedServiceTokens: [ALLOWED_SERVICE_TOKEN],
    },
    devInsecureNoAuth: false,
    ...overrides,
  };
}

describe('Cloudflare Access auth middleware', () => {
  let jwksServer: http.Server;
  let teamDomain: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let app: express.Express;
  let appServer: http.Server;
  let appUrl: string;

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
    privateKey = priv;
    const jwk = await exportJWK(publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    jwksServer = http.createServer((req, res) => {
      if (req.url === '/cdn-cgi/access/certs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const jwksPort = (jwksServer.address() as AddressInfo).port;
    teamDomain = `http://127.0.0.1:${jwksPort}`;

    const config = baseConfig({ access: { teamDomain, aud: AUD, allowedEmails: [ALLOWED_EMAIL], allowedServiceTokens: [ALLOWED_SERVICE_TOKEN] } });
    const logger = pino({ level: 'silent' });
    const middleware = createAccessAuthMiddleware(config, logger);

    app = express();
    app.get('/mcp', middleware, (req, res) => {
      res.status(200).json({ identity: req.identity });
    });
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const appPort = (appServer.address() as AddressInfo).port;
    appUrl = `http://127.0.0.1:${appPort}/mcp`;
  });

  afterAll(async () => {
    await new Promise((resolve) => jwksServer.close(resolve));
    await new Promise((resolve) => appServer.close(resolve));
  });

  async function sign(claims: Record<string, unknown>, opts: { exp?: string; iss?: string; aud?: string } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setIssuer(opts.iss ?? teamDomain)
      .setAudience(opts.aud ?? AUD)
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
  }

  it('accepts a valid user JWT and resolves identity', async () => {
    const token = await sign({ email: ALLOWED_EMAIL, sub: 'user-123' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: unknown };
    expect(body.identity).toEqual({ kind: 'user', id: 'user-123', email: ALLOWED_EMAIL });
  });

  it('accepts a service token Client ID via common_name with an empty sub', async () => {
    const token = await sign({ common_name: ALLOWED_SERVICE_TOKEN, sub: '' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: unknown };
    expect(body.identity).toEqual({ kind: 'service', id: ALLOWED_SERVICE_TOKEN, name: ALLOWED_SERVICE_TOKEN });
  });

  it('returns 401 when the header is missing', async () => {
    const res = await fetch(appUrl);
    expect(res.status).toBe(401);
    // Cloudflare Access answers the OAuth challenge at the edge; the origin
    // deliberately issues a bare 401 rather than a challenge pointing at a
    // discovery document it does not serve.
    expect(res.headers.has('www-authenticate')).toBe(false);
  });

  it('returns 401 for a token with the wrong audience', async () => {
    const token = await sign({ email: ALLOWED_EMAIL }, { aud: 'wrong-audience' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(401);
    expect(res.headers.has('www-authenticate')).toBe(false);
  });

  it('returns 401 for a token with the wrong issuer', async () => {
    const token = await sign({ email: ALLOWED_EMAIL }, { iss: 'http://not-the-team-domain.example' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const token = await sign({ email: ALLOWED_EMAIL }, { exp: '-10s' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a valid token whose email is not on the allowlist', async () => {
    const token = await sign({ email: 'stranger@example.com' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(403);
    expect(res.headers.has('www-authenticate')).toBe(false);
  });

  it('returns 403 for a valid service token whose common_name is not on the allowlist', async () => {
    const token = await sign({ common_name: '00000000000000000000000000000000.access', sub: '' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(403);
  });

  it('does not treat a service token display name as its Client ID', async () => {
    const token = await sign({ common_name: 'grok-bot', sub: '' });
    const res = await fetch(appUrl, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(res.status).toBe(403);
  });
});

describe('dev insecure bypass gating', () => {
  it('is inert when NODE_ENV is production, even if the flag is set', async () => {
    const { isDevInsecureNoAuthActive } = await import('../src/config.js');
    const config = baseConfig({ nodeEnv: 'production', host: '127.0.0.1', devInsecureNoAuth: true });
    expect(isDevInsecureNoAuthActive(config)).toBe(false);
  });

  it('is inert when not bound to loopback', async () => {
    const { isDevInsecureNoAuthActive } = await import('../src/config.js');
    const config = baseConfig({ nodeEnv: 'development', host: '0.0.0.0', devInsecureNoAuth: true });
    expect(isDevInsecureNoAuthActive(config)).toBe(false);
  });

  it('is inert when bound to localhost', async () => {
    const { isDevInsecureNoAuthActive } = await import('../src/config.js');
    const config = baseConfig({ nodeEnv: 'development', host: 'localhost', devInsecureNoAuth: true });
    expect(isDevInsecureNoAuthActive(config)).toBe(false);
  });

  it('is active only outside production and bound to loopback', async () => {
    const { isDevInsecureNoAuthActive } = await import('../src/config.js');
    const config = baseConfig({ nodeEnv: 'development', host: '127.0.0.1', devInsecureNoAuth: true });
    expect(isDevInsecureNoAuthActive(config)).toBe(true);
  });
});
