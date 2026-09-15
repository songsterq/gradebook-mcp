import type { Logger } from 'pino';
import type { Identity } from './auth/identity.js';
import { describeIdentity } from './auth/identity.js';

/**
 * Wraps an MCP tool handler so every call is logged with who called it, what
 * tool, the arguments, how long it took, and whether it succeeded or threw.
 */
export function withAudit<Args, Result>(
  logger: Logger,
  identity: Identity,
  toolName: string,
  handler: (args: Args) => Promise<Result> | Result,
): (args: Args) => Promise<Result> {
  return async (args: Args): Promise<Result> => {
    const start = performance.now();
    const base = { identity: describeIdentity(identity), tool: toolName, args };
    try {
      const result = await handler(args);
      logger.info({ ...base, durationMs: Math.round(performance.now() - start), outcome: 'success' }, 'tool call');
      return result;
    } catch (err) {
      logger.warn(
        {
          ...base,
          durationMs: Math.round(performance.now() - start),
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
        'tool call failed',
      );
      throw err;
    }
  };
}
