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
  PORT: z.coerce.number().int().positive().default(3000),
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

  DEV_INSECURE_NO_AUTH: boolFromString(),
});

export type Config = {
  port: number;
  host: string;
  ui: {
    port: number | undefined;
    host: string;
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

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const dataDir = parsed.DATA_DIR;

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    ui: {
      port: parsed.UI_PORT,
      host: parsed.UI_HOST ?? parsed.HOST,
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
): config is Config & { ui: { port: number; host: string } } {
  return config.ui.port !== undefined;
}
