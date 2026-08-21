// shared/rate-limit.js
// -----------------------------------------------------------------------------
// Per-route, per-key in-memory rate limiter (audit fix H-07).
//
// PURPOSE
//   Move from one global-per-IP bucket to per-route budgets with per-route
//   key types. Each factory call creates a middleware with its own bucket
//   Map — routes don't share counters. Callers pick the key extractor
//   (IP, orderId, phone, global) per route.
//
// PATTERN
//   const limiter = makeKeyedRateLimiter({
//     routeName: '/api/checkout/process-prepaid[ip]',
//     maxRequests: 5,
//     windowMs: 60_000,
//     keyExtractor: keyByIp,
//   });
//   router.post('/process-prepaid', limiter, handler);
//
//   Stack multiple middlewares to enforce multiple budgets per route:
//   router.post('/x', ipLimiter, orderIdLimiter, handler);
//
// STORAGE
//   In-memory Map per limiter. Fine for single-PM2-worker (current setup).
//   For multi-worker or horizontal scaling, migrate to rate-limit-redis
//   (drop-in replacement with the same key extractor pattern).
//
// LOGGING / PII
//   The raw key (which may be a phone number or orderId) is never logged.
//   We log a SHA-256 prefix instead — enough to correlate multiple 429s
//   from the same key without leaking the key itself.
//
// SHUTDOWN
//   Each limiter's cleanup interval is .unref()'d so it doesn't block
//   graceful shutdown (H-05).
// -----------------------------------------------------------------------------

import crypto from 'crypto';

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 min

/**
 * Hash a rate-limit key for logging. 8 hex chars of SHA-256 — greppable,
 * non-reversible. Prevents PII (phone) and secret-shaped values (orderId,
 * tokens) from leaking to log files.
 */
function keyHash(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8);
}

/**
 * Build a per-route rate-limiting middleware.
 *
 * @param {object} opts
 * @param {string}   opts.routeName          Log tag. Include the key type,
 *                                           e.g. '/api/razorpay/create-order[ip]'.
 * @param {number}   opts.maxRequests        Max requests per window.
 * @param {number}   opts.windowMs           Window size in ms.
 * @param {function} opts.keyExtractor       (req) => string | null. If it
 *                                           returns null and skipOnMissingKey
 *                                           is true, the limiter is bypassed
 *                                           for that request.
 * @param {boolean}  [opts.skipOnMissingKey] Default true. Set false to reject
 *                                           requests with no extractable key
 *                                           (rare; usually only for global keys).
 *
 * @returns {(req, res, next) => void}
 */
export function makeKeyedRateLimiter({
  routeName,
  maxRequests,
  windowMs,
  keyExtractor,
  skipOnMissingKey = true,
}) {
  if (!routeName) throw new Error('makeKeyedRateLimiter: routeName required');
  if (!Number.isFinite(maxRequests) || maxRequests < 1) {
    throw new Error(`makeKeyedRateLimiter: invalid maxRequests for ${routeName}`);
  }
  if (!Number.isFinite(windowMs) || windowMs < 100) {
    throw new Error(`makeKeyedRateLimiter: invalid windowMs for ${routeName}`);
  }
  if (typeof keyExtractor !== 'function') {
    throw new Error(`makeKeyedRateLimiter: keyExtractor must be a function for ${routeName}`);
  }

  const buckets = new Map(); // key -> { count, resetAt }

  // Sweep expired buckets so unique-key growth (e.g. attacker rotating IPs)
  // doesn't leak memory. .unref() so graceful shutdown (H-05) can exit.
  const cleanup = setInterval(() => {
    const now = Date.now();
    const staleAfter = now - 60_000; // 1 min grace past the window
    for (const [key, record] of buckets.entries()) {
      if (record.resetAt < staleAfter) buckets.delete(key);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref();

  return function keyedRateLimit(req, res, next) {
    let key;
    try {
      key = keyExtractor(req);
    } catch (err) {
      // keyExtractor threw (e.g., malformed req.body). Fail open on the
      // limiter — the handler will reject the malformed request downstream.
      console.warn(`[${routeName}] keyExtractor threw (${err.message}); skipping limit for this request`);
      return next();
    }

    if (!key) {
      if (skipOnMissingKey) return next();
      console.warn(`[${routeName}] missing rate-limit key on request; rejecting`);
      return res.status(400).json({
        success: false,
        message: `Missing required key for ${routeName}`,
      });
    }

    const now = Date.now();
    let record = buckets.get(key);
    if (!record || now > record.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count += 1;
    if (record.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      console.warn(
        `⚠️ [${routeName}] rate limit exceeded (count=${record.count}/${maxRequests} key_hash=${keyHash(key)})`
      );
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: 'Too many requests',
        retry_after_seconds: retryAfter,
      });
    }
    return next();
  };
}

// ============================================================================
// CONVENIENCE KEY EXTRACTORS
// ============================================================================

/** Client IP. Requires `app.set('trust proxy', N)` when behind nginx. */
export function keyByIp(req) {
  return req.ip || req.connection?.remoteAddress || null;
}

/** A single global bucket (route-wide limit across all callers). */
export function keyGlobal() {
  return '__global__';
}

/**
 * A top-level field on req.body. Example: keyByBodyField('orderId') for
 * /api/razorpay/create-order which receives { orderId, ... }.
 */
export function keyByBodyField(field) {
  return (req) => {
    const v = req.body?.[field];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
}

/**
 * A nested field on req.body. Example: keyByBodyPath(['orderData', 'orderId'])
 * for /api/checkout/process-prepaid which receives { orderData: { orderId, ... } }.
 */
export function keyByBodyPath(path) {
  return (req) => {
    let node = req.body;
    for (const segment of path) {
      if (node == null || typeof node !== 'object') return null;
      node = node[segment];
    }
    return typeof node === 'string' && node.length > 0 ? node : null;
  };
}

/**
 * The 'from' phone number in a Meta WhatsApp webhook payload. Digs into
 * req.body.entry[0].changes[0].value.messages[0].from. Returns null for
 * status/system events that carry no message.
 */
export function keyByWhatsappFrom(req) {
  const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
  return typeof from === 'string' && from.length > 0 ? from : null;
}
