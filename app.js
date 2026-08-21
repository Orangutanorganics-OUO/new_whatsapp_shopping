// server-whatsapp-payments.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
// ShortUniqueId import removed — the last caller (bot orderId generator)
// now uses crypto.randomBytes for cryptographic entropy (audit fix C-06).
// The `short-unique-id` npm package can be uninstalled — see deployment notes.
import cors from 'cors';
import http from 'http';
import https from 'https';

import helmet from 'helmet';
import morgan from 'morgan';
import bodyParser from 'body-parser';

import delhiveryRoutes from './website/delhivery.js';
import razorpayRoutes from './website/razorpay.js';
import checkoutRoutes from './website/checkout.js';
import configRoutes from './website/config.js';

// Firebase Realtime Database
import {
  isMessageProcessed,
  markMessageAsProcessed,
  isPaymentProcessed,
  markPaymentAsProcessed,
  acquireOrderLock,
  saveOrderSession,
  getOrderSession,
  cleanupOldData,
  isDelhiveryEventProcessed,
  markDelhiveryEventProcessed,
  hasDelhiveryUpdateBeenSent,
  markDelhiveryUpdateSent,
  // State-machine helpers used by the bot's finalizePaidOrder (audit fix H-02).
  // Same helpers the website flow uses in checkout.js's fulfillOrder — one
  // source of truth for fulfillment state across both domains.
  createPendingOrder,
  getPendingOrder,
  updatePendingOrder,
  tryStartFulfillment,
  // User-state helpers replacing the in-memory remindedUsers/completedUsers
  // Sets (audit fix H-08, option A).
  isUserCompleted,
  isRemindedButNotCompleted,
  markReminded,
  markUserCompleted,
  // Coupon usage audit trail + per-user-limit substrate (audit fix M-15).
  recordCouponUsage,
  getCouponUsageCount,
  logCustomerInteraction,
} from './shared/firebase.js';

// Coupon config + validation + COD charge (audit fix M-15).
// COUPONS is defined ONCE in shared/catalog.js; validateCouponForUser layers
// on the Firebase per-user-limit check. COD_CHARGE_PAISE is env-overridable.
// Bulk-discount + free-shipping primitives (audit fix M-17) live in the same
// module so bot and website flows share one source of truth.
// stampGstRate (audit fix M-16) augments Apps-Script payloads with per-line
// GST rate so the invoice renderer can compute net/tax explicitly.
import {
  validateCouponForUser as catalogValidateCouponForUser,
  COD_CHARGE_PAISE,
  BULK_DISCOUNT_THRESHOLD_G,
  BULK_DISCOUNT_RATE,
  FREE_SHIPPING_THRESHOLD_PAISE,
  computeBulkDiscount,
  shouldWaiveShipping,
  stampGstRate,
} from './shared/catalog.js';

// Delhivery response envelope validator — extracted from website/checkout.js
// so the bot's finalizePaidOrder can reuse the same success/duplicate/fail
// classification logic. Audit fix H-02.
import { validateDelhiveryResponse } from './website/checkout.js';

// Per-route rate limiting (audit fix H-07). Factory + key extractors.
import {
  makeKeyedRateLimiter,
  keyByIp,
  keyGlobal,
  keyByWhatsappFrom,
} from './shared/rate-limit.js';

// Canonical JSON response envelope (audit fix M-14). Used by the 404 + global
// error handlers; per-route migration deferred pending frontend coordination.
import { respondError } from './shared/response.js';

// ============================================
// PROCESS LIFECYCLE (audit fixes H-05 + H-06)
// ============================================
// Two distinct exit paths:
//
// GRACEFUL SHUTDOWN (SIGTERM / SIGINT) — H-05
//   Operator restart (pm2 restart, kubectl delete, systemd stop) or dev
//   Ctrl-C. Server state is HEALTHY; we stop accepting new connections and
//   wait up to 15s for in-flight requests to finish, then exit(0).
//
// CRASH EXIT (uncaughtException / unhandledRejection) — H-06
//   Something threw or a promise rejected without a catch handler. JS state
//   is now UNDEFINED per Node docs; continuing to serve requests is unsafe.
//   Log + politely close the listener + hard-exit(1) within 1s so PM2
//   restarts a fresh process. We deliberately do NOT drain — waiting 15s
//   on corrupt state can deadlock or serve corrupted responses.
//
// Externally required: PM2 kill_timeout must be raised to >= 20000 (default
// 1600 is too short for the drain), and min_uptime/max_restarts should be
// configured so crash-loops don't burn CPU silently. See deployment notes.
let httpServer = null;
let shuttingDown = false;
let crashExitScheduled = false;

function drainAndExit(signal) {
  if (shuttingDown) {
    // Second signal during drain → operator wants out NOW.
    console.log(`[shutdown] second ${signal} received during drain — forcing immediate exit`);
    process.exit(1);
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining connections (max 15s)`);

  // Hard-kill safety net. If server.close hangs (long-running request,
  // stuck keep-alive), we must not block PM2 forever.
  const forceExitTimer = setTimeout(() => {
    console.error('[shutdown] drain timeout after 15s — forcing exit');
    process.exit(1);
  }, 15_000);
  forceExitTimer.unref();

  if (!httpServer) {
    // Signal arrived before app.listen() bound. Nothing to drain.
    console.warn('[shutdown] no HTTP server bound — exiting immediately');
    clearTimeout(forceExitTimer);
    process.exit(0);
    return;
  }

  // Close idle keep-alive sockets so they don't hold the drain open until
  // their keep-alive timeout fires. Available since Node 18.2 — guard with
  // typeof for older runtimes.
  if (typeof httpServer.closeIdleConnections === 'function') {
    try { httpServer.closeIdleConnections(); }
    catch (err) { console.warn(`[shutdown] closeIdleConnections error: ${err.message || err}`); }
  }

  // Stop accepting new connections. Callback fires when every active request
  // has responded and every socket is closed.
  httpServer.close((err) => {
    if (err) {
      console.error(`[shutdown] server.close error: ${err.message || err}`);
      clearTimeout(forceExitTimer);
      process.exit(1);
      return;
    }
    console.log('[shutdown] all connections drained — exiting cleanly');
    clearTimeout(forceExitTimer);
    // Small tick so any pending console.log / Firebase ack has time to flush.
    setTimeout(() => process.exit(0), 200).unref();
  });
}

// Crash-exit — called for uncaughtException + unhandledRejection.
// Fast, log-and-die. Do NOT invoke drainAndExit() here: drain waits for
// handlers to finish, but the state that just crashed may be inside a
// handler; letting it "finish" is unsafe.
function scheduleCrashExit(reason, err) {
  if (crashExitScheduled) {
    // Second crash event during our own exit path (or logger recursion).
    // Skip further logging — the logger itself may be what just failed —
    // and hard-exit. PM2 will restart per ecosystem config.
    process.exit(1);
    return;
  }
  crashExitScheduled = true;

  console.error(`❌ CRASH: ${reason} — JS state is now undefined. Exiting for PM2 restart.`);
  console.error(`❌ CRASH: name=${err?.name || 'unknown'} message=${err?.message || String(err)}`);
  if (err?.stack) console.error(`❌ CRASH: stack:\n${err.stack}`);

  // Politely stop accepting new connections. Best-effort: don't await, don't
  // depend on the callback (server state may be corrupt).
  if (httpServer) {
    try { httpServer.close(); } catch { /* swallow — process is dying anyway */ }
    if (typeof httpServer.closeIdleConnections === 'function') {
      try { httpServer.closeIdleConnections(); } catch { /* swallow */ }
    }
  }

  // 1s log-flush window, then hard exit. .unref() so this timer itself
  // doesn't extend the event loop if it drains naturally.
  setTimeout(() => {
    console.error('❌ CRASH: exiting now (code 1) — PM2 should restart');
    process.exit(1);
  }, 1_000).unref();
}

process.on('SIGTERM', () => drainAndExit('SIGTERM'));
process.on('SIGINT',  () => drainAndExit('SIGINT'));
process.on('uncaughtException',  (err) => scheduleCrashExit('uncaughtException', err));
process.on('unhandledRejection', (reason) => {
  // Rejections carry arbitrary values (string, Error, object). Normalize to
  // Error so downstream logging (err.name/.message/.stack) works uniformly.
  const err = reason instanceof Error
    ? reason
    : new Error(`Non-Error rejection: ${String(reason)}`);
  scheduleCrashExit('unhandledRejection', err);
});

const app = express();

// Trust one proxy hop (nginx on same host). Without this, req.ip returns
// nginx's private IP for every request, collapsing all per-IP rate limits
// into a single global bucket. Required for H-07 per-route limits to work.
// Bump to 2 if a CDN (CloudFront, Cloudflare) is added in front of nginx.
app.set('trust proxy', 1);

// ============================================
// OUTBOUND HTTP DEFAULTS (audit fix H-12)
// ============================================
// Axios ships with NO default timeout. Any axios call that forgets to pass
// `timeout: N` will block indefinitely if the remote peer TCP-accepts but
// never responds — accumulating hung handlers wedges the event loop under
// a partial upstream outage (Meta Graph, Razorpay, Delhivery, Sheets).
//
// Mutating the shared instance's default applies to every axios call in the
// process (Node's module cache means app.js / website/* / shared/* all share
// the same axios singleton). Per-call `timeout:` options still override this
// default — Sheets keeps its 30s, Delhivery keeps its 15-20s, etc.
//
// 10s ceiling matches the audit recommendation and the one Meta Graph call
// that already sets timeout:10000 explicitly. Meta Graph typically responds
// in <500ms; 10s is a generous upper bound for a "still alive" response.
axios.defaults.timeout = 10_000;

// Keep-alive connection pooling (audit fix M-19). Node's default agents open
// a fresh TCP + TLS handshake for every request — under bot traffic (~19 Meta
// Graph calls per checkout) that's 3-6s of avoidable handshake latency and
// 19 disposable file descriptors per order. keepAlive:true lets axios reuse
// warm sockets to the same host, dropping the second+ request to the same
// upstream to zero handshake cost. maxSockets caps concurrent per-host
// sockets so a runaway loop can't exhaust FDs; maxFreeSockets bounds the
// idle pool. Applied to axios's shared instance (same singleton every
// project file imports) — zero call-site changes.
const KEEPALIVE_AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 15_000,      // send keep-alive probes every 15s
  maxSockets: 50,              // per-host concurrent-request ceiling
  maxFreeSockets: 10,          // per-host idle-pool size
  timeout: 60_000,             // socket-idle timeout (server-side FIN would arrive earlier)
};
axios.defaults.httpAgent = new http.Agent(KEEPALIVE_AGENT_OPTS);
axios.defaults.httpsAgent = new https.Agent(KEEPALIVE_AGENT_OPTS);

// ============================================
// META GRAPH 429 RETRY (audit fix M-07)
// ============================================
// Meta returns 429 with a Retry-After header when we exceed messaging quotas.
// Previously every catch block just logged and moved on — the message was
// silently dropped. Install a URL-scoped response interceptor that:
//   1) Only fires for graph.facebook.com URLs (Razorpay/Delhivery/Sheets
//      keep their own error semantics — this interceptor is a no-op for
//      those responses).
//   2) Honors the Retry-After header (numeric seconds; Meta's format) if
//      present, else exponential backoff (2^attempt seconds), capped at 30s.
//   3) Caps at 2 retries (3 attempts total). Beyond that, the original
//      error propagates to the existing catch blocks unchanged.
// State (retry counter) is attached to the axios `config` object per request
// so parallel calls don't interfere.
const META_GRAPH_URL_PREFIX = 'https://graph.facebook.com/';
const META_MAX_RETRIES = 2;
const META_MAX_BACKOFF_MS = 30_000;

axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config || {};
    const status = error.response?.status;
    const url = typeof config.url === 'string' ? config.url : '';

    if (status !== 429 || !url.startsWith(META_GRAPH_URL_PREFIX)) {
      throw error;
    }

    const attempt = (config.__metaRetries || 0) + 1;
    if (attempt > META_MAX_RETRIES) {
      console.warn(`⚠️ Meta 429 — retry budget exhausted (${META_MAX_RETRIES} retries) url=${url}`);
      throw error;
    }
    config.__metaRetries = attempt;

    const retryAfterHeader = error.response?.headers?.['retry-after'];
    const retryAfterSecs = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
    const delayMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
      ? Math.min(META_MAX_BACKOFF_MS, retryAfterSecs * 1_000)
      : Math.min(META_MAX_BACKOFF_MS, 2 ** attempt * 1_000);

    console.warn(`⚠️ Meta 429 — retrying in ${delayMs}ms (attempt ${attempt}/${META_MAX_RETRIES}) url=${url}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return axios(config);
  }
);

// ============================================
// RATE LIMITING (In-Memory)
// ============================================
const requestCounts = new Map(); // IP => { count, resetTime }

// Simple rate limiter middleware
const rateLimiter = (maxRequests = 100, windowMs = 60000) => {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    // Get or create request record for this IP
    let record = requestCounts.get(ip);

    if (!record || now > record.resetTime) {
      // New window or expired window - reset
      record = {
        count: 1,
        resetTime: now + windowMs
      };
      requestCounts.set(ip, record);
      return next();
    }

    // Increment count
    record.count++;

    if (record.count > maxRequests) {
      console.warn(`⚠️ Rate limit exceeded for IP: ${ip} (${record.count} requests)`);
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((record.resetTime - now) / 1000) + ' seconds'
      });
    }

    next();
  };
};

