import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router, type Express } from 'express';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from './helpers/config.js';
import type { HomeModule, UiContext } from '../src/modules/types.js';
import { securityHeaders } from '../src/ui/security.js';
import { createUiApp } from '../src/ui/server.js';

function listen(app: Express, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, host, (err?: Error) => (err ? reject(err) : resolve(server)));
    server.once('error', reject);
  });
}

const config = testConfig({
  port: 0,
  host: '127.0.0.1',
  ui: { port: 0, host: '127.0.0.1', allowWildcardBind: false },
  tz: 'America/Los_Angeles',
  dataDir: '.',
  gradebook: {
    dbPath: ':memory:',
    parentvueHost: 'example.invalid',
    parentvueUser: undefined,
    parentvuePass: undefined,
    syncIntervalHours: 0,
    syncEnabled: false,
    students: [],
  },
  devInsecureNoAuth: true,
});

/** Stands in for a module dashboard: one safe route and one mutating route,
 *  mounted under /probe so the mount-path logging behaviour is exercised. */
const probeModule: HomeModule = {
  name: 'probe',
  register() {},
  createUiRouter(_ctx: UiContext) {
    const router = Router();
    router.get('/', (_req, res) => {
      res.status(200).type('text/plain').send('page');
    });
    router.post('/sync', (_req, res) => {
      res.redirect(303, '/probe');
    });
    return router;
  },
};

describe('dashboard cross-origin check', () => {
  let server: Server | undefined;
  let baseUrl: string;
  let host: string;
  let lines: Record<string, unknown>[];

  beforeEach(async () => {
    lines = [];
    const logger = pino(
      { level: 'info' },
      {
        write(chunk: string) {
          lines.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      },
    );
    const app = createUiApp({ config, logger }, [probeModule]);
    server = await listen(app, '127.0.0.1');
    const port = (server.address() as AddressInfo).port;
    host = `127.0.0.1:${port}`;
    baseUrl = `http://${host}`;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    server = undefined;
  });

  describe('dashboard-only mode', () => {
    it('serves /healthz with no MCP auth configured', async () => {
      // The Docker HEALTHCHECK falls back to this port when PORT is blank, so a
      // dashboard-only container depends on it answering.
      expect(config.mcpBearerToken).toBeUndefined();
      expect(config.access.teamDomain).toBeUndefined();

      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('serves the dashboard itself with no MCP auth configured', async () => {
      const res = await fetch(`${baseUrl}/probe`);
      expect(res.status).toBe(200);
    });

    it('keeps health probes out of the request log', async () => {
      await fetch(`${baseUrl}/healthz`);
      expect(lines.some((line) => line.path === '/healthz')).toBe(false);
    });
  });

  function post(headers: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}/probe/sync`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: '',
    });
  }

  function refusal(): Record<string, unknown> | undefined {
    return lines.find((line) => line.msg === 'dashboard write refused by the cross-origin check');
  }

  it('lets safe methods through without an Origin', async () => {
    const res = await fetch(`${baseUrl}/probe`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(refusal()).toBeUndefined();
  });

  it('accepts a urlencoded POST carrying neither Origin nor Sec-Fetch-Site', async () => {
    expect((await post({})).status).toBe(303);
    expect(refusal()).toBeUndefined();
  });

  it('accepts an opaque Origin when Sec-Fetch-Site says same-origin', async () => {
    // Regression: a page served with `Referrer-Policy: no-referrer` makes the browser
    // send `Origin: null` on a native form POST. Rejecting that 403'd Sync now.
    const res = await post({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(303);
    expect(refusal()).toBeUndefined();
  });

  it('refuses an opaque Origin with no Sec-Fetch-Site to corroborate it', async () => {
    expect((await post({ Origin: 'null' })).status).toBe(403);
    expect(refusal()?.reason).toBe('origin_null_unverified');
  });

  it('refuses an opaque Origin declared cross-site', async () => {
    const res = await post({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(refusal()?.reason).toBe('fetch_site');
  });

  it('refuses a Sec-Fetch-Site of same-site', async () => {
    expect((await post({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect(refusal()?.reason).toBe('fetch_site');
  });

  it('refuses an Origin whose host differs from Host', async () => {
    const res = await post({ Origin: 'https://elsewhere.example.com' });
    expect(res.status).toBe(403);
    expect(refusal()?.reason).toBe('origin_mismatch');
  });

  it('accepts an Origin whose host matches Host', async () => {
    const res = await post({ Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(303);
    expect(refusal()).toBeUndefined();
  });

  it('refuses an unparseable Origin', async () => {
    expect((await post({ Origin: 'not a url' })).status).toBe(403);
    expect(refusal()?.reason).toBe('origin_unparseable');
  });

  it('refuses a non-form content type', async () => {
    const res = await fetch(`${baseUrl}/probe/sync`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(403);
    expect(refusal()?.reason).toBe('content_type');
  });

  it('logs the full path for a request a mounted router handled', async () => {
    await fetch(`${baseUrl}/probe?view=missing`, { redirect: 'manual' });
    const entry = lines.find((line) => line.msg === 'ui request');
    // `req.path` would read '/' here: the router strips its mount path and only
    // restores it when it calls next(). The query string is dropped.
    expect(entry?.path).toBe('/probe');
  });

  it('logs the full path for a POST the router accepted', async () => {
    await post({});
    const entry = lines.find((line) => line.msg === 'ui request' && line.method === 'POST');
    expect(entry?.path).toBe('/probe/sync');
    expect(entry?.status).toBe(303);
  });
});

describe('securityHeaders', () => {
  it('uses a referrer policy that preserves the Origin on form POSTs', () => {
    // `no-referrer` nulls the Origin of a navigation form POST, which the
    // cross-origin check then cannot verify against Host.
    expect(securityHeaders('abc')['Referrer-Policy']).toBe('same-origin');
  });
});
