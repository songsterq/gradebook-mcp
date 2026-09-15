import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthMiddleware, resolveAuthMode } from '../src/auth/middleware.js';
import { testConfig } from './helpers/config.js';

const TOKEN = 'c0ffee-c0ffee-c0ffee-c0ffee-c0ffee';

const baseConfig = testConfig;

describe('auth mode selection', () => {
  const logger = pino({ level: 'silent' });

  it('picks bearer when only MCP_BEARER_TOKEN is set', () => {
    expect(resolveAuthMode(baseConfig({ mcpBearerToken: TOKEN }))).toBe('bearer');
  });

  it('picks Cloudflare Access when only ACCESS_* is set', () => {
    const config = baseConfig({
      access: { teamDomain: 'https://team.example', aud: 'aud', allowedEmails: [], allowedServiceTokens: [] },
    });
    expect(resolveAuthMode(config)).toBe('cloudflare-access');
  });

  it('refuses both modes at once', () => {
    const config = baseConfig({
      mcpBearerToken: TOKEN,
      access: { teamDomain: 'https://team.example', aud: 'aud', allowedEmails: [], allowedServiceTokens: [] },
    });
    expect(() => createAuthMiddleware(config, logger)).toThrow(/exactly one/);
  });

  it('refuses neither mode', () => {
    expect(() => createAuthMiddleware(baseConfig(), logger)).toThrow(/exactly one/);
  });

  it('points a dashboard-only operator at the way out', () => {
    // This is the error someone hits when they never wanted MCP at all, so it
    // has to name the alternative rather than just demanding a token.
    expect(() => createAuthMiddleware(baseConfig(), logger)).toThrow(/leave PORT blank/);
  });

  it('refuses a half-configured Access mode', () => {
    const config = baseConfig({
      access: { teamDomain: 'https://team.example', aud: undefined, allowedEmails: [], allowedServiceTokens: [] },
    });
    expect(() => createAuthMiddleware(config, logger)).toThrow(/ACCESS_AUD/);
  });

  it('refuses a short bearer token', () => {
    expect(() => createAuthMiddleware(baseConfig({ mcpBearerToken: 'short' }), logger)).toThrow(/16 characters/);
  });

  it('lets the dev bypass win outside production on loopback', () => {
    const config = baseConfig({ nodeEnv: 'development', host: '127.0.0.1', devInsecureNoAuth: true });
    expect(resolveAuthMode(config)).toBe('dev-insecure');
  });
});

describe('bearer token middleware', () => {
  let appServer: http.Server;
  let appUrl: string;

  beforeAll(async () => {
    const middleware = createAuthMiddleware(baseConfig({ mcpBearerToken: TOKEN }), pino({ level: 'silent' }));
    const app = express();
    app.get('/mcp', middleware, (req, res) => {
      res.status(200).json({ identity: req.identity });
    });
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await new Promise((resolve) => appServer.close(resolve));
  });

  it('accepts the configured token', async () => {
    const res = await fetch(appUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: { kind: 'bearer' } });
  });

  it('accepts a case-insensitive scheme', async () => {
    const res = await fetch(appUrl, { headers: { Authorization: `bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it('returns a bare 401 without a header', async () => {
    const res = await fetch(appUrl);
    expect(res.status).toBe(401);
    expect(res.headers.has('www-authenticate')).toBe(false);
  });

  it('returns 401 for the wrong token', async () => {
    const res = await fetch(appUrl, { headers: { Authorization: `Bearer ${TOKEN}x` } });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-bearer scheme', async () => {
    const res = await fetch(appUrl, { headers: { Authorization: `Basic ${TOKEN}` } });
    expect(res.status).toBe(401);
  });
});
