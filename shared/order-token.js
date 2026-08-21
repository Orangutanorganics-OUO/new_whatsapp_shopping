// shared/order-token.js
// -----------------------------------------------------------------------------
// Fulfillment token — caller-bound capability that proves the client
// mutating a pending order is the same client that originally created it.
//
// PURPOSE (audit finding H-01)
//   Even after C-06's status-based hardening, an attacker who guesses a
//   website orderId can still hijack the pending record during its
//   'pending_payment' window (create-order retry, verify-payment,
//   process-prepaid lazy-create, process-cod lazy-create). A per-order
//   token generated on first materialization and required on every
//   subsequent mutating call closes that window.
//
// TOKEN SPEC
//   - 32 bytes from crypto.randomBytes, encoded base64url.
//   - 256 bits of entropy. Well beyond any practical guessing horizon.
//   - Never logged verbatim; logs record only { checked, reason }.
//   - Compared with crypto.timingSafeEqual after a length guard.
//
// LIFECYCLE
//   - Generated once when the pending record is FIRST materialized.
//     (create-order for prepaid; first process-cod call for COD.)
//   - Returned to the client in the response of that first call.
//   - Required in the request body on every subsequent mutating call for
//     the same orderId (create-order retry, verify-payment, process-prepaid,
//     process-cod retry).
//   - Never rotated. Lives for the lifetime of the pending order.
//
// GRANDFATHERING
//   Records that exist without a fulfillmentToken (created before this
//   module shipped) are treated as legacy — no check applies. They age
//   out within 24-48h under normal traffic and are replaced by
//   fully-tokened records.
//
// -----------------------------------------------------------------------------

import crypto from 'crypto';

// ============================================================================
// ENFORCEMENT MODE (env-driven, same pattern as C-03/C-05)
// ============================================================================
//   strict — 403 on missing/wrong token when the record has one
//   warn   — (default) log the mismatch, proceed with the request
//   off    — skip validation entirely (legacy behaviour; emergency only)
const RAW_MODE = String(process.env.FULFILLMENT_TOKEN_MODE || 'warn').toLowerCase().trim();
export const FULFILLMENT_TOKEN_MODE = ['strict', 'warn', 'off'].includes(RAW_MODE) ? RAW_MODE : 'warn';
if (RAW_MODE !== FULFILLMENT_TOKEN_MODE && RAW_MODE) {
  console.warn(`⚠️ [order-token] FULFILLMENT_TOKEN_MODE="${RAW_MODE}" is invalid; defaulting to "warn"`);
}
console.log(`[order-token] fulfillment token mode: ${FULFILLMENT_TOKEN_MODE}`);

// ============================================================================
// GENERATION + CONSTANT-TIME VERIFY
// ============================================================================

/** 32 random bytes as base64url. Called on first materialization only. */
export function generateFulfillmentToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Length-guarded, constant-time compare. Never throws. Returns boolean.
 * Non-string inputs are treated as an automatic mismatch.
 */
export function verifyFulfillmentToken(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  if (supplied.length === 0 || expected.length === 0) return false;
  if (supplied.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(supplied, 'utf8'),
      Buffer.from(expected, 'utf8'),
    );
  } catch {
    return false;
  }
}

// ============================================================================
// ENFORCEMENT (used by every mutating route)
// ============================================================================

/**
 * Central token enforcement. Handles all four states in one call:
 *
 *   - record has no token (grandfathered)      → { ok: true, checked: false, reason: 'no_token_on_record' }
 *   - record has token, mode=off               → { ok: true, checked: false, reason: 'mode_off' }
 *   - record has token, supplied matches       → { ok: true, checked: true,  reason: 'match' }
 *   - record has token, supplied missing/wrong → mode-dependent:
 *       warn:   { ok: true,  checked: true, reason: 'missing_warn' | 'mismatch_warn' }
 *       strict: { ok: false, code: 'fulfillment_token_invalid', message, reason: 'missing_strict' | 'mismatch_strict' }
 *
 * @param {object} args
 * @param {object} args.pendingRecord  The Firebase pending order record.
 * @param {string} args.suppliedToken  Value from req.body.fulfillmentToken (may be undefined).
 * @param {string} args.routeTag       Short tag for log lines ('create-order', 'process-prepaid', etc).
 * @param {string} args.requestId      Correlation id for log lines.
 */
export function enforceFulfillmentToken({ pendingRecord, suppliedToken, routeTag, requestId }) {
  const expected = pendingRecord?.fulfillmentToken;
  if (!expected) {
    return { ok: true, checked: false, reason: 'no_token_on_record' };
  }
  if (FULFILLMENT_TOKEN_MODE === 'off') {
    return { ok: true, checked: false, reason: 'mode_off' };
  }

  const supplied = typeof suppliedToken === 'string' ? suppliedToken : '';
  if (verifyFulfillmentToken(supplied, expected)) {
    return { ok: true, checked: true, reason: 'match' };
  }

  const failureReason = supplied ? 'mismatch' : 'missing';
  const orderId = pendingRecord?.orderId || '<unknown>';

  if (FULFILLMENT_TOKEN_MODE === 'warn') {
    console.warn(`[${requestId}] [${routeTag}] fulfillmentToken ${failureReason} for orderId=${orderId} — proceeding (warn mode)`);
    return { ok: true, checked: true, reason: `${failureReason}_warn` };
  }

  // strict
  console.warn(`[${requestId}] [${routeTag}] fulfillmentToken ${failureReason} for orderId=${orderId} — REJECTED (strict mode)`);
  return {
    ok: false,
    code: 'fulfillment_token_invalid',
    message: `Invalid or missing fulfillmentToken for order ${orderId}`,
    reason: `${failureReason}_strict`,
  };
}
