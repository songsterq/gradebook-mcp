import { describe, expect, it } from 'vitest';
import { assertRunnable, isMcpEnabled, isUiEnabled, loadConfig } from '../src/config.js';
import { testConfig } from './helpers/config.js';

describe('GRADEBOOK_SYNC_ENABLED', () => {
  it('defaults to off', () => {
    const config = loadConfig({});
    expect(config.gradebook.syncEnabled).toBe(false);
  });

  it('enables when set to true', () => {
    const config = loadConfig({ GRADEBOOK_SYNC_ENABLED: 'true' });
    expect(config.gradebook.syncEnabled).toBe(true);
  });

  it('treats other values as off', () => {
    const config = loadConfig({ GRADEBOOK_SYNC_ENABLED: '1' });
    expect(config.gradebook.syncEnabled).toBe(false);
  });
});

describe('optional strings', () => {
  it('has no default ParentVUE host', () => {
    expect(loadConfig({}).gradebook.parentvueHost).toBeUndefined();
    expect(loadConfig({ GRADEBOOK_PARENTVUE_HOST: ' ' }).gradebook.parentvueHost).toBeUndefined();
    expect(loadConfig({ GRADEBOOK_PARENTVUE_HOST: 'district.example' }).gradebook.parentvueHost).toBe(
      'district.example',
    );
  });

  it('treats a blank MCP_BEARER_TOKEN as unset', () => {
    expect(loadConfig({}).mcpBearerToken).toBeUndefined();
    expect(loadConfig({ MCP_BEARER_TOKEN: '' }).mcpBearerToken).toBeUndefined();
    expect(loadConfig({ MCP_BEARER_TOKEN: 'abc' }).mcpBearerToken).toBe('abc');
  });

  it('treats blank ACCESS_* values as unset', () => {
    const config = loadConfig({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' });
    expect(config.access.teamDomain).toBeUndefined();
    expect(config.access.aud).toBeUndefined();
  });

  it('derives the database path from DATA_DIR', () => {
    expect(loadConfig({ DATA_DIR: '/data' }).gradebook.dbPath).toBe('/data/gradebook.sqlite');
  });
});

describe('listener selection', () => {
  it('treats a blank PORT as the MCP listener being off', () => {
    expect(isMcpEnabled(loadConfig({ PORT: '', UI_PORT: '3001' }))).toBe(false);
    expect(isMcpEnabled(loadConfig({ PORT: '3000' }))).toBe(true);
  });

  it('keeps the existing blank-UI_PORT behaviour', () => {
    expect(isUiEnabled(loadConfig({ PORT: '3000', UI_PORT: '' }))).toBe(false);
    expect(isUiEnabled(loadConfig({ PORT: '3000', UI_PORT: '3001' }))).toBe(true);
  });

  it('runs the dashboard with no MCP auth configured', () => {
    const config = loadConfig({ PORT: '', UI_PORT: '3001', UI_HOST: '127.0.0.1' });
    expect(() => assertRunnable(config)).not.toThrow();
    expect(config.mcpBearerToken).toBeUndefined();
  });
});

describe('assertRunnable', () => {
  it('refuses a config with no listener at all', () => {
    expect(() => assertRunnable(testConfig({ port: undefined, ui: { port: undefined, host: '0.0.0.0', allowWildcardBind: false } })))
      .toThrow(/no listener enabled/);
  });

  it('names both ports so the operator knows what to set', () => {
    expect(() => assertRunnable(testConfig({ port: undefined, ui: { port: undefined, host: '0.0.0.0', allowWildcardBind: false } })))
      .toThrow(/set PORT .*, UI_PORT /);
  });

  it('refuses a wildcard dashboard bind in production when MCP is off', () => {
    for (const host of ['0.0.0.0', '::', '[::]', ' 0.0.0.0 ']) {
      const config = testConfig({
        port: undefined,
        nodeEnv: 'production',
        ui: { port: 3001, host, allowWildcardBind: false },
      });
      expect(() => assertRunnable(config)).toThrow(/UNAUTHENTICATED/);
    }
  });

  it('allows loopback and private dashboard binds in production', () => {
    for (const host of ['127.0.0.1', '::1', '10.0.0.5', '192.168.1.20']) {
      const config = testConfig({
        port: undefined,
        nodeEnv: 'production',
        ui: { port: 3001, host, allowWildcardBind: false },
      });
      expect(() => assertRunnable(config)).not.toThrow();
    }
  });

  it('allows a wildcard dashboard bind outside production', () => {
    const config = testConfig({
      port: undefined,
      nodeEnv: 'development',
      ui: { port: 3001, host: '0.0.0.0', allowWildcardBind: false },
    });
    expect(() => assertRunnable(config)).not.toThrow();
  });

  it('leaves an MCP-enabled wildcard bind alone', () => {
    // Existing deployments behind their own firewall must keep working: the
    // bind check is scoped to the dashboard-only case.
    const config = testConfig({
      port: 3000,
      host: '0.0.0.0',
      nodeEnv: 'production',
      ui: { port: 3001, host: '0.0.0.0', allowWildcardBind: false },
    });
    expect(() => assertRunnable(config)).not.toThrow();
  });
});

describe('configuration errors', () => {
  it('reports a bad value as one readable line naming the field', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/invalid configuration: PORT/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/got "abc"/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/invalid configuration: PORT/);
  });
});

describe('UI_ALLOW_WILDCARD_BIND', () => {
  it('defaults to off', () => {
    expect(loadConfig({}).ui.allowWildcardBind).toBe(false);
  });

  it('lets a container bind the dashboard to 0.0.0.0 in production', () => {
    // What the Docker image does: Compose confines the published port to
    // UI_BIND_ADDR on the host, so the wildcard bind inside is deliberate.
    const config = loadConfig({
      PORT: '',
      UI_PORT: '3001',
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      UI_ALLOW_WILDCARD_BIND: 'true',
    });
    expect(() => assertRunnable(config)).not.toThrow();
  });

  it('still refuses a wildcard bind without the opt-out', () => {
    const config = loadConfig({ PORT: '', UI_PORT: '3001', HOST: '0.0.0.0', NODE_ENV: 'production' });
    expect(() => assertRunnable(config)).toThrow(/UNAUTHENTICATED/);
    expect(() => assertRunnable(config)).toThrow(/UI_ALLOW_WILDCARD_BIND/);
  });
});
