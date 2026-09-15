import type { Config } from '../../src/config.js';

/**
 * A complete, inert Config for tests: no MCP auth, no dashboard, no ParentVUE,
 * an in-memory database and silent logging. Override only what a test is about.
 *
 * Shared so a new Config field cannot quietly diverge across test files —
 * `test/` is excluded from tsconfig.json and vitest does not typecheck, so a
 * fixture missing a field fails at runtime, if at all, rather than at build.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '0.0.0.0',
    ui: { port: undefined, host: '0.0.0.0', allowWildcardBind: false },
    nodeEnv: 'test',
    logLevel: 'silent',
    tz: 'UTC',
    dataDir: './data',
    mcpBearerToken: undefined,
    access: { teamDomain: undefined, aud: undefined, allowedEmails: [], allowedServiceTokens: [] },
    gradebook: {
      dbPath: ':memory:',
      parentvueHost: undefined,
      parentvueUser: undefined,
      parentvuePass: undefined,
      syncIntervalHours: 0,
      syncEnabled: false,
      students: [],
    },
    devInsecureNoAuth: false,
    ...overrides,
  };
}
