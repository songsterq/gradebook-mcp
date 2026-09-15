import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