// Cleanup old rate limit records every 10 minutes.
// .unref() so this interval doesn't hold the event loop open during shutdown
// (audit fix H-05). The HTTP server keeps the loop alive while running; once
// server.close() completes, this timer no longer blocks process exit.
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [ip, record] of requestCounts.entries()) {
    if (now > record.resetTime + 60000) { // Cleanup records 1 minute after expiry
      requestCounts.delete(ip);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired rate limit records`);
  }
}, 10 * 60 * 1000);
rateLimitCleanupTimer.unref();

// ============================================
// GLOBAL RATE LIMITER (per-route bucket, not per-IP)
// ============================================
// The rateLimiter above caps any SINGLE IP at N requests per window. That's
// the right defense against one noisy client. It does NOT protect against a
// distributed flood aimed at a specific endpoint (e.g. an unsigned-webhook
// flood coming from many source IPs at once).
//
// This factory returns a middleware that maintains a single, shared bucket
// for the named route. Applied per-route (as the second arg to app.post/get),
// it enforces a hard ceiling across ALL sources combined. Cheap: one counter,
// no per-IP map.
function makeGlobalRateLimiter(routeName, maxRequests, windowMs) {
  let bucket = { count: 0, resetAt: Date.now() + windowMs };
  return (req, res, next) => {
    const now = Date.now();
    if (now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      console.warn(`⚠️ [${routeName}] global rate limit exceeded (${bucket.count}/${maxRequests} in ${windowMs}ms). ip=${req.ip || 'unknown'}`);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, message: 'Too many requests', retry_after_seconds: retryAfter });
    }
    return next();
  };
}

// ---- Per-route limiters (audit fix H-07). Numbers per audit table. ----
// makeGlobalRateLimiter is superseded by shared/rate-limit.js's keyGlobal;
// its call sites now flow through the unified factory.

// Webhooks — global buckets. Razorpay/Delhivery IPs are diverse, so per-IP
// wouldn't help; a shared global ceiling is what stops distributed abuse.
const paymentsWebhookRateLimiter = makeKeyedRateLimiter({
  routeName: '/payments-webhook[global]',   maxRequests: 100, windowMs: 60_000,
  keyExtractor: keyGlobal,
});
const delhiveryWebhookRateLimiter = makeKeyedRateLimiter({
  routeName: '/delhivery-webhook[global]',  maxRequests: 100, windowMs: 60_000,
  keyExtractor: keyGlobal,
});

// WhatsApp inbound webhook — per-IP (Meta's servers) plus per-source-phone
// so a single abusive customer can't flood the bot even if Meta forwards.
const whatsappWebhookIpLimiter = makeKeyedRateLimiter({
  routeName: 'POST /[ip]',   maxRequests: 100, windowMs: 60_000,
  keyExtractor: keyByIp,
});
const whatsappWebhookPhoneLimiter = makeKeyedRateLimiter({
  routeName: 'POST /[from]', maxRequests: 20,  windowMs: 60_000,
  keyExtractor: keyByWhatsappFrom,
  // Status / read-receipt events carry no from-phone; skip them (the IP
  // limiter still applies).
  skipOnMissingKey: true,
});

// Meta webhook verification (GET /) — low-traffic, per-IP.
const whatsappVerifyIpLimiter = makeKeyedRateLimiter({
  routeName: 'GET /[ip]',    maxRequests: 60,  windowMs: 60_000,
  keyExtractor: keyByIp,
});

// Health probe — high ceiling to accommodate ELB + CloudWatch + external monitors.
const healthProbeIpLimiter = makeKeyedRateLimiter({
  routeName: 'GET /health[ip]', maxRequests: 600, windowMs: 60_000,
  keyExtractor: keyByIp,
});

// ============================================
// MIDDLEWARE CONFIGURATION
// ============================================

// JSON parser + raw-body capture. The `verify` callback stores the raw bytes
// on req.rawBody so downstream webhook handlers (Meta X-Hub-Signature-256,
// Razorpay X-Razorpay-Signature) can compute HMACs against the exact bytes
// Meta / Razorpay signed — parsing then re-stringifying JSON would produce
// a different byte sequence and break signature verification.
//
// Explicit `limit: '100kb'` documents the intent (audit fix M-06): every
// legitimate webhook and API payload we accept fits comfortably in 100 KB.
// Requests above the limit get a 413 from Express before reaching handlers,
// bounding memory per request. The single duplicate bodyParser.json() call
// that used to follow was a no-op (req.body already populated) and has been
// removed.
app.use(express.json({
  limit: '100kb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(morgan('combined')); // Logging
// bodyParser.json() removed here (audit fix M-06) — the express.json() call
// above already parses JSON bodies AND captures req.rawBody for signature
// verification. Running a second JSON parser was a no-op that could mislead
// a future reader into thinking limits or verify hooks are configured here.
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================
// CORS (audit fix H-10)
// ============================================
// Prior behavior: no-Origin requests were unconditionally allowed with
// credentials:true. That made CORS useless against server-side callers
// (curl/Postman/attacker-controlled backends) and, worse, still advertised
// Access-Control-Allow-Credentials on origin-less browser edge cases.
//
// New posture:
//   * Origin present + in allowlist   → allow, credentials:true (unchanged)
//   * Origin present + not allowlisted → reject 403 (unchanged status, cleaner code)
//   * Origin absent + safe method     → allow (health probes, GET webhook verify)
//   * Origin absent + webhook path    → allow (server-to-server; auth via HMAC)
//   * Origin absent + mutating route  → REJECT 403 (this is the fix)
//
// CORS is defense-in-depth here — every mutating webhook (Meta, Razorpay)
// enforces its own signature check; this middleware just closes the
// "credentials:true + no Origin + mutating route" hole cleanly.
const allowedOrigins = new Set([
  'https://orangutanorganics.com',
  'https://www.orangutanorganics.com',
  // 'https://abd2-2401-4900-cce4-b56-d959-7100-dd1d-77f2.ngrok-free.app',
  'http://localhost:3000',
  'http://localhost:3001',
]);

// Paths that legitimately receive no-Origin requests. Keep this list
// minimal and explicit — every entry is a server-to-server webhook (or
// its verification GET). If a webhook mount point moves, update this set.
const NO_ORIGIN_ALLOWED_PATHS = new Set([
  '/',                        // GET (Meta WhatsApp verify) + POST (Meta inbound)
  '/payments-webhook',        // Legacy Razorpay webhook
  '/delhivery-webhook',       // Delhivery shipment updates
  '/api/razorpay/webhook',    // Razorpay webhook (current path)
]);

const CORS_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function corsRejection(reason) {
  const err = new Error(`Not allowed by CORS: ${reason}`);
  err.status = 403;
  return err;
}

function corsOptionsDelegate(req, callback) {
  const origin = req.header('Origin');

  // Browser sent Origin → allowlist check.
  if (origin) {
    if (allowedOrigins.has(origin)) {
      return callback(null, {
        origin: true,
        credentials: true,
        optionsSuccessStatus: 200,
      });
    }
    console.warn(`⚠️ CORS blocked disallowed origin=${origin} ${req.method} ${req.path}`);
    return callback(corsRejection('origin not in allowlist'));
  }

  // No Origin. Allow read-only methods and explicit webhook paths only.
  if (CORS_SAFE_METHODS.has(req.method) || NO_ORIGIN_ALLOWED_PATHS.has(req.path)) {
    return callback(null, {
      origin: true,
      // No browser context → don't advertise credentials. Also avoids the
      // ACAO:* + credentials spec violation the cors package would flag.
      credentials: false,
      optionsSuccessStatus: 200,
    });
  }

  console.warn(`⚠️ CORS blocked no-origin ${req.method} ${req.path}`);
  return callback(corsRejection('Origin header required for mutating requests'));
}

app.use(cors(corsOptionsDelegate));

// Apply rate limiting to all routes (100 requests per minute per IP)
app.use(rateLimiter(100, 60000));


// Minimal health probe (audit fix M-18). Previously leaked NODE_ENV (minor
// reconnaissance value — an attacker could distinguish prod/staging/dev and
// target accordingly) along with a bot-identifying message string. Returns
// only the fields ELB / CloudWatch / external monitors actually parse.
app.get('/health', healthProbeIpLimiter, (req, res) => {
  res.json({ status: 'ok' });
});

// API Routes
app.use('/api/delhivery', delhiveryRoutes);
app.use('/api/razorpay', razorpayRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/config', configRoutes);




// --- ENV ---
const {
  PORT = 3000,
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  PAYMENT_CONFIGURATION_NAME, // NEW - set this to the "name" you created in Meta (e.g. upi_test)
  FLOW_ID,
  DELHIVERY_TOKEN,
  DELHIVERY_ORIGIN_PIN = '110042',
  DELHIVERY_CHARGES_URL = 'https://track.delhivery.com/api/kinko/v1/invoice/charges/.json',
  DELHIVERY_CREATE_URL = 'https://track.delhivery.com/api/cmu/create.json',

  // Google Apps Script integration (audit fix H-11). The URL is deploy-specific
  // and MUST NOT be committed — set it in the environment. The shared secret is
  // stamped on every payload and verified by the Apps Script's doPost before any
  // side-effect (row write / email). See app-script.js and .env.example.
  APP_SCRIPT_URL,
  APP_SCRIPT_SHARED_SECRET,
} = process.env;
const phoneNumberId = process.env.PHONE_NUMBER_ID;

// ============================================
// ENVIRONMENT VARIABLE VALIDATION
// ============================================
const requiredEnvVars = ['VERIFY_TOKEN', 'ACCESS_TOKEN', 'PHONE_NUMBER_ID', 'FLOW_ID', 'DELHIVERY_TOKEN'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ CRITICAL: Missing required environment variables:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('⚠️  Server will continue but some features may not work!');
}

// ============================================
// WEBHOOK SIGNATURE ENFORCEMENT (fail-closed)
// ============================================
// APP_SECRET is required to verify Meta's X-Hub-Signature-256 header on the
// incoming WhatsApp webhook. Missing secret = we cannot prove the caller is
// Meta, so we refuse to serve traffic.
//
// The only supported escape hatch is WHATSAPP_WEBHOOK_INSECURE=true, which
// exists solely for local development against synthetic payloads. It must
// NEVER be set in any environment that receives real Meta traffic. Every
// request processed under this flag is logged with an [INSECURE_MODE] tag.
const WHATSAPP_WEBHOOK_INSECURE = process.env.WHATSAPP_WEBHOOK_INSECURE === 'true';

if (!process.env.APP_SECRET) {
  if (WHATSAPP_WEBHOOK_INSECURE) {
    console.error('🚨 [webhook] APP_SECRET is NOT set and WHATSAPP_WEBHOOK_INSECURE=true.');
    console.error('🚨 [webhook] WhatsApp webhook signatures will NOT be verified.');
    console.error('🚨 [webhook] This must never be used in production. If you see this in prod, halt the deploy.');
  } else {
    console.error('❌ FATAL: APP_SECRET is not configured.');
    console.error('❌ FATAL: The WhatsApp webhook cannot verify that requests come from Meta without APP_SECRET.');
    console.error('❌ FATAL: Set APP_SECRET in the environment, or (dev only) set WHATSAPP_WEBHOOK_INSECURE=true to acknowledge running unverified.');
    process.exit(1);
  }
}

// ============================================
// RAZORPAY WEBHOOK SECRET (fail-closed on request, warn at boot)
// ============================================
// Used to verify X-Razorpay-Signature on BOTH /payments-webhook (this file)
// and /api/razorpay/webhook (website/razorpay.js). Without it, either endpoint
// returns 503 to every request — the process still boots so /health and other
// unrelated routes keep working, but no payment webhook is processed until the
// operator sets the secret. This is intentionally softer than the APP_SECRET
// exit-on-boot check: RAZORPAY_WEBHOOK_SECRET was introduced later, and a
// pre-existing deploy may not yet have it set. Loud log at boot ensures nobody
// misses it during rollout.
if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
  console.error('❌ CRITICAL: RAZORPAY_WEBHOOK_SECRET is not configured.');
  console.error('❌ CRITICAL: /payments-webhook and /api/razorpay/webhook will REJECT every request (503) until it is set.');
  console.error('❌ CRITICAL: Configure the secret in the Razorpay dashboard AND in the server .env, then restart.');
}

// ============================================
// APPS SCRIPT SHARED SECRET (audit fix H-11)
// ============================================
// Stamped on every /exec payload so the Apps Script doPost can distinguish
// legitimate backend calls from anyone who scraped the URL. Non-fatal at
// boot — a redeploy of the Apps Script is required before this becomes
// enforceable, and the rollout order is:
//   1. Set APP_SCRIPT_SHARED_SECRET here; restart backend. Payloads now
//      carry the secret; old script ignores the extra field.
//   2. Set matching Script Property in Apps Script; redeploy.
//   3. Rotate/revoke the previous Apps Script deployment (its URL was
//      committed and is considered compromised).
// If either APP_SCRIPT_URL or APP_SCRIPT_SHARED_SECRET is missing, order
// submission to Sheets is skipped by sendOrderToAppScript with a warning —
// order processing itself is unaffected.
if (!process.env.APP_SCRIPT_URL) {
  console.error('❌ CRITICAL: APP_SCRIPT_URL is not configured. Bot-flow orders will NOT be forwarded to Google Sheets.');
}
if (!process.env.APP_SCRIPT_SHARED_SECRET) {
  console.error('❌ CRITICAL: APP_SCRIPT_SHARED_SECRET is not configured.');
  console.error('❌ CRITICAL: Requests to the Apps Script will be sent WITHOUT the shared secret; once the Apps Script is redeployed with H-11 enforcement, every submission will be rejected as unauthorized.');
}


let intentBasedQA = new Map(); // Store Q&A with intents separately

function parseIntentBasedQA() {
  intentBasedQA.clear();

  intentBasedQA.set('buy now', {
    answer: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347`,
    intents: ['View Products', "Customer Reviews"]
  });
}

// Initialize intent-based Q&A
parseIntentBasedQA();

