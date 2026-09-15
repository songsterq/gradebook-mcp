import type { Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';

export function securityHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Security-Policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
      "img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    // Deliberately `same-origin`, not `no-referrer`: under `no-referrer` a browser
    // serializes the Origin of a *navigation* form POST as the literal string "null",
    // which `rejectCrossOrigin` below then cannot verify. That combination 403'd every
    // un-enhanced form in the dashboard. Nothing is sent cross-origin either way.
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}

/** A misconfiguration alarm, not a security control: these headers are spoofable. */
export function rejectTunnelHeaders(logger: Logger): RequestHandler {
  return (req, res, next) => {
    if (req.headers['cf-ray'] === undefined && req.headers['cf-connecting-ip'] === undefined) {
      next();
      return;
    }

    logger.error(
      { path: req.path },
      'dashboard request arrived via Cloudflare — a tunnel route is pointed at UI_PORT; remove it',
    );
    res.set('Cache-Control', 'no-store').status(403).type('text/plain').send('Forbidden');
  };
}

/** Methods that cannot mutate, so they skip the write checks below. A HEAD or
 *  OPTIONS carries no Content-Type and would otherwise be rejected outright. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Why a write was refused. Logged so a 403 is diagnosable from the server log
 *  alone — the response body stays a bare `Forbidden`. */
export type CrossOriginRejection =
  | 'fetch_site'
  | 'origin_mismatch'
  | 'origin_null_unverified'
  | 'origin_unparseable'
  | 'content_type';

export function rejectCrossOrigin(logger: Logger): RequestHandler {
  function refuse(req: Request, res: Response, reason: CrossOriginRejection): void {
    logger.warn(
      {
        reason,
        path: req.originalUrl,
        method: req.method,
        origin: req.headers.origin ?? null,
        host: req.headers.host ?? null,
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        contentType: req.headers['content-type'] ?? null,
      },
      'dashboard write refused by the cross-origin check',
    );
    res.status(403).type('text/plain').send('Forbidden');
  }

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      refuse(req, res, 'fetch_site');
      return;
    }

    const origin = req.headers.origin;
    if (origin !== undefined) {
      // An opaque origin. A same-origin form POST produces this whenever the page's
      // referrer policy suppresses the origin, so it is not on its own evidence of a
      // cross-site request. Sec-Fetch-Site is browser-set and page script cannot forge
      // it, so an explicit `same-origin` is sound grounds to accept. Without that
      // header there is nothing left to verify against, so refuse.
      if (origin === 'null') {
        if (fetchSite !== 'same-origin') {
          refuse(req, res, 'origin_null_unverified');
          return;
        }
      } else {
        try {
          if (new URL(origin).host !== req.headers.host) {
            refuse(req, res, 'origin_mismatch');
            return;
          }
        } catch {
          refuse(req, res, 'origin_unparseable');
          return;
        }
      }
    }

    if (!req.is('application/x-www-form-urlencoded')) {
      refuse(req, res, 'content_type');
      return;
    }

    next();
  };
}
