import { readFileSync } from 'node:fs';
import express, { type Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Identity } from './auth/identity.js';
import { createAuthMiddleware } from './auth/middleware.js';
import type { HomeModule } from './modules/types.js';

const SERVER_NAME = 'gradebook-mcp';
// Read from package.json, the version a release tag is checked against, so the
// version MCP clients see always matches the published image. The file sits one
// level above both src/ (dev) and dist/ (the image copies it to /app).
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: '2.0' as const,
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
};

export function createApp(config: Config, logger: Logger, modules: readonly HomeModule[]): Express {
  const authMiddleware = createAuthMiddleware(config, logger);
  const instructions = modules
    .map((mod) => mod.instructions?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/mcp', authMiddleware, async (req, res) => {
    const identity = req.identity as Identity;
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: instructions || undefined },
    );

    for (const mod of modules) {
      mod.register(server, { config, logger, identity });
    }

    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, 'error handling MCP request');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json(METHOD_NOT_ALLOWED_BODY);
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).json(METHOD_NOT_ALLOWED_BODY);
  });

  return app;
}