async function sendWhyPeopleLoveUs(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We're glad you're curious!💚
Here’s why our community loves Orang Utan Organics 👇
\nPick what you’d like to explore:`
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "nutrition_info",
                  title: "Nutrition info"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "farmer_impact",
                  title: "Farmer Impact"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "main_menu",
                  title: "Main Menu"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendwherewe(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We’re rooted in Village Bhangeli, 2300m above sea level, in the Gangotri Valley 🏞\n🌱 Certified Organic Base\n📍 46 km from Uttarkashi, Uttarakhand\n💚 Home to just 40 small landholder families we support\n\nWould you like to see what life looks like up here?\nView Gallery: https://www.instagram.com/orangutan.organics/`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_101",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_101",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendmatters(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We protect:\n• Native seeds & biodiversity\n• Water sources & soil health\n• Farmer dignity & livelihoods\nBuying from us = standing up for the planet & Himalayan farmers. Learn about our latest impact project? See Report: https://orangutanorganics.com/why-it-matters`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_102",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_102",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendhowitworks(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We are tracing our products from our Himalayan farm to your plate with just a QR code, launching soon. We’ll notify you when it’s live!`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_103",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_103",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendtraceprod(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Every product is traceable🔁 From seed-to-shelf, you’ll know:\n• The exact farm\n• The harvest date\n• The batch testing results\nWant to trace your future order?\nSee how it works: https://orangutanorganics.com/who-are-we/traceability`,
          },
          action: {
            buttons: [
              
              {
                type: "reply",
                reply: {
                  id: "works_101",
                  title: "How It Works"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "prod_102",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_102",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendshopandexplore(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347 \n\nWe are also available on Amazon.`,
          },
          action: {
            buttons: [
              
              {
                type: "reply",
                reply: {
                  id: "prod_1001",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "review_1001",
                  title: "Customer Reviews"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "main_men_101",
                  title: "Main Menu"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}


async function sendcustreview(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Don’t just take our word for it 💬\nHere’s what conscious buyers like you are saying 👇\nWebsite and amazon review: https://orangutanorganics.com/products \n\nInstagram love: https://www.instagram.com/p/DOIOa4rkv5C/`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_105",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "stop_102",
                  title: "Back2 Shop & Explore"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}


async function sendrecipes(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Explore farm-fresh, nutritious recipes from our chef community:\n🥄 Red Rajma Curry with Tempering Spice\n🥄 Soyabean Stir-Fry\n🥄 Ghee-roasted Red Rice\nGet one sent to you now? View Recipe: https://orangutanorganics.com/who-are-we/recipes`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "view_products",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "back_nutri",
                  title: "back 2 nutri info"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendfarmerimpact(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We directly reinvest in:\n• Soil conservation 🌍\n• Enhancing livelihoods via our farmers consortium 📘\n• Organic certifications for villages 🧾\nSee our Farmer’s Impact : https://orangutanorganics.com/who-are-we/farmer-impact`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "view_products",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "back_ppl_love_us",
                  title: "back 2 y ppl <3 us"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendWhatsAppTrackingCTA(to, awb) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: {
          text: "Here is your Tracking link to check the status of your order 🚚",
        },
        action: {
          name: "cta_url",
          parameters: {
            display_text: "Track Your Order",
            url: `https://www.delhivery.com/track-v2/package/${awb}`,
          },
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log(`✅ Tracking CTA sent to ${to} for AWB ${awb}`);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppTrackingCTA error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppInteractiveMessage(to, body, buttons) {
  const formattedButtons = buttons.map((btn, index) => ({
    type: 'reply',
    reply: {
      id: `btn_${index}_${btn.id}`,
      title: btn.title
    }
  }));

  return axios({
    method: 'POST',
    url: `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    data: {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: body
        },
        action: {
          buttons: formattedButtons
        }
      }
    },
  });
}

function findIntentBasedResponse(userMessage) {
  const normalizedMessage = userMessage.toLowerCase().trim();
  
  // Direct matches
  if (intentBasedQA.has(normalizedMessage)) {
    return intentBasedQA.get(normalizedMessage);
  }
  
  // Partial matches for flexibility
  for (let [key, value] of intentBasedQA.entries()) {
    if (normalizedMessage.includes(key) || key.includes(normalizedMessage)) {
      return value;
    }
  }
  
  // Check for trace-related keywords
  if (normalizedMessage.includes('trace') || normalizedMessage.includes('track') || 
      normalizedMessage.includes('origin') || normalizedMessage.includes('source')) {
    return intentBasedQA.get('trace your products');
  }
  
  return null;
}

if (!PAYMENT_CONFIGURATION_NAME) {
  console.warn('Warning: PAYMENT_CONFIGURATION_NAME not set. The order_details message requires the exact payment configuration name from Meta.');
}

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// --- STATE STORE ---
const orderSessions = {};        // orderId => session
const phoneToOrderIds = {};      // phone => [orderId,...]
const idleTimers = {};
// remindedUsers / completedUsers / resolvedUsers Sets were removed (H-08 opt A).
// Reminder + completion flags are now Firebase-backed at userState/<phone> via
// isUserCompleted / isRemindedButNotCompleted / markReminded / markUserCompleted.
// State survives PM2 restart. resolvedUsers was dead code (declared, never used).
// NOTE: processedMessages and processedPayments now stored in Firebase for reliability

// ============================================
// MEMORY CLEANUP (Prevent Memory Leaks)
// ============================================

// Cleanup old sessions, payments, and state (runs every hour)
// Hourly cleanup — memory maps + Firebase old data. .unref() so it doesn't
// hold the event loop open during graceful shutdown (audit fix H-05).
const sessionCleanupTimer = setInterval(async () => {
  const now = Date.now();
  const sessionExpiryTime = 24 * 60 * 60 * 1000; // 24 hours
  let cleanupStats = {
    sessions: 0,
    timers: 0,
    phoneMapping: 0
  };

  // 1. Cleanup Firebase data (messages, payments, locks)
  try {
    await cleanupOldData();
  } catch (err) {
    console.error('❌ Firebase cleanup failed:', err);
  }

  // 2. Cleanup old/completed order sessions.
  // Defensive: sessions without createdAt/timestamp are SKIPPED, not deleted.
  // Previously a session with neither field fell back to `now - 0`, exceeded
  // every age threshold, and was silently nuked on the next pass — this bit
  // the phone-keyed cart drafts before M-10's write-site fix. Keep the guard
  // in place so any future write site that forgets createdAt fails loud
  // instead of losing customer data.
  for (const [orderId, session] of Object.entries(orderSessions)) {
    // Resolve a numeric createdAt from either the number field or a
    // parseable timestamp string. If neither is usable, treat as "unknown
    // age" and skip cleanup with a warning.
    let createdAtMs = null;
    if (typeof session.createdAt === 'number' && Number.isFinite(session.createdAt)) {
      createdAtMs = session.createdAt;
    } else if (typeof session.timestamp === 'string') {
      const parsed = Date.parse(session.timestamp);
      if (Number.isFinite(parsed)) createdAtMs = parsed;
    } else if (typeof session.timestamp === 'number' && Number.isFinite(session.timestamp)) {
      createdAtMs = session.timestamp;
    }

    if (createdAtMs === null) {
      console.warn(`[cleanup] session ${orderId} has no valid createdAt/timestamp — skipping (would incorrectly delete). Every write site MUST stamp createdAt (audit fix M-10).`);
      continue;
    }

    const sessionAge = now - createdAtMs;
    const shouldCleanup =
      (session.finalized && sessionAge > sessionExpiryTime) || // Finalized sessions older than 24h
      (!session.finalized && sessionAge > 2 * sessionExpiryTime) || // Abandoned sessions older than 48h
      session.payment_status === 'completed' || // Completed payments
      session.payment_status === 'failed'; // Failed payments

    if (shouldCleanup) {
      delete orderSessions[orderId];
      cleanupStats.sessions++;
    }
  }

  // 3. Cleanup idle timers for removed sessions
  for (const orderId of Object.keys(idleTimers)) {
    if (!orderSessions[orderId]) {
      clearTimeout(idleTimers[orderId]);
      delete idleTimers[orderId];
      cleanupStats.timers++;
    }
  }

  // 4. Cleanup phone-to-order mappings for removed sessions
  for (const [phone, orderIds] of Object.entries(phoneToOrderIds)) {
    const validOrderIds = orderIds.filter(orderId => orderSessions[orderId]);
    if (validOrderIds.length === 0) {
      delete phoneToOrderIds[phone];
      cleanupStats.phoneMapping++;
    } else if (validOrderIds.length < orderIds.length) {
      phoneToOrderIds[phone] = validOrderIds;
    }
  }

  // processedMessages/processedPayments are stored in Firebase and cleaned by
  // cleanupOldData() above (step 1). No in-memory copy exists here.

  // Log cleanup stats if anything was cleaned
  const totalCleaned = Object.values(cleanupStats).reduce((a, b) => a + b, 0);
  if (totalCleaned > 0) {
    console.log(`🧹 Cleanup: ${cleanupStats.sessions} sessions, ${cleanupStats.payments} payments, ${cleanupStats.timers} timers, ${cleanupStats.phoneMapping} phone mappings`);
  }
}, 60 * 60 * 1000); // Run cleanup every hour
sessionCleanupTimer.unref();

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Normalize and validate phone number
 * @param {string} phone - Phone number to normalize
 * @returns {string} - Normalized phone number (digits only)
 */
function normalizePhone(phone) {
  if (!phone) return '';

  // Remove all non-digit characters
  const normalized = (phone || '').replace(/\D/g, '');

  // Validate phone number length (10 digits for India)
  if (normalized.length > 0 && normalized.length !== 10 && normalized.length !== 12) {
    console.warn(`⚠️ Unusual phone number length: ${normalized.length} digits`);
  }

  return normalized;
}

/**
 * Normalize a WhatsApp free-text input for internal string matching.
 *
 * SCOPE (audit fix H-09)
 *   Trim + length-cap + lowercase. That's it. This helper does NOT sanitize
 *   for HTML — free-text messages go to (a) keyword-matching string equality,
 *   (b) console logs, (c) WhatsApp text replies via Meta API. None of those
 *   are HTML sinks. The previous `sanitizeInput` was named misleadingly:
 *   its body stripped `<>` and lossy-escaped `&` without protecting against
 *   real XSS vectors (javascript:, data:, backticks, template literals).
 *
 *   XSS at HTML sinks is closed elsewhere in the audit fix set:
 *     - shared/order-validation.js  — allowlist validation on structured
 *       website API inputs (name, email, address, pincode, etc.).
 *     - app-script.js's esc()       — HTML escape at email + PDF sinks.
 *
 * @param {string} raw     Raw text from Meta (msg.text.body, button title, etc.)
 * @param {number} maxLen  Length cap, default 1000 chars. DoS guard against
 *                         a customer pasting a wall of text into logs.
 * @returns {string}       Lowercased, trimmed, length-capped string.
 */
function normalizeBotText(raw, maxLen = 1000) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().slice(0, maxLen).toLowerCase();
}

/**
 * Verify a Meta WhatsApp webhook signature.
 *
 * Fail-closed: returns true ONLY when the HMAC-SHA256 of `payload` under
 * APP_SECRET matches `signature` byte-for-byte in constant time. Any other
 * outcome — missing secret, missing/malformed signature, mismatched length,
 * mismatched bytes — returns false.
 *
 * The lone exception is when the operator has explicitly acknowledged
 * running without a secret by setting WHATSAPP_WEBHOOK_INSECURE=true at
 * boot. That flag is validated at process start; here we just honor it.
 *
 * @param {Buffer|string} payload   Raw request body EXACTLY as sent by Meta.
 *                                  Must be the bytes captured by the
 *                                  express.json({verify}) middleware — do NOT
 *                                  pass JSON.stringify(req.body), whose byte
 *                                  sequence will differ from what Meta signed.
 * @param {string}        signature Value of the X-Hub-Signature-256 header.
 * @returns {boolean}
 */
function verifyWhatsAppSignature(payload, signature) {
  // Explicit insecure-dev bypass (validated at boot; safe to trust here).
  if (!process.env.APP_SECRET) {
    if (process.env.WHATSAPP_WEBHOOK_INSECURE === 'true') {
      // Accept, but leave a loud audit trail on every request.
      console.warn('🚨 [webhook][INSECURE_MODE] APP_SECRET unset — signature not verified');
      return true;
    }
    // Should be unreachable: boot-time check exits the process. Belt-and-braces.
    console.error('❌ [webhook] APP_SECRET missing at verification time — rejecting');
    return false;
  }

  if (!signature || typeof signature !== 'string') {
    console.warn('⚠️ [webhook] rejected: missing X-Hub-Signature-256 header');
    return false;
  }
  if (!signature.startsWith('sha256=')) {
    console.warn('⚠️ [webhook] rejected: malformed signature (expected "sha256=" prefix)');
    return false;
  }
  if (payload == null || payload.length === 0) {
    console.warn('⚠️ [webhook] rejected: empty payload cannot be authenticated');
    return false;
  }

  let expectedSignature;
  try {
    expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', process.env.APP_SECRET)
      .update(payload)
      .digest('hex');
  } catch (err) {
    // HMAC computation itself should not fail; if it does, treat as an
    // integrity failure rather than logging the exception (which could
    // include secret material on some Node versions).
    console.error('❌ [webhook] HMAC computation failed — rejecting');
    return false;
  }

  const receivedBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');

  // timingSafeEqual throws on unequal-length buffers. Length equality is not
  // itself a secret (both are sha256=<64 hex chars> == 71 bytes), so guarding
  // early doesn't leak information; it prevents the throw and keeps the
  // constant-time property of the compare that follows.
  if (receivedBuf.length !== expectedBuf.length) {
    console.warn(`⚠️ [webhook] rejected: signature length mismatch (received=${receivedBuf.length}, expected=${expectedBuf.length})`);
    return false;
  }

  try {
    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
  } catch (err) {
    console.error('❌ [webhook] timingSafeEqual failed — rejecting');
    return false;
  }
}

/**
 * Verify a Razorpay webhook signature.
 *
 * Fail-closed: returns { ok: true } only when the HMAC-SHA256 of `rawBody`
 * under RAZORPAY_WEBHOOK_SECRET matches `signature` byte-for-byte in
 * constant time. Any other outcome — missing secret, missing/malformed
 * signature, length mismatch, byte mismatch — returns { ok: false, reason }.
 *
 * The `reason` value is a fixed enum so log-based alerting can grep for it:
 *   secret_missing   — server misconfigured (return 503 to caller)
 *   no_raw_body      — express.json({verify}) didn't capture bytes; not JSON
 *   missing_header   — request has no X-Razorpay-Signature
 *   length_mismatch  — signature exists but wrong length
 *   byte_mismatch    — signature length matches but HMAC doesn't
 *   hmac_error       — crypto library threw during HMAC computation
 *
 * NOTE: An equivalent verifier exists in website/razorpay.js for the newer
 * /api/razorpay/webhook route. If you fix a bug here, fix it there too. A
 * TODO to consolidate into a shared module is tracked as a follow-up.
 *
 * @param {Buffer|string} rawBody   Bytes captured by express.json({verify}) —
 *                                  MUST be the raw request bytes; a
 *                                  re-serialized JSON.stringify(req.body)
 *                                  will not match what Razorpay signed.
 * @param {string|undefined} signature  Value of X-Razorpay-Signature header.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verifyRazorpayWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'secret_missing' };

  if (!rawBody || rawBody.length === 0) return { ok: false, reason: 'no_raw_body' };
  if (!signature || typeof signature !== 'string') return { ok: false, reason: 'missing_header' };

  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  } catch {
    return { ok: false, reason: 'hmac_error' };
  }

  // Length equality is not a secret (both sides are 64 hex chars = 64 bytes).
  // Guarding early prevents timingSafeEqual from throwing on unequal buffers
  // and preserves the constant-time property of the compare below.
  if (expected.length !== signature.length) return { ok: false, reason: 'length_mismatch' };

  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signature, 'utf8');

  try {
    return crypto.timingSafeEqual(expectedBuf, receivedBuf)
      ? { ok: true }
      : { ok: false, reason: 'byte_mismatch' };
  } catch {
    return { ok: false, reason: 'hmac_error' };
  }
}

async function sendWhatsAppText(to, text) {
  // Validate inputs
  if (!to) {
    console.warn(`⚠️ Cannot send message: recipient phone number is missing`);
    return false;
  }

  if (!text || text.trim() === '') {
    console.warn(`⚠️ Attempted to send empty message to ${to}`);
    return false;
  }

  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error(`❌ Cannot send message: ACCESS_TOKEN or PHONE_NUMBER_ID not configured`);
    return false;
  }

  try {
    await axios.post(GRAPH_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 10000 // 10 second timeout
    });
    console.log(`✅ Message sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ Error sending message to ${to}:`, err.response?.data || err.message || err);
    // Don't throw - just log and return false to prevent server crash
    return false;
  }
}

async function sendWhatsAppTemplate(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "have_a_query", // 👈 your approved template name
        language: { code: "en" }, // 👈 language code
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log(`✅ Template "have_a_query" sent to ${to}`);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppTemplate error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppList(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "Namaste from Orang Utan Organics 🌱",
        },
        body: {
          text: `Perched at 2,300 mtr in the Gangotri Valley, we are here to share the true taste of the Himalayas. \nHow can we brighten your day?`,
        },
        action: {
          button: "Options",
          sections: [
            {
              rows: [
                 { id: "1001", title: "Shop & Explore" },
                { id: "1002", title: "Why People Love Us" },
                { id: "1004", title: "Track Your Order" },
                { id: "1005", title: "Have A Query" },
              ],
            },
          ],
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log("✅ WhatsApp list message sent successfully:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppList error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppList_ss(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "",
        },
        body: {
          text: "Every purchase helps a real Himalayan farmer.\n✅ Small landholder support\n✅ Gangotri Valley & high altitude-based collective\n✅ Traceable from farm to pack\nWant to see how your food travels from seed to shelf? Track Origin: https://orangutanorganics.com/who-are-we/traceability",
        },
        action: {
          button: "Options",
          sections: [
            {
              rows: [
                { id: "priority_express_1", title: "Where we’re from" },
                { id: "priority_mail_2", title: "Why It Matters" },
                { id: "fgh_3", title: "Trace Your Products" },
                { id: "er_5", title: "Main Menu" },
                // { id: "cv", title: "Have A Query" },
              ],
            },
          ],
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log("✅ WhatsApp list message sent successfully:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppList error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppList_ni(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "",
        },
        body: {
          text: "Our products are:\n• 100% Himalayan grown & natural\n• NABL Lab-Tested for purity & nutrients\n• Rich in Iron, Fiber, and Antioxidants 🌾\nHere is Nutrition Info Table: https://orangutanorganics.com/nutrition",
        },
        action: {
          button: "Options",
          sections: [
            {
              rows: [
                { id: "priority_express_1_1", title: "Recipes" },
                { id: "priority_mail_2_1", title: "Sourcing Story" },
                { id: "fgh_31", title: "View Products" },
                { id: "er_51", title: "back 2 y ppl <3 us" },
                // { id: "cv", title: "Have A Query" },
              ],
            },
          ],
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log("✅ WhatsApp list message sent successfully:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppList error:", err.response?.data || err.message || err);
  }
}




async function sendWhatsAppCatalog(to) {
  try {
    // 1️⃣ Send the catalog message
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "product_list",
          header: { type: "text", text: "Featured Products 🌟" },
          body: { text: "Browse our catalog and pick your favorites 🌱" },
          footer: { text: "OrangUtan Organics" },
          action: {
            catalog_id: "1262132998945503",
            sections: [
              {
                title: "Our Products",
                product_items: [
                  { product_retailer_id: "43mypu8dye" },
                  { product_retailer_id: "l722c63kq9" },
                  { product_retailer_id: "kkii6r9uvh" },
                  { product_retailer_id: "m519x5gv9s" },
                  { product_retailer_id: "294l11gpcm" },
                  { product_retailer_id: "ezg1lu6edm" },
                  { product_retailer_id: "tzz72lpzz2" },
                  { product_retailer_id: "esltl7pftq" },
                  { product_retailer_id: "obdqyehm1w" },
                  { product_retailer_id: "5diu7mcmbf" },
                  { product_retailer_id: "324pmzr4c9" }
                ]
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    // 🕐 Optional: small delay to ensure order
    await new Promise((res) => setTimeout(res, 100));

    // 2️⃣ Send the "Main Menu" quick reply button
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          header: {
          type: "text",
          text: "OR",
        },
          body: {
            text: "Would you like to return to the Main Menu?"
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "main_menu",
                  title: "Main Menu"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent catalog + Main Menu button to ${to}`);
  } catch (err) {
    console.error(
      "sendWhatsAppCatalog error",
      err.response?.data || err.message || err
    );
  }
}







async function sendWhatsAppFlow(to, flowId, flowToken = null) {
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "Fill Delivery Details" },
      body: { text: "Please tap below to provide your info securely." },
      footer: { text: "OrangUtan Organics" },
      action: {
        name: "flow",
        parameters: {
          flow_id: flowId,
          flow_message_version: "3",
          flow_cta: "Enter Details"
        }
      }
    }
  };
  if (flowToken) data.interactive.action.parameters.flow_token = flowToken;
  try {
    await axios.post(GRAPH_URL, data, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
  } catch (err) {
    console.error('sendWhatsAppFlow error', err.response?.data || err.message || err);
  }
}

// --- App Script Integration ---
async function sendOrderToAppScript(orderData) {
  if (!APP_SCRIPT_URL) {
    console.warn('⚠️ APP_SCRIPT_URL not configured. Skipping order submission to Google Sheets.');
    return null;
  }

  // Validate orderData
  if (!orderData || !orderData.orderId) {
    console.error('❌ Invalid order data: orderId is required');
    return null;
  }

  try {
    // Format products for App Script with safety checks. stampGstRate
    // (audit fix M-16) injects per-line `gst_rate` from the catalog so the
    // invoice renderer can compute net/tax explicitly instead of assuming 5%.
    const products = stampGstRate(
      (orderData.productItems || []).map(item => ({
        sku: item.product_retailer_id,           // needed by stampGstRate's SKU lookup
        name: getProductName[item.product_retailer_id] || item.name || 'Item',
        size: `${getProductWeight[item.product_retailer_id] || 0}gm`,
        quantity: parseInt(item.quantity, 10) || 1,
        price: parseFloat(item.item_price || item.price || 0),
      }))
    );

    // Stamp the shared secret so the Apps Script's doPost can distinguish
    // this call from anyone who scraped the (previously committed) URL.
    // If the secret env is unset we still POST — the server-side rejection
    // (once the script is redeployed with H-11 enforcement) surfaces the
    // misconfig loudly rather than corrupting silently.
    if (!APP_SCRIPT_SHARED_SECRET) {
      console.warn(`⚠️ [sendOrderToAppScript] APP_SCRIPT_SHARED_SECRET unset — request will be rejected by any script with H-11 enforcement. orderId=${orderData.orderId}`);
    }

    const payload = {
      type: 'checkout',
      secret: APP_SCRIPT_SHARED_SECRET || '',
      orderId: orderData.orderId || '',
      timestamp: orderData.timestamp || new Date().toISOString(),
      name: orderData.name || '',
      email: orderData.email || '',
      phone: orderData.phone || '',
      address: orderData.address || '',
      pincode: orderData.pincode || '',
      city: orderData.city || '',
      state: orderData.state || '',
      products: products,
      paymentMode: orderData.paymentMode || '',
      paymentStatus: orderData.paymentStatus || '',
      paymentId: orderData.paymentId || '',
      subtotal: parseFloat(orderData.subtotal || 0),
      shippingCharge: parseFloat(orderData.shippingCharge || 0),
      codCharge: parseFloat(orderData.codCharge || 0),
      discount: parseFloat(orderData.discount || 0),
      total: parseFloat(orderData.total || 0),
      delhiveryResponse: orderData.delhiveryResponse || ''
    };

    const res = await axios.post(APP_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000 // 30 second timeout for Google Sheets
    });

    console.log(`✅ Order sent to App Script - Order ID: ${orderData.orderId}`);
    return res.data;
  } catch (err) {
    console.error('❌ sendOrderToAppScript error:', err.response?.data || err.message || err);
    // Don't throw - just log and return null so order processing continues
    return null;
  }
}

// product metadata (as you had)
const getProductName =
  { "43mypu8dye":"Himalayan badri cow ghee 120gm" ,
    "l722c63kq9":"Himalayan badri cow ghee 295gm" ,
    "kkii6r9uvh":"Himalayan badri cow ghee 495gm" ,
    "m519x5gv9s":"Himalayan White Rajma 500gm" ,
    "294l11gpcm":"Himalayan White Rajma 1kg" ,
    "ezg1lu6edm":"Himalayan Red Rajma 500gm" ,
    "tzz72lpzz2":"Himalayan Red Rajma 1kg" ,
    "esltl7pftq":"Wild Himalayan Tempering Spice" ,
    "obdqyehm1w":"Himalayan Red Rice",
    "5diu7mcmbf":"Himalayan Black Soyabean 500gm",
    "324pmzr4c9":"Himalayan Black Soyabean 1kg"
  
  };

const getProductWeight =
  { "43mypu8dye":120 ,
    "l722c63kq9":295 ,
    "kkii6r9uvh":495 ,
    "m519x5gv9s":500 ,
    "294l11gpcm":1000 ,
    "ezg1lu6edm":500 ,
    "tzz72lpzz2":1000 ,
    "esltl7pftq":100 ,
    "obdqyehm1w":1000,
    "5diu7mcmbf":500,
    "324pmzr4c9":1000
  };

// ---------------- Coupon System (audit fix M-15) ----------------
// COUPONS config lives in shared/catalog.js (single source of truth).
// validateCoupon is now async and enforces expiry + min-order + per-user-limit.
// Returns the historical shape when applicable — { code, discount, description }
// where `discount` is a fraction (0.10 for 10% off) — so all existing callers
// that read `couponData.discount` continue to work with no site-level changes.
async function validateCoupon(couponCode, { phone = null, orderAmountPaise = null } = {}) {
  if (!couponCode || typeof couponCode !== 'string' || couponCode.trim() === '') {
    return null;
  }
  const result = await catalogValidateCouponForUser({
    code: couponCode,
    phone,
    orderAmountPaise,
    getCouponUsageCount,
  });
  if (!result) return null;
  if (result.ok === false) {
    console.warn(`[validateCoupon] coupon rejected code=${result.code} reason=${result.reason} phone_prefix=${phone ? String(phone).slice(0, 4) + '****' : 'unknown'}`);
    return null;
  }
  // Success — return legacy shape so existing callers (result.discount / .code /
  // .description) keep working without touching every math site.
  return {
    code: result.code,
    discount: result.percent_off / 100,
    description: result.description,
    percent_off: result.percent_off,
  };
}

// ---------------- NEW: send order_details (WhatsApp native payment) ----------------
async function sendWhatsAppOrderDetails(to, session) {
  if (!PAYMENT_CONFIGURATION_NAME) {
    console.error("Cannot send order_details: PAYMENT_CONFIGURATION_NAME not configured in env.");
    throw new Error("PAYMENT_CONFIGURATION_NAME missing");
  }

  // Build items for order_details; amounts must be integer * offset (offset=100 for INR)
  const items = (session.productItems || []).map((it) => {
    const retailer_id = it.product_retailer_id || it.retailer_id || it.id || '';
    const name = getProductName[retailer_id] || it.name || 'Item';
    // Prefer item.item_price if present (likely in catalog order payload), assume rupees -> convert to paise
    const unitPricePaise = Math.round((parseFloat(it.item_price || it.price || 0) || 0) * 100) || 0;
    const qty = parseInt(it.quantity || it.qty || it.quantity_ordered || 1, 10) || 1;
    const amountValue = unitPricePaise || Math.round((session.amount || 0) / Math.max(1, (session.productItems || []).length));
    return {
      retailer_id,
      name,
      amount: { value: amountValue, offset: 100 },
      quantity: qty
    };
  });

  // total amount (paise) is session.amount (we keep this convention)
  const prod_cost = session.amount || items.reduce((s, it) => s + (it.amount?.value || 0) * (it.quantity || 1), 0);
  let shippingChargePaise = 0;
  const product_data = session.productItems || [];
   let total_wgt = 0;
    for (let i = 0; i < product_data.length; i++) {
      const id = product_data[i].product_retailer_id;
      const q = parseInt(product_data[i].quantity, 10) || 1;
      total_wgt += ((getProductWeight[id] || 0) * q);
    }

    // Calculate bulk discount (audit fix M-17 — threshold + rate imported
    // from shared/catalog.js so bot and website flows share one source of
    // truth). computeBulkDiscount returns 0 when weight is below threshold.
    let bulkDiscountPaise = computeBulkDiscount(prod_cost, total_wgt);

    // Apply coupon discount (audit fix M-15: enforces expiry + min-order +
    // per-user-limit; on any rejection the validator logs the reason and
    // returns null so the order proceeds without the discount).
    let couponDiscountPaise = 0;
    const couponData = await validateCoupon(session.customer?.coupon, {
      phone: session.phone || to,
      orderAmountPaise: prod_cost,
    });
    if (couponData) {
      // Apply coupon on the product cost (before bulk discount)
      couponDiscountPaise = Math.round(prod_cost * couponData.discount);
      session.coupon = couponData.code;
      session.couponDiscount = couponDiscountPaise;
    }

    // Total discount combines bulk + coupon
    const discountPaise = bulkDiscountPaise + couponDiscountPaise;

    try {
      const chargesResp = await getDelhiveryCharges({
        origin_pin: DELHIVERY_ORIGIN_PIN,
        dest_pin: session.customer?.pincode || session.customer?.pin || '',
        cgm: total_wgt,
        pt: 'Pre-paid'
      });
      if (chargesResp && Array.isArray(chargesResp) && chargesResp[0]?.total_amount) {
        shippingChargePaise = Math.round(chargesResp[0].total_amount * 100);
      } else if (chargesResp?.total_amount) {
        // sometimes partners return object
        shippingChargePaise = Math.round(chargesResp.total_amount * 100);
      } else {
        console.warn("Could not parse delhivery charges response:", chargesResp);
      }
    } catch (err) {
      console.warn('Error retrieving delhivery charges for prepaid', err.message || err);
    }

    // Calculate discounted amount for free shipping check and total
    const discountedAmount = prod_cost - discountPaise;

    // Free shipping over threshold (audit fix M-17 — threshold from catalog).
    if (shouldWaiveShipping(discountedAmount)) {
      shippingChargePaise = 0;
    }

    session.shipping_charge = shippingChargePaise;
    session.discount = discountPaise;
    session.amount = discountedAmount; // Update session amount with discounted value


    const totalAmountValue = discountedAmount + shippingChargePaise
  




  // Build order payload with discount if applicable
  const orderParams = {
    status: "pending",
    items,
    subtotal: { value: prod_cost, offset: 100 },
    tax: { value: 0, offset: 100 },
    shipping: { value: Math.round((session.shipping_charge || 0)), offset: 100 }
  };

  // Add discount field if any discount was applied
  if (discountPaise > 0) {
    let discountDescription = "";
    if (bulkDiscountPaise > 0 && couponDiscountPaise > 0) {
      discountDescription = `Bulk Discount (20% OFF) + Coupon ${couponData.code} (${couponData.description})`;
    } else if (bulkDiscountPaise > 0) {
      discountDescription = "Bulk Discount (20% OFF)";
    } else if (couponDiscountPaise > 0) {
      discountDescription = `Coupon ${couponData.code} (${couponData.description})`;
    }

    orderParams.discount = {
      value: discountPaise,
      offset: 100,
      description: discountDescription
    };
  }

  let bodyText = "Please review your order and complete the payment. NOTE: shipment cost is included";
  if (discountPaise > 0) {
    if (bulkDiscountPaise > 0 && couponDiscountPaise > 0) {
      bodyText = `🎉 Bulk Discount (20% OFF) + Coupon ${couponData.code} (${couponData.description}) applied! ` + bodyText;
    } else if (bulkDiscountPaise > 0) {
      bodyText = "🎉 Bulk Discount (20% OFF) applied! " + bodyText;
    } else if (couponDiscountPaise > 0) {
      bodyText = `🎉 Coupon ${couponData.code} (${couponData.description}) applied! ` + bodyText;
    }
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "order_details",
      header: { type: "text", text: `Order ${session.orderId}` },
      body: { text: bodyText },
      footer: { text: "OrangUtan Organics" },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: session.orderId,
          type: "physical-goods",
          currency: "INR",
          total_amount: { value: totalAmountValue, offset: 100 },
          payment_type: "payment_gateway:razorpay", // using UPI payment config; if using gateway use "payment_gateway:razorpay" etc.
          payment_configuration: PAYMENT_CONFIGURATION_NAME,
          order: orderParams
        }
      }
    }
  };

  try {
    const res = await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    return res.data;
  } catch (err) {
    console.error('sendWhatsAppOrderDetails error', err.response?.data || err.message || err);
    throw err;
  }
}

// ---------------- re-usable finalization of a paid order ----------------
//
// AUDIT FIX H-02
// --------------
// Old implementation marked session.finalized=true in BOTH the success and
// failure branches, permanently blocking retry when Delhivery or Sheets
// failed. Refactored to use the same pendingOrders state machine + atomic
// fulfillment lock that the website flow uses (website/checkout.js's
// fulfillOrder). Ordering is Delhivery first (with response validation +
// duplicate recovery), then Sheets, then mark 'fulfilled' — never mark on
// error. Returns an outcome object; the webhook wrapper is responsible for
// mirroring the outcome onto session state and deciding whether to mark
// the paymentId as processed.
//
// Returns:
//   { status: 'fulfilled',         waybill, delhiveryResponse }
//   { status: 'already_fulfilled', waybill, delhiveryResponse }
//   { status: 'in_progress' }
//   { status: 'error', stage, message, waybill?, delhiveryResponse? }
//
// The caller MUST set session.finalized=true ONLY when status is
// 'fulfilled' or 'already_fulfilled'. Any other outcome must leave
// session.finalized untouched so a subsequent webhook retry can complete
// the missing step.

// Best-effort send that swallows errors — used for user-facing status
// messages that must not derail the fulfillment path.
async function trySendWhatsAppText(phone, text, requestId) {
  try {
    await sendWhatsAppText(phone, text);
  } catch (err) {
    console.warn(`[${requestId}] whatsapp send failed (non-fatal): ${err.message || err}`);
  }
}

// Compute totals for a paid bot order and build the snapshot to persist on
// the pending record. Also mirrors computed values back onto the session so
// existing readers (logs, post-payment message flow) see them.
async function buildBotOrderSnapshot(session, requestId) {
  const phone = session.phone || '';
  const product_data = session.productItems || [];

  let total_wgt = 0;
  for (let i = 0; i < product_data.length; i++) {
    const id = product_data[i].product_retailer_id;
    const q = parseInt(product_data[i].quantity, 10) || 1;
    total_wgt += ((getProductWeight[id] || 0) * q);
  }

  // Bulk discount (audit fix M-17 — threshold + rate from shared/catalog.js).
  const bulkDiscountPaise = computeBulkDiscount(session.amount, total_wgt);
  if (bulkDiscountPaise > 0) {
    session.amount = session.amount - bulkDiscountPaise;
  }

  // Coupon discount (only if not already applied to session).
  // Audit fix M-15: enforces expiry + min-order + per-user-limit via Firebase.
  let couponDiscountPaise = session.couponDiscount || 0;
  if (!couponDiscountPaise && session.customer?.coupon) {
    const couponData = await validateCoupon(session.customer.coupon, {
      phone,
      orderAmountPaise: session.amount,
    });
    if (couponData) {
      couponDiscountPaise = Math.round(session.amount * couponData.discount);
      session.amount = session.amount - couponDiscountPaise;
      session.coupon = couponData.code;
      session.couponDiscount = couponDiscountPaise;
    }
  }

  session.discount = bulkDiscountPaise + couponDiscountPaise;

  // Build the products-desc string for Delhivery's shipment payload.
  let final_product_name = "";
  for (let i = 0; i < product_data.length; i++) {
    final_product_name += (getProductName[product_data[i].product_retailer_id] || 'Item') + "(" + (product_data[i].quantity || 1) + ")" + "\n";
  }
  if (bulkDiscountPaise > 0) {
    final_product_name += "Bulk Discount (20% OFF): -₹" + (bulkDiscountPaise / 100).toFixed(2) + "\n";
  }
  if (couponDiscountPaise > 0) {
    final_product_name += `Coupon ${session.coupon} (10% OFF): -₹` + (couponDiscountPaise / 100).toFixed(2) + "\n";
  }
  final_product_name += "+ shipping charge";

  // Shipping via Delhivery quote. Errors here are non-fatal (fall back to 0).
  let shippingChargePaise = 0;
  try {
    const chargesResp = await getDelhiveryCharges({
      origin_pin: DELHIVERY_ORIGIN_PIN,
      dest_pin: session.customer?.pincode || session.customer?.pin || '',
      cgm: total_wgt,
      pt: 'Pre-paid',
    });
    if (chargesResp && Array.isArray(chargesResp) && chargesResp[0]?.total_amount) {
      shippingChargePaise = Math.round(chargesResp[0].total_amount * 100);
    } else if (chargesResp?.total_amount) {
      shippingChargePaise = Math.round(chargesResp.total_amount * 100);
    } else {
      console.warn(`[${requestId}] could not parse delhivery charges response:`, chargesResp);
    }
  } catch (err) {
    console.warn(`[${requestId}] error retrieving delhivery charges for prepaid: ${err.message || err}`);
  }

  // Free shipping over threshold (audit fix M-17 — threshold from catalog).
  if (shouldWaiveShipping(session.amount)) {
    shippingChargePaise = 0;
  }
  session.shipping_charge = shippingChargePaise;

  // Delhivery shipment payload (bot's original shape preserved verbatim).
  const shipmentData = {
    name: session.customer?.name || 'Customer',
    add: `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
    pin: session.customer?.pincode || session.customer?.pin || '',
    city: session.customer?.city || '',
    state: session.customer?.state || '',
    country: 'India',
    phone: session.customer?.phone || phone,
    order: `Order_${session.orderId || Date.now()}`,
    payment_mode: "Prepaid",
    products_desc: final_product_name,
    hsn_code: "",
    cod_amount: "0",
    total_amount: String(Math.round(session.amount / 100)),
    seller_add: "",
    seller_name: "",
    seller_inv: "",
    quantity: "",
    waybill: "",
    shipment_width: "100",
    shipment_height: "100",
    weight: "",
    shipping_mode: "Surface",
    address_type: "",
  };

  // Apps Script payload (bot's original shape preserved verbatim).
  const orderData = {
    orderId: session.orderId || '',
    timestamp: new Date().toISOString(),
    name: session.customer?.name || '',
    email: session.customer?.email || '',
    phone: session.customer?.phone || phone,
    address: `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
    pincode: session.customer?.pincode || '',
    city: session.customer?.city || '',
    state: session.customer?.state || '',
    productItems: session.productItems || [],
    paymentMode: 'Prepaid',
    paymentStatus: 'Paid',
    paymentId: '',
    subtotal: (session.amount / 100),
    shippingCharge: (session.shipping_charge / 100),
    codCharge: 0,
    discount: (session.discount / 100),
    coupon: session.coupon || '',
    total: ((session.amount + session.shipping_charge) / 100),
  };

  return { shipmentData, orderData };
}

async function finalizePaidOrder(session, paymentInfo = {}) {
  const phone = session.phone || '';
  const orderId = session.orderId;
  const requestId = `bot_${orderId || 'nooid'}_${Date.now().toString(36)}`;

  if (!orderId) {
    console.error(`[${requestId}] finalizePaidOrder called without session.orderId — cannot fulfill`);
    return { status: 'error', stage: 'preflight', message: 'session has no orderId' };
  }

  session.payment_status = 'paid';

  // ---- Materialize the pending record (idempotent create-if-not-exists) ----
  // First call for this orderId: compute snapshot, create record.
  // Retry call: reuse existing snapshot (do not re-compute; totals already fixed).
  let pendingRecord;
  let isFirstCall = false;
  try {
    const existing = await getPendingOrder(orderId);
    if (existing) {
      pendingRecord = existing;
      // Mirror stored totals back onto session so anything that reads
      // session.amount / .shipping_charge / .discount still gets the right values.
      if (existing.session_totals) {
        session.amount = existing.session_totals.amount;
        session.shipping_charge = existing.session_totals.shipping_charge;
        session.discount = existing.session_totals.discount;
        session.coupon = existing.session_totals.coupon || session.coupon;
        session.couponDiscount = existing.session_totals.couponDiscount || session.couponDiscount;
      }
    } else {
      isFirstCall = true;
      const snapshot = await buildBotOrderSnapshot(session, requestId);
      const created = await createPendingOrder(orderId, {
        source: 'whatsapp',
        paymentMode: 'prepaid',
        status: 'paid',
        orderData: snapshot.orderData,
        shipmentData: snapshot.shipmentData,
        pickupLocation: null,
        // Store the session totals we mutated so retries can restore them
        // onto session state without re-computing (which would double-apply
        // the discount).
        session_totals: {
          amount: session.amount,
          shipping_charge: session.shipping_charge,
          discount: session.discount,
          coupon: session.coupon || null,
          couponDiscount: session.couponDiscount || 0,
        },
      });
      pendingRecord = created.record || created.existing;
      // If someone else won the create race, we're actually on a retry.
      if (!created.created) {
        isFirstCall = false;
      }
    }
  } catch (fbErr) {
    console.error(`[${requestId}] pending-record materialization failed: ${fbErr.message}`);
    return { status: 'error', stage: 'pending_record', message: fbErr.message };
  }

  // ---- User-facing "Payment successful" message (send once, on first call only) ----
  if (isFirstCall) {
    let successMsg = "✅ Payment successful!";
    if (session.discount > 0) successMsg += " 🎉 Discounts applied!";
    successMsg += " Your order is confirmed.";
    await trySendWhatsAppText(phone, successMsg, requestId);
  }

  // ---- Acquire the exclusive fulfillment lock ----
  const lock = await tryStartFulfillment(orderId);
  if (!lock.ok) {
    if (lock.reason === 'already_fulfilled') {
      console.log(`[${requestId}] orderId=${orderId} already fulfilled (idempotent) waybill=${lock.record?.waybill}`);
      return {
        status: 'already_fulfilled',
        waybill: lock.record?.waybill,
        delhiveryResponse: lock.record?.delhiveryResponse,
      };
    }
    if (lock.reason === 'in_progress') {
      console.warn(`[${requestId}] orderId=${orderId} fulfillment already in progress; concurrent webhook`);
      return { status: 'in_progress' };
    }
    console.error(`[${requestId}] orderId=${orderId} cannot acquire lock: ${lock.reason}`);
    return { status: 'error', stage: 'lock', message: `cannot fulfill: ${lock.reason}` };
  }

  const record = lock.record;
  const shipment = record.shipmentData;
  const orderData = record.orderData;

  if (!shipment || !orderData) {
    // Should not happen post-materialization, but be defensive.
    await updatePendingOrder(orderId, {
      status: 'failed_fulfillment',
      fulfillmentError: 'missing_snapshot',
      fulfillmentErrorAt: Date.now(),
    });
    console.error(`[${requestId}] orderId=${orderId} pending record missing shipmentData/orderData`);
    return { status: 'error', stage: 'snapshot', message: 'snapshot missing on pending record' };
  }

  // ---- Delhivery (skip if we already have a waybill from a prior attempt) ----
  let waybill = record.waybill || null;
  let delhiveryResp = record.delhiveryResponse || null;
  let delhiveryJustSucceeded = false;

  if (!waybill) {
    console.log(`[${requestId}] orderId=${orderId} refnum=${shipment.order} — calling Delhivery`);

    let raw;
    try {
      raw = await createDelhiveryShipment({ shipment });
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : (err.message || String(err));
      console.error(`[${requestId}] delhivery NETWORK error: ${detail}`);
      await updatePendingOrder(orderId, {
        status: 'failed_fulfillment',
        fulfillmentError: `delhivery_network: ${err.message || err}`,
        fulfillmentErrorAt: Date.now(),
      });
      await trySendWhatsAppText(phone, `⚠️ Payment received but shipment creation failed. We'll follow up.`, requestId);
      return { status: 'error', stage: 'delhivery_call', message: err.message || String(err) };
    }

    const validation = validateDelhiveryResponse(raw);
    const tag = validation.ok ? 'PASS' : validation.isDuplicate ? 'DUPLICATE' : 'FAIL';
    console.log(`[${requestId}] delhivery ${tag}: ${JSON.stringify(raw)}`);

    if (validation.ok) {
      waybill = validation.waybill;
      delhiveryResp = raw;
      delhiveryJustSucceeded = true;
      await updatePendingOrder(orderId, {
        waybill,
        delhiveryUploadWbn: validation.uploadWbn,
        delhiveryResponse: raw,
      });
    } else if (validation.isDuplicate) {
      // Delhivery says the refnum already exists. Recovery: if we've stored the
      // waybill previously, use it; otherwise fail loudly for manual attention.
      if (record.waybill) {
        waybill = record.waybill;
        delhiveryResp = record.delhiveryResponse || raw;
        console.log(`[${requestId}] duplicate ack; using stored waybill=${waybill}`);
      } else {
        console.error(`[${requestId}] delhivery DUPLICATE with no stored waybill — manual reconciliation needed`);
        await updatePendingOrder(orderId, {
          status: 'failed_fulfillment',
          fulfillmentError: 'delhivery_duplicate_no_stored_waybill',
          fulfillmentErrorAt: Date.now(),
          delhiveryResponse: raw,
        });
        return {
          status: 'error',
          stage: 'delhivery_duplicate',
          message: 'Delhivery reports duplicate refnum but no waybill on record',
        };
      }
    } else {
      await updatePendingOrder(orderId, {
        status: 'failed_fulfillment',
        fulfillmentError: `delhivery_fail: ${validation.reason}`,
        fulfillmentErrorAt: Date.now(),
        delhiveryResponse: raw,
      });
      await trySendWhatsAppText(phone, `⚠️ Payment received but shipment creation failed. We'll follow up.`, requestId);
      return {
        status: 'error',
        stage: 'delhivery_response',
        message: `Delhivery rejected shipment: ${validation.reason}`,
      };
    }
  } else {
    console.log(`[${requestId}] orderId=${orderId} waybill=${waybill} already recorded; skipping Delhivery call`);
  }

  // "Shipment created" WhatsApp — send only when Delhivery JUST succeeded in
  // this call (i.e. not on retries that skipped the Delhivery step).
  if (delhiveryJustSucceeded) {
    await trySendWhatsAppText(phone, `📦 Shipment created. We'll share tracking once available.`, requestId);
  }

  // ---- Sheets / App Script (skip if already saved) ----
  if (!record.sheetsSaved) {
    try {
      await sendOrderToAppScript({
        ...orderData,
        delhiveryResponse: JSON.stringify(delhiveryResp || {}),
        waybill,
      });
      await updatePendingOrder(orderId, {
        sheetsSaved: true,
        sheetsSavedAt: Date.now(),
      });
      console.log(`[${requestId}] orderId=${orderId} — App Script saved`);
    } catch (err) {
      console.error(`[${requestId}] app-script save FAILED: ${err.message || err}`);
      await updatePendingOrder(orderId, {
        status: 'failed_fulfillment',
        fulfillmentError: `sheets_save: ${err.message || err}`,
        fulfillmentErrorAt: Date.now(),
      });
      // Waybill is safely stored on the record — a retry will skip Delhivery
      // and only re-attempt Sheets. Do NOT mark fulfilled.
      return {
        status: 'error',
        stage: 'sheets_save',
        message: err.message || String(err),
        waybill,
        delhiveryResponse: delhiveryResp,
      };
    }
  } else {
    console.log(`[${requestId}] orderId=${orderId} — App Script already saved on prior attempt; skipping`);
  }

  // ---- Mark fulfilled ----
  await updatePendingOrder(orderId, {
    status: 'fulfilled',
    fulfilledAt: Date.now(),
    fulfillmentError: null,
  });
  console.log(`[${requestId}] ✅ orderId=${orderId} FULFILLED (waybill=${waybill})`);

  // Audit-trail coupon usage (audit fix M-15). Best-effort — recordCouponUsage
  // internally logs+swallows Firebase errors so a Firebase blip doesn't affect
  // the fulfilled response returned to the webhook.
  const redeemedCoupon = session.coupon || record.session_totals?.coupon;
  if (redeemedCoupon && phone) {
    await recordCouponUsage(redeemedCoupon, phone, orderId);
  }

  return { status: 'fulfilled', waybill, delhiveryResponse: delhiveryResp };
}

// ---------------- Delhivery helpers ----------------
async function getDelhiveryCharges({ origin_pin = DELHIVERY_ORIGIN_PIN, dest_pin, cgm = 5000, pt = 'Pre-paid' }) {
  // Validate inputs
  if (!dest_pin) {
    throw new Error('Destination pincode is required');
  }

  if (!DELHIVERY_TOKEN) {
    throw new Error('DELHIVERY_TOKEN not configured');
  }

  try {
    const params = {
      md: 'S',
      ss: 'Delivered',
      d_pin: dest_pin,
      o_pin: origin_pin,
      cgm,
      pt
    };
    const res = await axios.get(DELHIVERY_CHARGES_URL, {
      headers: { Authorization: `Token ${DELHIVERY_TOKEN}`, 'Content-Type': 'application/json' },
      params,
      timeout: 15000 // 15 second timeout
    });
    return res.data;
  } catch (err) {
    console.error('❌ Delhivery charges error:', err.response?.data || err.message || err);
    // Don't throw - return null and let caller handle it
    return null;
  }
}

async function createDelhiveryShipment({ shipment, pickup_location = { name: "Delhivery Uttarkashi", add: "", city: "", pin: DELHIVERY_ORIGIN_PIN, phone: "" } }) {
  // Validate inputs
  if (!shipment) {
    throw new Error('Shipment data is required');
  }

  if (!DELHIVERY_TOKEN) {
    throw new Error('DELHIVERY_TOKEN not configured');
  }

  // Validate required shipment fields
  const requiredFields = ['name', 'add', 'pin', 'phone', 'order', 'payment_mode'];
  const missingFields = requiredFields.filter(field => !shipment[field]);
  if (missingFields.length > 0) {
    throw new Error(`Missing required shipment fields: ${missingFields.join(', ')}`);
  }

  try {
    const payload = { shipments: [shipment], pickup_location };
    const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
    const res = await axios.post(DELHIVERY_CREATE_URL, bodyStr, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 20000 // 20 second timeout
    });
    return res.data;
  } catch (err) {
    console.error('❌ Delhivery create shipment error:', err.response?.data || err.message || err);
    // Re-throw so caller can handle appropriately
    throw new Error(`Failed to create Delhivery shipment: ${err.message}`);
  }
}

// ---------------- Webhook & message handlers (main) ----------------

// Webhook verification (Meta webhook)
app.get('/', whatsappVerifyIpLimiter, (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming WhatsApp messages — per-IP + per-source-phone limits (H-07).
app.post('/', whatsappWebhookIpLimiter, whatsappWebhookPhoneLimiter, async (req, res) => {
  try {
    // Validate request body
    if (!req.body || !req.body.entry) {
      console.warn('⚠️ Invalid webhook payload received');
      return res.sendStatus(200);
    }

    // Verify webhook signature. FAIL CLOSED: any request that we cannot
    // cryptographically attribute to Meta is rejected with 403. Do not fall
    // back to JSON.stringify(req.body) — the re-serialized bytes will not
    // match what Meta signed and the check would spuriously fail.
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody;
    const sourceIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    if (!rawBody || rawBody.length === 0) {
      // Should be impossible in normal operation: express.json({verify})
      // populates req.rawBody for any application/json POST that reached us
      // with a body. If it's missing, either the middleware wasn't applied
      // or the request wasn't JSON — either way, we can't verify.
      console.error(`❌ [webhook] rejected: no raw body captured. ip=${sourceIp} ua="${userAgent}"`);
      return res.sendStatus(403);
    }

    if (!verifyWhatsAppSignature(rawBody, signature)) {
      // Rejection reason was logged inside verifyWhatsAppSignature; here we
      // add caller-side context (ip, ua) that the helper doesn't see.
      console.error(`❌ [webhook] rejected: signature verification failed. ip=${sourceIp} ua="${userAgent}" hasHeader=${Boolean(signature)}`);
      return res.sendStatus(403);
    }

    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const metadata = req.body.entry?.[0]?.changes?.[0]?.value?.metadata;
    const phoneIdFromMessage = metadata?.phone_number_id;

    if (phoneIdFromMessage !== phoneNumberId) {
      console.log(`Ignoring message sent to different number: ${phoneIdFromMessage}`);
      return res.sendStatus(200);
    }

    if (!msg) return res.sendStatus(200);

  // Deduplication check - prevent processing the same message multiple times (FIREBASE)
  const messageId = msg.id;
  const messageType = msg.type;

  console.log(`📨 Webhook received - Type: ${messageType}, ID: ${messageId || 'NO_ID'}, From: ${msg.from}`);

  // Check if message already processed (using Firebase for reliability)
  if (messageId) {
    const alreadyProcessed = await isMessageProcessed(messageId);
    if (alreadyProcessed) {
      console.log(`🔄 Duplicate message detected in Firebase (ID: ${messageId}), skipping processing`);
      return res.sendStatus(200);
    }
  }

  const fromRaw = msg.from;
  const from = normalizePhone(fromRaw);

  // Validate phone number
  if (!from || from.length < 10) {
    console.warn(`⚠️ Invalid phone number received: ${fromRaw}`);
    return res.sendStatus(200);
  }

  // Mark message as processed IMMEDIATELY in Firebase to prevent race conditions
  if (messageId) {
    await markMessageAsProcessed(messageId);
    console.log(`✓ Message marked as processed in Firebase: ${messageId}`);
  } else {
    console.warn(`⚠️ Message has no ID - cannot deduplicate! Type: ${messageType}, From: ${from}`);
  }

  if (!phoneToOrderIds[from]) phoneToOrderIds[from] = [];

  let session = null;
  let msgBody = "";
  if (msg.type === "text") {
    // Normalize for internal string matching (not HTML sanitization — H-09).
    msgBody = normalizeBotText(msg.text?.body);
  } else if (msg.type === "interactive") {
    if (msg.interactive.type === "button_reply") {
      msgBody = normalizeBotText(msg.interactive.button_reply.title);
    } else if (msg.interactive.type === "list_reply") {
      msgBody = normalizeBotText(msg.interactive.list_reply.title);
    }
  } else if (msg.type === "order") {
    msgBody = "order_received";
  } else if (msg.type === "button") {
    msgBody = normalizeBotText(msg.button?.text);
  }

  if (msgBody) {
    logCustomerInteraction(from, msgBody).catch((e) =>
      console.error('logCustomerInteraction failed:', e?.message || e)
    );
  }

   // ---- Idle timer handling ----
  // reset idle timer only for active customers who haven’t completed data
if (!(await isUserCompleted(from))) {
  if (idleTimers[from]) clearTimeout(idleTimers[from]);
  idleTimers[from] = setTimeout(async () => {
    // only send reminder if user still hasn't shared info
    if (!(await isUserCompleted(from))) {
      await sendWhatsAppText(
        from,
        "Still thinking?\n\nNo rush… but our small-batch treasures don’t hang around for long ✨,\n\nJust share your name & email so we can send you exclusive Himalayan food tips, & recipes."
      );
      await markReminded(from);
      console.log(`⏰ Reminder sent to ${from}`);
    }
  }, 3 * 60 * 60 * 1000);
  // .unref() so the pending reminder timer doesn't hold the event loop open
  // during graceful shutdown. The reminder still fires normally while the
  // process is up; it just doesn't block exit (audit fix H-05).
  idleTimers[from].unref();
}




  // Flow submission handler (nfm_reply)
  if (msg?.interactive?.nfm_reply) {
    let customerData;
    try {
      customerData = JSON.parse(msg.interactive.nfm_reply.response_json);
    } catch (e) {
      customerData = msg.interactive.nfm_reply.response_json;
    }
    if (customerData?.flow_token === 'test_101') {
      console.log('Ignoring meta test flow payload');
      return res.sendStatus(200);
    }

    // ========================================
    // CRITICAL: Atomic Order Lock (Firebase Transaction)
    // Prevents duplicate orders from simultaneous webhooks
    // ========================================
    const orderResult = await acquireOrderLock(from, async () => {
      // This callback only runs if we successfully acquired the lock
      // If another webhook is processing, this won't execute

      // Cryptographic orderId — 72 bits of entropy in a 12-char base64url suffix.
      // Previous scheme was a 5-digit ShortUniqueId (100K IDs, non-crypto) which
      // is enumerable in seconds and collision-prone under the birthday paradox.
      // Fix for audit finding C-06. Prefix "OUO-" is preserved for Sheets /
      // Delhivery / App Script consumers that grep by prefix. Suffix uses only
      // [A-Za-z0-9_-] — passes shared/order-validation.js's ORDER_ID_RE and is
      // a known-safe alphabet for Delhivery refnum.
      const orderId = `OUO-${crypto.randomBytes(9).toString('base64url')}`;
      session = {
        orderId,
        phone: from,
        customer: customerData,
        step: 4,
        productItems: (orderSessions[from]?.productItems) || [],
        amount: (orderSessions[from]?.amount) || 0,
        createdAt: Date.now(), // For memory cleanup
        timestamp: new Date().toISOString(), // For logging
        finalized: false,
        processing: false
      };
      orderSessions[orderId] = session;
      if (!phoneToOrderIds[from]) phoneToOrderIds[from] = [];
      phoneToOrderIds[from].push(orderId);

      // Save session to Firebase for persistence
      await saveOrderSession(orderId, session);

      console.log(`📦 Order created - ID: ${orderId}, Customer: ${from}`);
      await sendWhatsAppText(from, `Thanks! We've received your delivery details. (OrderId: ${orderId})`);

      session.amount = session.amount || 0; // paise
      const paymentMode = (customerData.payment_mode || '').toLowerCase();
      console.log(`💰 Payment mode selected: ${paymentMode.toUpperCase()} for order ${orderId}`);

      if (paymentMode === 'cod' || paymentMode === 'cash on delivery' || paymentMode === 'cash-on-delivery') {
      session.cod_error = true;
            // COD charge is now sourced from shared/catalog.js (env-overridable
            // via COD_CHARGE_PAISE). Audit fix M-15 — replaces the previous
            // hardcoded `150 * 100` literal.
            const codChargePaise = COD_CHARGE_PAISE;
            let shippingChargePaise = 0;
            const product_data = session.productItems;
            let total_wgt = 0
            for(let i=0;i<product_data.length;i++){
                total_wgt+=getProductWeight[product_data[i].product_retailer_id]*product_data[i].quantity
            }

            // Bulk discount (audit fix M-17 — threshold + rate from catalog).
            let discountPaise = computeBulkDiscount(session.amount, total_wgt);
            const bulkDiscountApplied = discountPaise > 0;
            if (bulkDiscountApplied) {
              session.amount = session.amount - discountPaise;
            }

            // Apply coupon discount (audit fix M-15).
            let couponDiscountPaise = 0;
            const couponData = await validateCoupon(customerData.coupon, {
              phone: from,
              orderAmountPaise: session.amount,
            });
            if (couponData) {
              couponDiscountPaise = Math.round(session.amount * couponData.discount);
              session.amount = session.amount - couponDiscountPaise;
              session.coupon = couponData.code;
              session.couponDiscount = couponDiscountPaise;
            }

            // Total discount combines bulk + coupon
            session.discount = discountPaise + couponDiscountPaise;

            let final_product_name = "";
            for(let i=0;i<product_data.length;i++){
                final_product_name+=getProductName[product_data[i].product_retailer_id]+"("+product_data[i].quantity+")"+"\n";
            }
            if (bulkDiscountApplied && discountPaise > 0) {
              final_product_name += "Bulk Discount (20% OFF): -₹" + (discountPaise / 100).toFixed(2) + "\n";
            }
            if (couponData && couponDiscountPaise > 0) {
              final_product_name += `Coupon ${couponData.code} (${couponData.description}): -₹` + (couponDiscountPaise / 100).toFixed(2) + "\n";
            }
            final_product_name+="+ COD charge 150 + shipping charge"
            try {
              const chargesResp = await getDelhiveryCharges({
                origin_pin: DELHIVERY_ORIGIN_PIN,
                dest_pin: customerData.pincode || customerData.pin || '',
                cgm: total_wgt,
                pt: 'COD'
              });
              if (chargesResp) {
                
                const match = chargesResp[0].total_amount;
                console.log("----------> ", typeof match);
                
                if (match) {
                  // assume value in rupees if decimal or integer -> convert to paise
                  shippingChargePaise = Math.round(match * 100);
                } else {
                    session.cod_error = false;
                    console.warn('Could not reliably parse Delhivery charges response, defaulting shipping to 0. Response:', chargesResp);
                }
              }
            } catch (err) {
              session.cod_error = false;
              console.warn('Failed to get Delhivery charges, continuing with shippingChargePaise=0', err.message || err);
            }

            // Free shipping over threshold (audit fix M-17 — threshold from catalog).
            if (shouldWaiveShipping(session.amount)) {
              shippingChargePaise = 0;
            }

            session.amount = (session.amount || 0) + codChargePaise + shippingChargePaise;
            session.payment_mode = 'COD';
            session.shipping_charge = shippingChargePaise;

            // Build shipment object for Delhivery create.json
            const shipment = {
              name: customerData.name || 'Customer',
              add: `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
              pin: customerData.pincode || customerData.pin || '',
              city: "",
              state: "",
              country: 'India',
              phone: customerData.phone || from,
              order: `Order_${session.orderId || Date.now()}`,
              payment_mode: "COD",
              return_pin: "",
              return_city: "",
              return_phone: "",
              return_add: "",
              return_state: "",
              return_country: "",
              products_desc: final_product_name,
              hsn_code: "",
              cod_amount: String(Math.round(session.amount / 100)), // rupees
              order_date: null,
              total_amount: String(Math.round(session.amount / 100)), // rupees
              seller_add: "",
              seller_name: "",
              seller_inv: "",
              quantity: "",
              waybill: "",
              shipment_width: "",
              shipment_height: "",
              weight: total_wgt, // optional
              shipping_mode: "Surface",
              address_type: ""
            };
      
            let delhiveryResp = null;
            delhiveryResp = await createDelhiveryShipment({ shipment });
            console.log(`🚚 COD Shipment created for order ${session.orderId}, Amount: ₹${(session.amount/100).toFixed(2)}`);

            if(delhiveryResp.success && session.cod_error){
              // Send order to App Script (triggers emails and sheet storage)
            try {
              await sendOrderToAppScript({
                orderId: session.orderId || '',
                timestamp: new Date().toISOString(),
                name: customerData.name || '',
                email: customerData.email || '',
                phone: customerData.phone || from,
                address: `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
                pincode: customerData.pincode || '',
                city: customerData.city || '',
                state: customerData.state || '',
                productItems: session.productItems || [],
                paymentMode: 'COD',
                paymentStatus: 'Pending',
                paymentId: '',
                subtotal: ((session.amount - codChargePaise - session.shipping_charge) / 100),
                shippingCharge: (session.shipping_charge / 100),
                codCharge: (codChargePaise / 100),
                discount: (session.discount / 100),
                coupon: session.coupon || '',
                total: (session.amount / 100),
                delhiveryResponse: JSON.stringify(delhiveryResp || {})
              });
            } catch (err) {
              console.error('Failed to send COD order to App Script', err);
            }

            // Mark order as finalized to prevent duplicate processing
            session.finalized = true;

            let codConfirmMsg = `✅ Your COD order is placed.`;
            if (bulkDiscountApplied || couponDiscountPaise > 0) {
              codConfirmMsg += ` 🎉 Discounts applied!`;
              if (bulkDiscountApplied) {
                codConfirmMsg += ` Bulk Discount (20% OFF)`;
              }
              if (couponDiscountPaise > 0) {
                codConfirmMsg += bulkDiscountApplied ? ` + Coupon ${couponData.code} (${couponData.description})` : ` Coupon ${couponData.code} (${couponData.description})`;
              }
              codConfirmMsg += `!`;
            }
            codConfirmMsg += ` Total: ₹${(session.amount/100).toFixed(2)}. We'll notify you when it's shipped.`;
            await sendWhatsAppText(from, codConfirmMsg);
            console.log(`✅ COD order completed - Order: ${session.orderId}`);
            }
            else{
              // Mark as finalized even if failed
              session.finalized = true;
              await sendWhatsAppText(from, `✅ Data you enter in flow is incorrect, Make sure you enter vaid data`);
              console.log(`❌ COD order failed - Invalid data for order ${session.orderId}`);
            }

            return true; // Success
      } else {
      session.payment_mode = 'Prepaid';
      console.log(`💳 Prepaid order initiated - Order: ${session.orderId}, Amount: ₹${(session.amount/100).toFixed(2)}`);

      try {
        const customerPayload = {
          phone: customerData.phone || from,
          email: customerData.email,
          name: customerData.name
        };

        // send order_details message which triggers the Review & Pay UI in WhatsApp
        await sendWhatsAppOrderDetails(from, session);

        // optionally also send a textual confirmation
        await sendWhatsAppText(from, `💳 Please tap *Review and Pay* inside the order card above to complete payment. OrderId: ${session.orderId}`);

        // NOTE: We do NOT send to App Script here (no emails/sheet storage until payment is confirmed)
        // Data will be sent to App Script only after payment confirmation in finalizePaidOrder()

      } catch (err) {
        console.error('Failed to send order_details message', err.response?.data || err.message || err);
        await sendWhatsAppText(from, `⚠️ Could not initiate payment. Please try again later.`);
      }

      return true; // Success
      }
    }); // End acquireOrderLock callback

    // Check if lock was acquired and order was processed
    if (!orderResult) {
      console.log(`⚠️ Duplicate order blocked for ${from} - lock not acquired`);
      return res.sendStatus(200); // Return success to WhatsApp to prevent retries
    }

    return res.sendStatus(200);
  } // end flow handler

  // normal message handlers (unchanged)
   let replyText = '';
  let useInteractiveMessage = false;
  let buttons = [];
  let isButtonReply = false;
  try {
    


    if (msg.interactive && msg.interactive.button_reply) {
    msgBody = msg.interactive.button_reply.title.toLowerCase().trim();
    isButtonReply = true;
  } else if (msg.text && msg.text.body) {
    msgBody = msg.text.body.toLowerCase().trim();
  }

  console.log(`📩 Message from ${from}: "${msgBody}"`);

  const intentResponse = findIntentBasedResponse(msgBody);
  

  if (msgBody === 'main menu') {
      await sendWhatsAppList(from);
      
  }
  else if(msgBody === 'Main Menu') {
      await sendWhatsAppList(from);
      
  }
  else if (intentResponse) {
    replyText = intentResponse.answer;
    if (intentResponse.intents && intentResponse.intents.length > 0) {
      useInteractiveMessage = true;
      buttons = intentResponse.intents.map(intent => ({
        id: intent.toLowerCase().replace(/\s+/g, '_'),
        title: intent
      }));
    }
  }
  
else if (/\b\d{14}\b/.test(msgBody)) {
  const awbMatch = msgBody.match(/\b\d{14}\b/);

  if (awbMatch) {
    const awb = awbMatch[0];
    console.log(`📦 Detected AWB: ${awb} from ${from}`);

    await sendWhatsAppTrackingCTA(from, awb);
  }
}

    else if (msgBody === 'hi' || msgBody === 'hello' || msgBody === 'hey') {
    // ];
    await sendWhatsAppList(from);
    
  }else if (/why people love us/i.test(msgBody) || /back 2 y ppl <3 us/i.test(msgBody) || /Why People Love Us/i.test(msgBody)) {
      await sendWhyPeopleLoveUs(from);
      
  } else if (/recipes/i.test(msgBody)) {
      await sendrecipes(from);
      
  }



  else if (/where we’re from/i.test(msgBody)) {
      await sendwherewe(from);
    
  }
  else if (/why it matters/i.test(msgBody)) {
      await sendmatters(from);
    
  }
  else if (/trace your products/i.test(msgBody)) {
      await sendtraceprod(from);
    
  }
  else if (/how it works/i.test(msgBody)) {
      await sendhowitworks(from);
    
  }
  else if (/explore/i.test(msgBody) || /back2 shop & explore/i.test(msgBody)) {
      await sendshopandexplore(from);
    
  }
  else if (/customer reviews/i.test(msgBody)) {
      await sendcustreview(from);
    
  }
  else if (/track your order/i.test(msgBody)) {
      sendWhatsAppText(from, 'Please type your 14 digit AWB in chat')
  }

  else if (/farmer impact/i.test(msgBody)) {
      await sendfarmerimpact(from);
    
  }
  
  else if (/sourcing story/i.test(msgBody) || /back2 sourcing story/i.test(msgBody)) {
      await sendWhatsAppList_ss(from);
      
  }
  else if (/nutrition info/i.test(msgBody) || /back 2 nutri info/i.test(msgBody)) {
      await sendWhatsAppList_ni(from);
      
  }
  else if (/view products/i.test(msgBody)) {
      await sendWhatsAppCatalog(from);
      
  } else if (/have a query/i.test(msgBody)) {
    useInteractiveMessage = true;
      await sendWhatsAppTemplate(from);
      
  }
  // PRIORITY 3: Handle other common responses
  else if (msgBody.includes('how are you')) {
    replyText = `We're flourishing like the alpine blooms at Gangotri! 😊 How can we assist you today?`;
  } 
  else if (msgBody === 'fine') {
    replyText = `Glad to hear you're doing fine! At 2,300 m, our small-holder farmers nurture each seed with care. Would you like to learn about our traceability or geo-seed mapping?`;
  } 
  else if (msgBody.includes('thank you') || msgBody.includes('thanks')) {
    replyText = `You're most welcome! Supporting Gangotri valley farmers means the world to us. Let us know if you'd like to know more about our ethical sourcing.`;
  } 
  else if (['awesome', 'amazing', 'great'].some(word => msgBody.includes(word))) {
    replyText = `That's wonderful to hear! Just like our wild tempering spice—harvested ethically at altitude—your enthusiasm warms our hearts. 😊`;
  }
   else if (msg.type === "order" || msgBody === "order_received") {
      const phoneKeySession = orderSessions[from] || {};
      phoneKeySession.catalogId = msg.order?.catalog_id;
      phoneKeySession.productItems = msg.order?.product_items || [];

      let totalAmount = 0;
      for (const item of phoneKeySession.productItems) {
        const priceRupees = parseFloat(item.item_price) || 0;
        const qty = parseInt(item.quantity, 10) || 1;
        totalAmount += priceRupees * 100 * qty;
      }
      phoneKeySession.amount = totalAmount; // in paise
      // Stamp createdAt on first cart-add so the hourly cleanup measures
      // age from the customer's first interaction, not from update time.
      // Missing createdAt used to make sessionAge = now - 0 → the draft was
      // nuked on the next cleanup pass, silently breaking the cart flow if
      // the customer took >1 min between add-to-cart and delivery-info
      // (audit fix M-10).
      if (!phoneKeySession.createdAt) phoneKeySession.createdAt = Date.now();
      orderSessions[from] = phoneKeySession;

      console.log(`🛒 Cart received from ${from} - Items: ${phoneKeySession.productItems.length}, Total: ₹${(totalAmount/100).toFixed(2)}`);

      // Send Flow for delivery info
      await sendWhatsAppFlow(from, FLOW_ID);
      await sendWhatsAppText(from, "Please tap the button above and provide your delivery details.");
    } else if (await isRemindedButNotCompleted(from)) {
  const emailMatch = msgBody.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const words = msgBody.split(/\s+/);

  if (emailMatch && words.length >= 2) {
    const email = emailMatch[0];
    let name = msgBody.split(email)[0].trim();

    // Clean connectors and extra symbols
    name = name.replace(/\b(and|&|,)\b/gi, '').trim();

    // Capitalize first letter of each word (optional, makes it look nice)
    name = name
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    await markUserCompleted(from); // ✅ mark as done (H-08: Firebase-backed, restart-durable)

    // Note: Customer contact collection (non-order) removed - can be handled separately if needed

    await sendWhatsAppText(from, `✅ Thanks ${name}! We've saved your details.`);
    console.log(`💾 Contact info received from ${from}: ${name}, ${email}`);
  }
}
    
    
    
    
    
    else {
      replyText = `At OrangUtan Organics, we stand against mislabelling and broken traceability. We empower local small‐holders, guarantee genuine Himalayan origin, and protect seeds via geo‐mapping. Say "Hi"`;
    }
  } catch (err) {
    console.error("Handler error:", err.response?.data || err);
  }
  try {
    if (replyText && replyText.trim()) {
      if (useInteractiveMessage && buttons.length > 0) {
        await sendWhatsAppInteractiveMessage(from, replyText, buttons);
        console.log(`📤 Interactive message sent to ${from} with ${buttons.length} buttons`);
      } else {
        await sendWhatsAppText(from, replyText);
      }
    }
  } catch (err) {
    console.error('❌ Error sending message:', err.response?.data || err.message);
  }

  res.sendStatus(200);
  } catch (err) {
    console.error('❌ CRITICAL: Unhandled error in main webhook handler:', err);
    console.error('Stack:', err.stack);
    // Always return 200 to WhatsApp to prevent retries
    res.sendStatus(200);
  }
});

// ---------------- Delhivery Webhook Endpoint ----------------
// Sender authentication removed at operator request. The endpoint is
// UNAUTHENTICATED — any caller can POST a Delhivery-shaped payload and
// trigger customer WhatsApp notifications for any AWB they can guess.
// Consider re-enabling verification, or fronting with an nginx IP allowlist
// scoped to Delhivery's egress ranges.
//
// Remaining defenses in this handler:
//   1. delhiveryWebhookRateLimiter caps this endpoint at 120 rpm globally.
//   2. Event-level idempotency (waybill + status + eventTime) blocks retry
//      storms and identical-POST floods from double-processing.
//   3. Notification-level idempotency (waybill + status) caps outbound
//      WhatsApp at one per status transition per customer, so any single
//      forged transition can trigger at most one message per customer.
app.post('/delhivery-webhook', delhiveryWebhookRateLimiter, async (req, res) => {
  try {
    const sourceIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const webhookData = req.body || {};

    // ---- Field extraction with fallback field names ----
    // Delhivery's payload field names vary by event type; support the union
    // observed across manifest / in-transit / out-for-delivery / delivered.
    const awb = webhookData.waybill || webhookData.awb || webhookData.tracking_id;
    const status = String(webhookData.status || webhookData.Status || '').toLowerCase();
    const customerPhone = webhookData.consignee_phone || webhookData.phone;
    const customerName = webhookData.consignee_name || webhookData.name || 'Customer';
    const eventTime = webhookData.status_datetime
      || webhookData.event_time
      || webhookData.status_date
      || webhookData.pickup_scan_time
      || '';

    if (!awb) {
      console.warn(`[delhivery-webhook] rejected: missing AWB/waybill. ip=${sourceIp}`);
      return res.status(400).json({ error: 'Missing AWB/waybill' });
    }
    if (!customerPhone) {
      console.warn(`[delhivery-webhook] rejected: missing customer phone. awb=${awb}`);
      return res.status(400).json({ error: 'Missing customer phone' });
    }

    const normalizedPhone = normalizePhone(customerPhone);

    // ---- Event-level idempotency (drop duplicate webhook invocations) ----
    const eventKey = `${awb}|${status}|${eventTime}`;
    try {
      if (await isDelhiveryEventProcessed(eventKey)) {
        console.log(`[delhivery-webhook] duplicate_event skipped. key=${eventKey}`);
        return res.status(200).json({ success: true, deduped: true, level: 'event' });
      }
    } catch (dedupErr) {
      // Don't let a Firebase blip block the handler — log and proceed.
      // We may over-process once; that's better than blocking legitimate events.
      console.warn(`[delhivery-webhook] event-dedup check failed for ${eventKey}: ${dedupErr.message}. Proceeding.`);
    }

    // Mark the event as processed BEFORE side effects so concurrent retries
    // from Delhivery collapse to a single processing attempt.
    try {
      await markDelhiveryEventProcessed(eventKey, {
        awb,
        status,
        eventTime,
        phone: normalizedPhone,
      });
    } catch (markErr) {
      console.error(`[delhivery-webhook] failed to mark event processed (key=${eventKey}): ${markErr.message}`);
      // Continue — this is not fatal for a single request.
    }

    // ---- Map status → customer message ----
    let messageText = '';
    let shouldSendUpdate = false;

    if (status.includes('manifest') || status.includes('pending')) {
      messageText = `Hello ${customerName}! 📦\n\nYour order has been manifested and is being prepared for shipment.\n\nYou can track your order using the link below:`;
      shouldSendUpdate = true;
    } else if (status.includes('in transit') || status.includes('intransit') || status.includes('in_transit')) {
      messageText = `Hello ${customerName}! 🚚\n\nGood news! Your order is now in transit and on its way to you.\n\nTrack your shipment here:`;
      shouldSendUpdate = true;
    } else if (status.includes('out for delivery') || status.includes('out_for_delivery') || status.includes('dispatched')) {
      messageText = `Hello ${customerName}! 🛵\n\nExciting news! Your order is out for delivery and will reach you soon today.\n\nTrack your delivery here:`;
      shouldSendUpdate = true;
    } else if (status.includes('delivered')) {
      messageText = `Hello ${customerName}! ✅\n\nYour order has been successfully delivered!\n\nThank you for choosing OrangUtan Organics. We hope you enjoy your Himalayan products! 🌱\n\nView delivery details:`;
      shouldSendUpdate = true;
    } else {
      console.log(`[delhivery-webhook] unhandled_status status="${status}" awb=${awb}`);
    }

    if (!shouldSendUpdate) {
      return res.status(200).json({ success: true, message: 'Processed, no notification for this status' });
    }

    // ---- Notification-level idempotency (one WhatsApp per waybill+status) ----
    try {
      if (await hasDelhiveryUpdateBeenSent(awb, status)) {
        console.log(`[delhivery-webhook] notification_already_sent awb=${awb} status=${status} — skipping send`);
        return res.status(200).json({ success: true, deduped: true, level: 'notification' });
      }
    } catch (dedupErr) {
      // Same posture as event-dedup: log and proceed. Better to send twice
      // than block legitimate transitions.
      console.warn(`[delhivery-webhook] notification-dedup check failed for ${awb}|${status}: ${dedupErr.message}. Proceeding.`);
    }

    // ---- Send outbound WhatsApp ----
    let textSent = false;
    let ctaSent = false;
    try {
      textSent = await sendWhatsAppText(normalizedPhone, messageText);
      ctaSent = await sendWhatsAppTrackingCTA(normalizedPhone, awb);
    } catch (sendErr) {
      console.error(`[delhivery-webhook] whatsapp_send_error awb=${awb} status=${status}: ${sendErr.message}`);
      // Return 200 to Delhivery — retrying the webhook wouldn't fix a
      // WhatsApp-side problem, but leave the notification marker UNSET so
      // an operator can manually re-fire the notification later if needed.
      return res.status(200).json({ success: true, message: 'Processed with send error' });
    }

    // Mark as sent only if the text send succeeded. sendWhatsAppText returns
    // false on WhatsApp API errors; treat that as "not sent" so a later
    // notification attempt (from an operator or a Delhivery retry outside
    // the notification-dedup window) can try again.
    if (textSent) {
      try {
        await markDelhiveryUpdateSent(awb, status, {
          phone: normalizedPhone,
          eventTime,
          ctaSent,
        });
      } catch (markErr) {
        console.error(`[delhivery-webhook] failed to mark notification sent for ${awb}|${status}: ${markErr.message}`);
      }
      console.log(`✅ [delhivery-webhook] notification_sent awb=${awb} status=${status} phone=${normalizedPhone} cta=${ctaSent}`);
    } else {
      console.warn(`[delhivery-webhook] send_reported_false awb=${awb} status=${status} — notification NOT marked (will retry)`);
    }

    return res.status(200).json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    console.error('[delhivery-webhook] unhandled error:', error.response?.data || error.message || error);
    // Return 500 so Delhivery retries — this covers transient issues we
    // couldn't classify (e.g. Firebase outage that broke the whole handler).
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------- Razorpay payments webhook (bot-flow finalizer) ----------------
// Receives Razorpay webhook events for WhatsApp-bot-initiated payments and
// runs the bot's finalizePaidOrder flow (WhatsApp confirmations, Delhivery
// shipment, Sheets row, admin email). Website-initiated payments (notes.source
// === 'website') are handled by /api/razorpay/webhook in website/razorpay.js
// — this handler short-circuits them below.
//
// SECURITY (fix for audit finding C-04):
//   1. paymentsWebhookRateLimiter caps this endpoint at 60 rpm globally
//      (across all source IPs). Razorpay never bursts higher than ~20 rpm.
//   2. verifyRazorpayWebhookSignature verifies X-Razorpay-Signature via
//      HMAC-SHA256 under RAZORPAY_WEBHOOK_SECRET, in constant time.
//   3. Any request that fails either check is rejected BEFORE Firebase reads
//      or business logic runs.
app.post('/payments-webhook', paymentsWebhookRateLimiter, async (req, res) => {
  try {
    // ---- Signature verification (fail closed) ----
    // Do this BEFORE anything else — no Firebase reads, no state changes, no
    // logging of payload contents. An unsigned request has no business
    // reaching further into this handler.
    const sigHeader = req.get('X-Razorpay-Signature');
    const sourceIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const sigResult = verifyRazorpayWebhookSignature(req.rawBody, sigHeader);

    if (!sigResult.ok) {
      if (sigResult.reason === 'secret_missing') {
        // Server-side misconfiguration. Return 503 so Razorpay retries with
        // backoff — we may be minutes away from fixing the env.
        console.error(`❌ [payments-webhook] rejected: reason=secret_missing ip=${sourceIp} ua="${userAgent}"`);
        return res.status(503).json({ success: false, message: 'Webhook secret not configured on server' });
      }
      // All other reasons are authentication failures. Return 401.
      console.error(`❌ [payments-webhook] rejected: reason=${sigResult.reason} ip=${sourceIp} ua="${userAgent}" hasHeader=${Boolean(sigHeader)}`);
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    // ---- End signature verification ----

    // Validate request body
    if (!req.body) {
      console.warn('⚠️ Invalid payment webhook payload received');
      return res.sendStatus(200);
    }

    const body = req.body;
    const event = body.event;

  const payment = req.body.payload?.payment?.entity;
  const payment_link = req.body.payload?.payment_link?.entity;

  // Get payment ID for idempotency check
  const paymentId = payment?.id || payment_link?.id || null;

  // Website-sourced payments (notes.source === 'website') are handled by the
  // dedicated /api/razorpay/webhook route with signature verification. If
  // Razorpay is currently configured to deliver here, we just acknowledge and
  // stand down — the other handler (or client-initiated process-prepaid) will
  // do the fulfillment. Silences the "Could not find reference ID" noise.
  const notesSource = payment?.notes?.source || payment_link?.notes?.source || null;
  if (notesSource === 'website') {
    const websiteOrderId = payment?.notes?.orderId || payment_link?.notes?.orderId || null;
    console.log(`↪️ Payments webhook: website-sourced payment (orderId=${websiteOrderId}, paymentId=${paymentId}) — handled by /api/razorpay/webhook. Acknowledging.`);
    return res.sendStatus(200);
  }

  // IDEMPOTENCY CHECK: Prevent duplicate processing (FIREBASE)
  if (paymentId) {
    const alreadyProcessed = await isPaymentProcessed(paymentId);
    if (alreadyProcessed) {
      console.log(`⚠️ Payment webhook already processed in Firebase for payment ID: ${paymentId}. Skipping duplicate.`);
      return res.sendStatus(200); // Return success to stop Razorpay retries
    }
  }

  // Get reference ID (order ID)
  const referenceId = payment_link?.reference_id || payment?.reference_id || payment?.notes?.orderId || null;

  // Log webhook for debugging (only in development or first few times)
  if (process.env.NODE_ENV === 'development' || !referenceId) {
    console.log(`🔍 Full payment webhook payload:`, JSON.stringify(body, null, 2));
  }

  const status = event?.toLowerCase() || '';

  if (!referenceId) {
    console.warn('⚠️ Payments webhook: Could not find reference ID in payload');
  }

  console.log(`💳 Payment webhook - Reference ID: ${referenceId}, Status: ${status}, Payment ID: ${paymentId}`);

  let session = null;
  if (referenceId && orderSessions[referenceId]) {
    session = orderSessions[referenceId];
  } else {
    // fallback: attempt to find session by phone in webhook payload
    let phone = "";
    if (payment) {
      phone = normalizePhone(payment.contact);
    }
    if (!phone && payment_link?.customer?.contact) phone = normalizePhone(payment_link.customer.contact);
    if (phone && phoneToOrderIds[phone] && phoneToOrderIds[phone].length) {
      const lastOrderId = phoneToOrderIds[phone][phoneToOrderIds[phone].length - 1];
      session = orderSessions[lastOrderId];
      console.warn("Fallback session found via phone mapping. orderId:", lastOrderId);
    }
  }
  if (!session) {
    console.warn('⚠️ Payments webhook: no session for reference id', referenceId);
    return res.sendStatus(200);
  }

  // Fast-path duplicate check (per-worker, non-authoritative).
  // Authoritative duplicate-detection is layered above and below this block:
  //   1) Firebase isPaymentProcessed(paymentId) already ran ~40 lines above
  //      and returned false for us — cross-worker safe (paymentId globally
  //      unique, Firebase-backed).
  //   2) Firebase runTransaction inside tryStartFulfillment (invoked by
  //      finalizePaidOrder → shared/firebase.js:288) is the authoritative
  //      cross-worker fulfillment lock — even if two workers pass this
  //      in-memory check simultaneously, only one wins the transaction
  //      and the other returns { status: 'in_progress' } and stands down.
  // This flag is retained purely to short-circuit obvious same-worker
  // duplicates without paying the Firebase round-trip for finalizePaidOrder.
  // Audit fix M-11: the actual race the audit called out was closed by H-02
  // (see finalizePaidOrder → tryStartFulfillment); do NOT rely on
  // session.processing for correctness under multi-worker deploys.
  if (session.finalized || session.payment_status === 'completed' || session.processing) {
    console.log(`⚠️ Order ${session.orderId} already finalized or in-flight on this worker. Skipping duplicate webhook.`);
    return res.sendStatus(200); // Return success to stop retries
  }

  if (status.includes('paid')) {
    console.log(`✅ Payment successful - Order: ${session.orderId}`);

    // Per-worker fast-path flag (see comment above the outer check). The
    // authoritative cross-worker lock is acquired inside finalizePaidOrder
    // via tryStartFulfillment's Firebase runTransaction.
    session.processing = true;
    session.processingStartedAt = Date.now();

    try {
      const outcome = await finalizePaidOrder(session, body);

      // Interpret the outcome. Only mark session.finalized=true (and mark the
      // paymentId as processed) when fulfillment actually completed. On any
      // error, leave both flags UNSET so a subsequent webhook retry (or the
      // payment being re-fired on Razorpay's schedule) can complete the
      // missing step against the pending record. Fix for audit finding H-02.
      if (outcome.status === 'fulfilled' || outcome.status === 'already_fulfilled') {
        session.payment_status = 'completed';
        session.finalized = true;
        session.finalizedAt = Date.now();
        session.processing = false;
        if (paymentId) {
          await markPaymentAsProcessed(paymentId);
          console.log(`✅ Payment ID ${paymentId} marked as processed in Firebase at ${new Date().toISOString()}`);
        }
      } else if (outcome.status === 'in_progress') {
        // A concurrent webhook is already fulfilling this order. Don't touch
        // session state; the other worker will mark it. Don't mark paymentId
        // processed either — if the other worker fails, we want retries.
        console.log(`⏳ Order ${session.orderId} fulfillment already in progress; standing down`);
        session.processing = false;
      } else {
        // outcome.status === 'error'
        console.error(`❌ Fulfillment error for order ${session.orderId}: stage=${outcome.stage} — ${outcome.message}`);
        session.processing = false;
        session.processingError = `${outcome.stage}: ${outcome.message}`;
        // Deliberately do NOT set session.finalized = true. The
        // failed_fulfillment record in Firebase captures the exact stage of
        // the failure for retry (via a later webhook, a scheduled sweep, or
        // a manual operator script).
      }
    } catch (err) {
      // finalizePaidOrder should return { status: 'error', ... } for expected
      // failures; catching here handles truly unexpected exceptions.
      console.error('❌ Unhandled exception in finalizePaidOrder:', err);
      session.processing = false;
      session.processingError = err.message;
      // Don't rethrow - we want to return 200 to prevent Razorpay retry storms.
    }
  } else if (status.includes('failed') || status.includes('cancel') || status.includes('expired')) {
    session.payment_status = 'failed';
    console.log(`❌ Payment ${status} - Order: ${session.orderId}`);
    await sendWhatsAppText(session.phone, "⚠️ Your payment failed or expired. Please try placing the order again.");

    // Mark payment as processed even for failed payments to prevent retries (FIREBASE)
    if (paymentId) {
      await markPaymentAsProcessed(paymentId);
    }
  }

  res.sendStatus(200);
  } catch (err) {
    console.error('❌ CRITICAL: Unhandled error in payments webhook handler:', err);
    console.error('Stack:', err.stack);
    // Always return 200 to prevent retries
    res.sendStatus(200);
  }
});


// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================

// 404 handler — Route not found. Uses the canonical envelope from
// shared/response.js (audit fix M-14) while preserving the legacy `path`
// field at top-level for existing clients.
app.use((req, res) => {
  respondError(res, {
    status: 404,
    code: 'route_not_found',
    message: 'Route not found',
    legacy: { path: req.originalUrl },
  });
});

// Global error handler — catches all errors. Emits the canonical envelope
// (audit fix M-14). CORS-rejection errors set err.status = 403 (see H-10);
// other framework errors set err.statusCode. Default to 500 for unknowns
// and never leak internal error details in that case.
app.use((err, _req, res, _next) => {
  console.error('❌ Global error handler caught an error:');
  console.error('Error:', err.name, err.message);
  console.error('Stack:', err.stack);

  const statusCode = err.statusCode || err.status || 500;
  const isServerError = statusCode >= 500;
  const publicMessage = isServerError ? 'Internal server error' : (err.message || 'Request failed');
  const code = err.code || (isServerError ? 'internal_error' : 'request_error');

  respondError(res, {
    status: statusCode,
    code: String(code),
    message: publicMessage,
    legacy: process.env.NODE_ENV === 'development'
      ? { error: err.message, stack: err.stack }
      : {},
  });
});

// ---------------- Start ----------------
// Capture the server handle so drainAndExit() can call server.close()
// on SIGTERM/SIGINT for a clean shutdown. Reassigns the module-scoped
// httpServer declared near the shutdown handlers above.
httpServer = app.listen(PORT, () => console.log(`Bot running on :${PORT}`));