// shared/response.js
// -----------------------------------------------------------------------------
// Canonical JSON response shape (audit fix M-14).
//
// PURPOSE
//   Give every internal API route a single, consistent envelope:
//     { ok: boolean, data?: any, error?: { code: string, message: string } }
//
//   Legacy consumers that read `success` / `message` at the top level continue
//   to work — those fields are emitted alongside the canonical ones during the
//   soft-migration window. Remove the legacy fields in a future major once
//   frontend/integrations have moved to `ok` / `data` / `error`.
//
// SCOPE
//   Use for INTERNAL API routes (frontend-facing). DO NOT use for:
//     * Webhooks (Meta / Razorpay / Delhivery) — those have external contracts
//       and must return exactly what the sender expects (usually just 200).
//     * /health — external monitors likely parse the current
//       {status, message, timestamp, environment} shape verbatim.
//
// RATIONALE for the legacy-alongside-canonical pattern
//   Rewriting all ~50 response sites without coordinating the frontend is a
//   breaking change. Emitting both fields lets us adopt the canonical shape
//   in the two safe places today (404 + global error handler), and migrate
//   per-route on the frontend team's schedule.
// -----------------------------------------------------------------------------

/**
 * Emit a canonical JSON response.
 *
 * @param {import('express').Response} res
 * @param {object}  opts
 * @param {number}  [opts.status=200]  HTTP status to set.
 * @param {boolean} opts.ok            true for success, false for error.
 * @param {*}       [opts.data]        Success payload. Placed under `data`
 *                                     AND spread at top-level via `legacy`
 *                                     if the caller wants existing consumers
 *                                     to keep reading top-level fields.
 * @param {object}  [opts.error]       Error object. Must have { code, message }.
 * @param {object}  [opts.legacy]      Extra top-level fields to preserve for
 *                                     backward-compat (e.g. { orderId, waybill }).
 *                                     Prefer moving these to `data` in new code.
 * @returns {import('express').Response}
 */
export function respond(res, { status = 200, ok, data, error, legacy = {} } = {}) {
  if (typeof ok !== 'boolean') {
    throw new Error('respond: `ok` must be an explicit boolean');
  }
  if (!ok && (!error || typeof error.code !== 'string' || typeof error.message !== 'string')) {
    throw new Error('respond: `error` must be { code: string, message: string } when ok=false');
  }

  const body = {
    ok,
    // Canonical fields.
    ...(data !== undefined ? { data } : {}),
    ...(error !== undefined ? { error } : {}),

    // Legacy backward-compat fields. Remove when all clients migrated.
    success: ok,
    ...(error?.message ? { message: error.message } : {}),
    ...legacy,
  };

  return res.status(status).json(body);
}

/**
 * Convenience wrapper for error responses. Emits { ok: false, error: {code, message} }
 * plus legacy { success: false, message } for backward compat.
 */
export function respondError(res, { status = 500, code, message, legacy = {} } = {}) {
  if (typeof code !== 'string' || !code) {
    throw new Error('respondError: `code` (string) is required');
  }
  if (typeof message !== 'string' || !message) {
    throw new Error('respondError: `message` (string) is required');
  }
  return respond(res, { status, ok: false, error: { code, message }, legacy });
}
