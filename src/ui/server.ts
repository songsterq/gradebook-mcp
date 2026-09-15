import { randomBytes } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type Response } from 'express';
import type { HomeModule, UiContext } from '../modules/types.js';
import { html } from './html.js';
import { renderDocument } from './layout.js';
import { rejectCrossOrigin, rejectTunnelHeaders, securityHeaders } from './security.js';

/** events.actor / items.created_by for every dashboard mutation. */
export const UI_ACTOR = 'local-ui';

function nonceFor(res: Response): string {
  return typeof res.locals.nonce === 'string' ? res.locals.nonce : '';
}

function sendNotFound(res: Response): void {
  const body = html`<main>
    <h1>Not found</h1>
    <p>The requested dashboard page does not exist.</p>
    <p><a href="/">Dashboard home</a></p>
  </main>`;
  res
    .status(404)
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(renderDocument({ title: 'Not found', nonce: nonceFor(res), body }));
}

export function createUiApp(ctx: UiContext, modules: readonly HomeModule[]): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const startedAt = Date.now();
    // `req.originalUrl`, not `req.path`: a Router strips its mount path from `req.url`
    // and restores it only when it calls `next()`, so a router that *handles* the
    // request leaves `req.path` reading as the sub-path by the time `finish` fires
    // (`GET /gradebook` logging as `GET /`). Captured here rather than in the callback
    // so the query string is dropped once, keeping the field low-cardinality.
    const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
    res.on('finish', () => {
      ctx.logger.info(
        {
          method: req.method,
          path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          ip: req.socket.remoteAddress,
        },
        'ui request',
      );
    });
    next();
  });

  app.use(rejectTunnelHeaders(ctx.logger));
  app.use((_req, res, next) => {
    const nonce = randomBytes(16).toString('base64url');
    res.locals.nonce = nonce;
    res.set(securityHeaders(nonce));
    next();
  });
  app.use(rejectCrossOrigin(ctx.logger));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  const uiModules = modules.filter((mod) => mod.createUiRouter);
  for (const mod of uiModules) {
    const router = mod.createUiRouter!(ctx);
    app.use(`/${mod.name}`, router);
  }

  app.get('/', (_req, res, next) => {
    const first = uiModules[0];
    if (!first) {
      next();
      return;
    }
    res.redirect(302, `/${encodeURIComponent(first.name)}`);
  });

  app.use((_req, res) => sendNotFound(res));

  const errorBackstop: ErrorRequestHandler = (err, _req, res, next) => {
    ctx.logger.error({ err }, 'uncaught dashboard error');
    if (res.headersSent) {
      next(err);
      return;
    }

    const body = html`<main>
      <h1>Something went wrong</h1>
      <p>The dashboard could not complete that request.</p>
      <p><a href="/">Dashboard home</a></p>
    </main>`;
    res
      .status(500)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(renderDocument({ title: 'Error', nonce: nonceFor(res), body }));
  };
  app.use(errorBackstop);

  return app;
}
