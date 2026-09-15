import { join } from 'node:path';
import { z } from 'zod';

const csv = () =>
  z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );

const boolFromString = () =>
  z
    .string()
    .default('false')
    .transform((value) => value.trim().toLowerCase() === 'true');

const optionalPort = () =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(1).max(65535).optional(),
  );

const envSchema = z.object({
  PORT: optionalPort(),
  HOST: z.string().default('0.0.0.0'),
  UI_PORT: optionalPort(),
  UI_HOST: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.string().default('info'),
  TZ: z.string().default('UTC'),
  DATA_DIR: z.string().default('./data'),

  MCP_BEARER_TOKEN: z.string().optional(),

  ACCESS_TEAM_DOMAIN: z.string().optional(),
  ACCESS_AUD: z.string().optional(),
  ALLOWED_EMAILS: csv(),
  ALLOWED_SERVICE_TOKENS: csv(),

  GRADEBOOK_PARENTVUE_HOST: z.string().optional(),
  GRADEBOOK_PARENTVUE_USER: z.string().optional(),
  GRADEBOOK_PARENTVUE_PASS: z.string().optional(),
  GRADEBOOK_SYNC_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
  GRADEBOOK_SYNC_ENABLED: boolFromString(),
  GRADEBOOK_STUDENTS: csv(),

  UI_ALLOW_WILDCARD_BIND: boolFromString(),

  DEV_INSECURE_NO_AUTH: boolFromString(),
});

export type Config = {
  /** MCP endpoint port. Undefined when PORT is blank: the MCP listener is off. */
  port: number | undefined;
  host: string;
  ui: {
    port: number | undefined;
    host: string;
    /** Operator states a wildcard bind is deliberate (e.g. inside a container). */
    allowWildcardBind: boolean;
  };
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  tz: string;
  dataDir: string;
  /** Static bearer token for the MCP endpoint. Mutually exclusive with `access`. */
  mcpBearerToken: string | undefined;
  access: {
    teamDomain: string | undefined;
    aud: string | undefined;
    allowedEmails: string[];
    allowedServiceTokens: string[];
  };
  gradebook: {
    dbPath: string;
    parentvueHost: string | undefined;
    parentvueUser: string | undefined;
    parentvuePass: string | undefined;
    syncIntervalHours: number;
    syncEnabled: boolean;
    students: string[];
  };
  devInsecureNoAuth: boolean;
};

/**
 * A startup failure the operator can act on: no listener enabled, an unsafe
 * bind, a bad env value, or an ambiguous auth mode. Reported as a single fatal
 * log line rather than a stack trace, which tells an operator nothing useful.
 */
export class StartupError extends Error {
  override readonly name = 'StartupError';
}

/** One readable line per bad field, instead of a raw ZodError issue dump. */
function formatIssues(error: z.ZodError, env: NodeJS.ProcessEnv): string {
  const details = error.issues.map((issue) => {
    const field = issue.path.join('.') || '(root)';
    const raw = env[field];
    const got = raw === undefined ? 'unset' : JSON.stringify(raw);
    // Lowercased so the field name and zod's sentence read as one line.
    const reason = issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
    return `${field}: ${reason} (got ${got})`;
  });
  return `invalid configuration: ${details.join('; ')}`;
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) throw new StartupError(formatIssues(result.error, env));
  const parsed = result.data;
  const dataDir = parsed.DATA_DIR;

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    ui: {
      port: parsed.UI_PORT,
      host: blankToUndefined(parsed.UI_HOST) ?? parsed.HOST,
      allowWildcardBind: parsed.UI_ALLOW_WILDCARD_BIND,
    },
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    tz: parsed.TZ,
    dataDir,
    mcpBearerToken: blankToUndefined(parsed.MCP_BEARER_TOKEN),
    access: {
      teamDomain: blankToUndefined(parsed.ACCESS_TEAM_DOMAIN),
      aud: blankToUndefined(parsed.ACCESS_AUD),
      allowedEmails: parsed.ALLOWED_EMAILS,
      allowedServiceTokens: parsed.ALLOWED_SERVICE_TOKENS,
    },
    gradebook: {
      dbPath: join(dataDir, 'gradebook.sqlite'),
      parentvueHost: blankToUndefined(parsed.GRADEBOOK_PARENTVUE_HOST),
      parentvueUser: blankToUndefined(parsed.GRADEBOOK_PARENTVUE_USER),
      parentvuePass: parsed.GRADEBOOK_PARENTVUE_PASS || undefined,
      syncIntervalHours: parsed.GRADEBOOK_SYNC_INTERVAL_HOURS,
      syncEnabled: parsed.GRADEBOOK_SYNC_ENABLED,
      students: parsed.GRADEBOOK_STUDENTS,
    },
    devInsecureNoAuth: parsed.DEV_INSECURE_NO_AUTH,
  };
}

/**
 * True only when the auth bypass is actually safe to honor: never in
 * production, and only while bound to loopback so the escape hatch can't
 * leak onto the LAN or the public Internet.
 */
export function isDevInsecureNoAuthActive(config: Config): boolean {
  if (!config.devInsecureNoAuth) return false;
  if (config.nodeEnv === 'production') return false;
  return config.host === '127.0.0.1' || config.host === '::1';
}

export function isUiEnabled(
  config: Config,
): config is Config & { ui: { port: number; host: string; allowWildcardBind: boolean } } {
  return config.ui.port !== undefined;
}

export function isMcpEnabled(config: Config): config is Config & { port: number } {
  return config.port !== undefined;
}

/** Addresses that accept connections on every interface. */
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]', '::0', '*']);

/**
 * Reject configurations that cannot or should not run, before anything binds.
 *
 * The bind check is scoped to dashboard-only deployments on purpose. With MCP
 * off, the unauthenticated dashboard is the only thing listening, so a wildcard
 * bind in production puts every student's grades on every interface with
 * nothing in front of it. When MCP is enabled the operator has already had to
 * configure auth, and existing deployments that bind 0.0.0.0 behind their own
 * firewall keep working unchanged.
 *
 * A container legitimately binds 0.0.0.0 — Docker publishes to it, and Compose
 * confines the exposure to UI_BIND_ADDR on the host instead. The process cannot
 * tell that apart from a bare-metal wildcard bind, so UI_ALLOW_WILDCARD_BIND is
 * how the operator says the port is confined elsewhere. The image sets it.
 */
export function assertRunnable(config: Config): void {
  if (!isMcpEnabled(config) && !isUiEnabled(config)) {
    throw new StartupError(
      'no listener enabled: set PORT for the MCP endpoint, UI_PORT for the dashboard, or both',
    );
  }

  if (
    !isMcpEnabled(config) &&
    config.nodeEnv === 'production' &&
    !config.ui.allowWildcardBind &&
    WILDCARD_HOSTS.has(config.ui.host.trim())
  ) {
    throw new StartupError(
      `refusing to start: the dashboard is UNAUTHENTICATED and UI_HOST=${config.ui.host} would ` +
        "expose every student's grades on every interface. Bind UI_HOST to 127.0.0.1 or a " +
        'private/overlay address, or set UI_ALLOW_WILDCARD_BIND=true if something else ' +
        'confines the port (the Docker image sets it, because Compose publishes to ' +
        'UI_BIND_ADDR on the host instead).',
    );
  }
}
