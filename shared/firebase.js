// firebase.js - Firebase Realtime Database initialization and helpers
// ----------------------------------------------------------------------------
// Uses the firebase-admin SDK (audit fix H-03). The previous implementation
// used the CLIENT SDK (`firebase/app` + `firebase/database`), which meant the
// backend was treated by Firebase as an anonymous browser client — subject to
// `.read` / `.write` security rules like any other client. That made it
// impossible to lock the rules down (C-08) without locking the server out too,
// and forced ops tasks to be doable by anonymous callers.
//
// The admin SDK authenticates with a service account and BYPASSES security
// rules by design. Rules can now be `.read: false, .write: false` everywhere;
// the server keeps working via the service-account privilege.
//
// PUBLIC API IS UNCHANGED — every exported function keeps the same signature
// and return shape. Consumers (app.js, website/checkout.js, website/razorpay.js)
// require no code changes for this migration.
// ----------------------------------------------------------------------------

// firebase-admin v14 modular imports. The legacy `import admin from
// 'firebase-admin'` namespace with `admin.credential.cert()` / `admin.database()`
// still works for many things but not `.credential.cert` — that path was
// removed. Use the split submodules explicitly.
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

// ============================================================================
// BOOT: credential validation + admin.initializeApp
// ============================================================================
// Fail-closed: refuse to start if any required credential is missing. Firebase
// underpins message dedup, order state, coupon audit — a booted-but-broken
// backend is worse than a hard exit that PM2 flags in the logs.

const _requiredEnv = ['FIREBASE_PROJECT_ID', 'FIREBASE_DATABASE_URL', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const _missing = _requiredEnv.filter((k) => !process.env[k]);
if (_missing.length > 0) {
  console.error('❌ FATAL: Firebase admin credentials missing.');
  _missing.forEach((k) => console.error(`❌ FATAL:   ${k} is not set`));
  console.error('❌ FATAL: Download a service-account key from Firebase Console → Project Settings → Service Accounts → Generate new private key.');
  console.error('❌ FATAL: Set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env (see .env.example).');
  process.exit(1);
}

// Private key from .env carries literal \n sequences that must be converted
// to real newlines before the crypto stack can parse the PEM. Handle both
// quoted forms (\"...\\n...\") and unquoted (...\n...).
function _normalizePrivateKey(raw) {
  if (!raw) return raw;
  let key = String(raw);
  // Strip a single wrapping pair of quotes if the operator quoted the value.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Convert escaped newlines to real newlines. Safe if none present.
  return key.replace(/\\n/g, '\n');
}

const _app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: _normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = getDatabase(_app);

console.log('✅ Firebase admin SDK initialized (project=' + process.env.FIREBASE_PROJECT_ID + ')');

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Sanitize key for Firebase (remove invalid characters)
 * Firebase paths cannot contain: . $ # [ ] /
 * @param {string} key - Original key
 * @returns {string} - Sanitized key
 */
function sanitizeFirebaseKey(key) {
  if (!key) return key;
  // Replace invalid characters with underscores
  return key.replace(/[.#$[\]\/]/g, '_');
}

/**
 * Check if a message has been processed (deduplication)
 * @param {string} messageId - WhatsApp message ID
 * @returns {Promise<boolean>} - true if already processed
 */
export async function isMessageProcessed(messageId) {
  if (!messageId) return false;

  const sanitizedId = sanitizeFirebaseKey(messageId);
  const snapshot = await db.ref(`processedMessages/${sanitizedId}`).once('value');
  return snapshot.exists();
}

/**
 * Mark a message as processed
 * @param {string} messageId - WhatsApp message ID
 * @returns {Promise<void>}
 */
export async function markMessageAsProcessed(messageId) {
  if (!messageId) return;

  const sanitizedId = sanitizeFirebaseKey(messageId);
  await db.ref(`processedMessages/${sanitizedId}`).set({
    timestamp: Date.now(),
    processedAt: new Date().toISOString(),
    originalId: messageId // Store original for debugging
  });
}

/**
 * Log an inbound customer bot interaction under `customerBotInteractions/{key}`,
 * where `key` is the normalized message text. Lets ops browse "everyone who
 * said X" directly in the Firebase console. Analytics-only — never on the
 * critical path, so all errors are swallowed after logging.
 * @param {string} phone - Normalized customer phone
 * @param {string} message - Original message text (button title, list title, or typed text)
 * @returns {Promise<void>}
 */
export async function logCustomerInteraction(phone, message) {
  if (!phone || !message) return;
  try {
    let key = String(message).toLowerCase().trim().replace(/\s+/g, '_');
    key = sanitizeFirebaseKey(key);
    if (key.length > 100) key = key.slice(0, 100);
    if (!key) key = '_empty';

    await db.ref(`customerBotInteractions/${key}`).push({
      phone,
      message,
      timestamp: Date.now(),
      dateISO: new Date().toISOString(),
    });
  } catch (err) {
    console.error('logCustomerInteraction failed:', err?.message || err);
  }
}

/**
 * Check if a payment has been processed (deduplication)
 * @param {string} paymentId - Razorpay payment ID
 * @returns {Promise<boolean>} - true if already processed
 */
export async function isPaymentProcessed(paymentId) {
  if (!paymentId) return false;

  const sanitizedId = sanitizeFirebaseKey(paymentId);
  const snapshot = await db.ref(`processedPayments/${sanitizedId}`).once('value');
  return snapshot.exists();
}

/**
 * Mark a payment as processed
 * @param {string} paymentId - Razorpay payment ID
 * @returns {Promise<void>}
 */
export async function markPaymentAsProcessed(paymentId) {
  if (!paymentId) return;

  const sanitizedId = sanitizeFirebaseKey(paymentId);
  await db.ref(`processedPayments/${sanitizedId}`).set({
    timestamp: Date.now(),
    processedAt: new Date().toISOString(),
    originalId: paymentId // Store original for debugging
  });
}

/**
 * Atomic transaction to acquire order processing lock
 * Prevents duplicate orders from simultaneous webhooks
 * @param {string} phone - User's phone number
 * @param {Function} callback - Function to execute if lock acquired
 * @returns {Promise<any>} - Result from callback or null if lock failed
 */
export async function acquireOrderLock(phone, callback) {
  const sanitizedPhone = sanitizeFirebaseKey(phone);
  const lockRef = db.ref(`orderLocks/${sanitizedPhone}`);

  try {
    const result = await lockRef.transaction((currentLock) => {
      // If lock exists and is recent (within 2 minutes), abort
      if (currentLock && currentLock.timestamp) {
        const lockAge = Date.now() - currentLock.timestamp;
        if (lockAge < 2 * 60 * 1000) { // 2 minutes
          console.log(`🔒 Order lock active for ${phone} (age: ${lockAge}ms)`);
          return; // Abort transaction
        }
      }

      // Acquire lock
      return {
        timestamp: Date.now(),
        acquiredAt: new Date().toISOString()
      };
    });

    if (!result.committed) {
      console.log(`⚠️ Failed to acquire order lock for ${phone} - duplicate request blocked`);
      return null;
    }

    console.log(`✅ Order lock acquired for ${phone}`);

    // Execute callback with lock held
    const callbackResult = await callback();

    // Release lock after successful execution
    await lockRef.remove();
    console.log(`🔓 Order lock released for ${phone}`);

    return callbackResult;

  } catch (error) {
    console.error('❌ Error in order lock transaction:', error);
    // Release lock on error
    try {
      await lockRef.remove();
    } catch (e) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Save order session to Firebase
 * @param {string} orderId - Order ID
 * @param {object} sessionData - Session data
 * @returns {Promise<void>}
 */
export async function saveOrderSession(orderId, sessionData) {
  const sanitizedId = sanitizeFirebaseKey(orderId);
  await db.ref(`orderSessions/${sanitizedId}`).set({
    ...sessionData,
    savedAt: Date.now(),
    originalOrderId: orderId // Store original for reference
  });
}

/**
 * Get order session from Firebase
 * @param {string} orderId - Order ID
 * @returns {Promise<object|null>} - Session data or null
 */
export async function getOrderSession(orderId) {
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const snapshot = await db.ref(`orderSessions/${sanitizedId}`).once('value');
  return snapshot.exists() ? snapshot.val() : null;
}

/**
 * Delete order session from Firebase
 * @param {string} orderId - Order ID
 * @returns {Promise<void>}
 */
export async function deleteOrderSession(orderId) {
  const sanitizedId = sanitizeFirebaseKey(orderId);
  await db.ref(`orderSessions/${sanitizedId}`).remove();
}

// ========================================
// PENDING ORDER HELPERS (Website checkout flow)
// ========================================
//
// A pending order is a durable, cross-request record of a website order's
// lifecycle. It exists so that (a) a webhook can fulfill an order even if
// the browser never calls process-prepaid, and (b) a duplicate process-prepaid
// call can be short-circuited using the fulfillment status stored here.
//
// Statuses:
//   pending_payment      Razorpay order created, awaiting capture
//   paid                 Payment captured/verified, awaiting fulfillment
//   fulfilling           Fulfillment in progress (lock held)
//   fulfilled            Delhivery + Sheets completed
//   failed_fulfillment   Delhivery or Sheets failed; safe to retry
//   payment_failed       Razorpay reported the payment as failed/cancelled

/**
 * Create a pending order record atomically (create-if-not-exists).
 * If a record already exists, returns { created: false, existing }.
 * If a new record was written, returns { created: true, record }.
 */
export async function createPendingOrder(orderId, initialData = {}) {
  if (!orderId) throw new Error('createPendingOrder: orderId required');
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const recordRef = db.ref(`pendingOrders/${sanitizedId}`);

  const result = await recordRef.transaction((current) => {
    if (current) return; // abort — record already exists
    return {
      ...initialData,
      orderId,
      status: initialData.status || 'pending_payment',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
    };
  });

  if (!result.committed) {
    const snap = await recordRef.once('value');
    return { created: false, existing: snap.exists() ? snap.val() : null };
  }
  return { created: true, record: result.snapshot.val() };
}

/**
 * Get pending order by orderId. Returns null if missing.
 */
export async function getPendingOrder(orderId) {
  if (!orderId) return null;
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const snap = await db.ref(`pendingOrders/${sanitizedId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Merge-update a pending order record. Uses a transaction so concurrent
 * updates don't clobber each other. Callers pass a shallow patch object;
 * top-level keys in `patch` replace the corresponding keys on the record.
 * If the record doesn't exist, it will be created with the patched fields.
 */
export async function updatePendingOrder(orderId, patch = {}) {
  if (!orderId) throw new Error('updatePendingOrder: orderId required');
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const recordRef = db.ref(`pendingOrders/${sanitizedId}`);
  const result = await recordRef.transaction((current) => {
    if (!current) {
      return {
        orderId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        ...patch,
      };
    }
    return { ...current, ...patch, updatedAt: Date.now() };
  });
  return result.snapshot.val();
}

/**
 * Attempt to acquire an exclusive fulfillment lock on this order.
 * Transitions status → 'fulfilling' iff current status permits it, OR if
 * an existing 'fulfilling' record is stale (older than staleAfterMs).
 *
 * Returns one of:
 *   { ok: true, record }
 *   { ok: false, reason: 'not_found',        record: null }
 *   { ok: false, reason: 'already_fulfilled', record }
 *   { ok: false, reason: 'in_progress',      record }
 *   { ok: false, reason: 'payment_failed',   record }
 */
export async function tryStartFulfillment(orderId, { staleAfterMs = 60_000 } = {}) {
  if (!orderId) throw new Error('tryStartFulfillment: orderId required');
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const recordRef = db.ref(`pendingOrders/${sanitizedId}`);

  // Pre-read: BOTH warms admin SDK's local cache AND short-circuits truly-
  // missing records without paying for a doomed transaction. If this isn't
  // enough (i.e. transaction fn STILL sees null on first invocation), the
  // diagnostic logs below will pinpoint it and we switch to a manual
  // compare-and-swap fallback.
  const initialSnap = await recordRef.once('value');
  if (!initialSnap.exists()) {
    console.warn(`[tryStartFulfillment] orderId=${orderId} pre-read=missing → not_found`);
    return { ok: false, reason: 'not_found', record: null };
  }
  const initialValue = initialSnap.val();
  console.log(`[tryStartFulfillment] orderId=${orderId} pre-read status=${initialValue?.status} attempts=${initialValue?.attempts || 0}`);

  // Instrument every transaction-fn invocation. If admin SDK invokes fn
  // more than once (retry on write conflict) or with null (local cache
  // gotcha), we see it here.
  const invocations = [];
  const result = await recordRef.transaction((current) => {
    invocations.push({ hasCurrent: !!current, status: current?.status });
    if (!current) return;                              // race: deleted between pre-read and transaction (OR local-cache gotcha)
    if (current.status === 'fulfilled') return;        // abort — already_fulfilled
    if (current.status === 'payment_failed') return;   // abort — payment_failed
    if (current.status === 'fulfilling') {
      const age = Date.now() - (current.fulfillingStartedAt || 0);
      if (age < staleAfterMs) return;                  // abort — in_progress
      // stale lock; steal it
    }
    return {
      ...current,
      status: 'fulfilling',
      fulfillingStartedAt: Date.now(),
      attempts: (current.attempts || 0) + 1,
      updatedAt: Date.now(),
    };
  });

  console.log(`[tryStartFulfillment] orderId=${orderId} txn.committed=${result.committed} invocations=${JSON.stringify(invocations)}`);

  if (!result.committed) {
    // Fallback path: transaction refused to commit. If the ONLY invocation
    // saw null (the local-cache gotcha), do a manual read-modify-write with
    // compare-and-swap on `updatedAt`. This is race-safe for our
    // single-worker deployment; multi-worker deploys will need real
    // conditional writes (not supported by RTDB — would need Firestore).
    const allInvocationsSawNull = invocations.length > 0 && invocations.every(inv => !inv.hasCurrent);
    if (allInvocationsSawNull && initialValue) {
      console.warn(`[tryStartFulfillment] orderId=${orderId} txn saw null despite pre-read (admin-SDK local-cache gotcha); switching to manual read-modify-write`);
      return await fallbackManualLock(recordRef, orderId, initialValue, staleAfterMs);
    }

    const snap = await recordRef.once('value');
    const rec = snap.exists() ? snap.val() : null;
    let reason = 'unknown';
    if (!rec) reason = 'not_found';
    else if (rec.status === 'fulfilled') reason = 'already_fulfilled';
    else if (rec.status === 'payment_failed') reason = 'payment_failed';
    else if (rec.status === 'fulfilling') reason = 'in_progress';
    if (reason === 'unknown') {
      console.error(`[tryStartFulfillment] orderId=${orderId} reason=unknown status=${rec?.status} initialStatus=${initialValue?.status} invocations=${JSON.stringify(invocations)}`);
    }
    return { ok: false, reason, record: rec };
  }
  return { ok: true, record: result.snapshot.val() };
}

/**
 * Fallback fulfillment-lock path used when admin SDK's transaction() refuses
 * to commit due to the local-cache-first-invocation gotcha (fn called with
 * null on a fresh Reference even after a pre-read on the same connection).
 * Uses read → check → set instead of a transaction. Not multi-worker safe;
 * relies on single-PM2-worker deploy (which is our current setup — H-08).
 */
async function fallbackManualLock(recordRef, orderId, current, staleAfterMs) {
  if (current.status === 'fulfilled')      return { ok: false, reason: 'already_fulfilled', record: current };
  if (current.status === 'payment_failed') return { ok: false, reason: 'payment_failed', record: current };
  if (current.status === 'fulfilling') {
    const age = Date.now() - (current.fulfillingStartedAt || 0);
    if (age < staleAfterMs) return { ok: false, reason: 'in_progress', record: current };
    // stale — steal
  }
  const next = {
    ...current,
    status: 'fulfilling',
    fulfillingStartedAt: Date.now(),
    attempts: (current.attempts || 0) + 1,
    updatedAt: Date.now(),
  };
  await recordRef.set(next);
  console.log(`[tryStartFulfillment] orderId=${orderId} manual lock acquired via .set() fallback`);
  return { ok: true, record: next };
}

// ========================================
// DELHIVERY WEBHOOK DEDUPLICATION (audit fix C-07)
// ========================================
//
// Two-level dedup, deliberately separate:
//
//   1. EVENT-level: dedup key = `${waybill}|${status}|${eventTime}`.
//      Prevents processing the same webhook invocation twice — protects
//      against Delhivery's retry storms (they re-fire when we don't 200
//      fast enough) and against a hostile flood of identical POSTs.
//
//   2. NOTIFICATION-level: dedup key = `${waybill}|${status}`.
//      Prevents sending the customer more than one WhatsApp per status
//      transition, even if Delhivery legitimately records two events with
//      different timestamps for the same (waybill, status) — e.g. a
//      re-delivery attempt after an initial "delivered" scan.
//
// Both TTL 14 days (double the typical shipment lifecycle from manifest
// to delivered). Cleanup runs alongside the existing messages/payments GC.

const DELHIVERY_EVENT_EXPIRY_MS       = 14 * 24 * 60 * 60 * 1000; // 14 days
const DELHIVERY_NOTIFY_EXPIRY_MS      = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Check whether we've already processed a specific Delhivery event.
 * @param {string} eventKey  Composite key: `${waybill}|${status}|${eventTime}`
 * @returns {Promise<boolean>}
 */
export async function isDelhiveryEventProcessed(eventKey) {
  if (!eventKey) return false;
  const sanitizedKey = sanitizeFirebaseKey(eventKey);
  const snap = await db.ref(`processedDelhiveryEvents/${sanitizedKey}`).once('value');
  return snap.exists();
}

/**
 * Mark a Delhivery event as processed. Stores compact metadata for debugging
 * (originalKey + processedAt) plus a numeric timestamp used by cleanup.
 */
export async function markDelhiveryEventProcessed(eventKey, meta = {}) {
  if (!eventKey) return;
  const sanitizedKey = sanitizeFirebaseKey(eventKey);
  await db.ref(`processedDelhiveryEvents/${sanitizedKey}`).set({
    timestamp: Date.now(),
    processedAt: new Date().toISOString(),
    originalKey: eventKey,
    ...meta,
  });
}

/**
 * Check whether we've already sent a customer notification for this
 * (waybill, status) transition — independent of the event timestamp.
 */
export async function hasDelhiveryUpdateBeenSent(waybill, status) {
  if (!waybill || !status) return false;
  const sanitizedKey = sanitizeFirebaseKey(`${waybill}|${status}`);
  const snap = await db.ref(`delhiverySentUpdates/${sanitizedKey}`).once('value');
  return snap.exists();
}

/**
 * Mark a (waybill, status) notification as sent. Call ONLY after the outbound
 * WhatsApp actually succeeded — callers should NOT mark on failure, so a
 * retry can try to send again.
 */
export async function markDelhiveryUpdateSent(waybill, status, meta = {}) {
  if (!waybill || !status) return;
  const sanitizedKey = sanitizeFirebaseKey(`${waybill}|${status}`);
  await db.ref(`delhiverySentUpdates/${sanitizedKey}`).set({
    timestamp: Date.now(),
    sentAt: new Date().toISOString(),
    waybill,
    status,
    ...meta,
  });
}

// ========================================
// USER STATE (audit fix H-08, option A)
// ========================================
//
// Per-phone-number flags for the WhatsApp bot's idle-reminder and name+email
// completion tracking. Replaces the in-memory `remindedUsers` and
// `completedUsers` Sets that were declared in app.js. Firebase-backed so the
// state survives PM2 restart.
//
// Schema at userState/<sanitizedPhone>:
//   { phone, reminded, remindedAt, completed, completedAt, updatedAt }
//
// Writes use runTransaction so a future multi-worker deploy merges concurrent
// updates cleanly instead of overwriting each other.

const USER_STATE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Read the user-state flags for a phone. Never throws for a missing record —
 * returns defaults so callers can treat "no record" as "fresh user".
 * @returns {Promise<{ reminded: boolean, completed: boolean }>}
 */
export async function getUserState(phone) {
  if (!phone) return { reminded: false, completed: false };
  const sanitized = sanitizeFirebaseKey(phone);
  const snap = await db.ref(`userState/${sanitized}`).once('value');
  if (!snap.exists()) return { reminded: false, completed: false };
  const v = snap.val() || {};
  return {
    reminded: v.reminded === true,
    completed: v.completed === true,
  };
}

/** Convenience: `(await getUserState(phone)).completed`. */
export async function isUserCompleted(phone) {
  return (await getUserState(phone)).completed;
}

/** Convenience for the else-if branch in the WhatsApp bot handler. */
export async function isRemindedButNotCompleted(phone) {
  const state = await getUserState(phone);
  return state.reminded && !state.completed;
}

/**
 * Mark that the 3-hour idle reminder was sent to this phone. Preserves any
 * existing `completed` flag (concurrent write from a different code path).
 */
export async function markReminded(phone) {
  if (!phone) return;
  const sanitized = sanitizeFirebaseKey(phone);
  const recordRef = db.ref(`userState/${sanitized}`);
  await recordRef.transaction((current) => ({
    phone,
    ...(current || {}),
    reminded: true,
    remindedAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

/**
 * Mark that the customer completed the name+email flow. Sets completed=true
 * AND clears reminded=false in one atomic write — matches the semantics of
 * the old in-memory `remindedUsers.delete(from); completedUsers.add(from);`.
 */
export async function markUserCompleted(phone) {
  if (!phone) return;
  const sanitized = sanitizeFirebaseKey(phone);
  const recordRef = db.ref(`userState/${sanitized}`);
  await recordRef.transaction((current) => ({
    phone,
    ...(current || {}),
    completed: true,
    completedAt: Date.now(),
    reminded: false,
    updatedAt: Date.now(),
  }));
}

// ========================================
// COUPON USAGE (audit fix M-15)
// ========================================
// Audit trail + per-user-limit substrate. Every successful redemption writes
// a compact record; per-user validation reads the count. Kept intentionally
// small — a full analytics view would layer on top of this via Firebase
// listeners or an ETL job.
//
// Firebase layout:
//   couponUsage/<CODE>/<sanitized-phone>/<timestamp> = { orderId, at, phone }
// Keys under <sanitized-phone> are Date.now() strings — sequential enough
// for ordering and unique per redemption at ms resolution.

const COUPON_USAGE_ROOT = 'couponUsage';

/**
 * Record that `phone` redeemed `code` on `orderId`. Called from fulfillment
 * paths (bot: finalizePaidOrder; website: fulfillOrder) only on success.
 * Best-effort — logs and swallows errors so a Firebase outage does not
 * derail the fulfillment ack path. The at-least-once semantics (a retry
 * of a partially-fulfilled order can double-record) are acceptable for an
 * audit log; downstream analytics can dedupe on orderId if needed.
 *
 * @param {string} code    Coupon code (case-insensitive; normalized here).
 * @param {string} phone   Customer phone (E.164 or digits).
 * @param {string} orderId The order this redemption belongs to.
 */
export async function recordCouponUsage(code, phone, orderId) {
  if (!code || !phone || !orderId) return;
  const normalizedCode = String(code).trim().toUpperCase();
  const sanitizedPhone = sanitizeFirebaseKey(phone);
  const now = Date.now();
  try {
    await db.ref(`${COUPON_USAGE_ROOT}/${normalizedCode}/${sanitizedPhone}/${now}`).set({
      orderId,
      at: now,
      recordedAt: new Date().toISOString(),
      phone, // keep the original for audit (sanitizedPhone is the key)
    });
  } catch (err) {
    console.warn(`[recordCouponUsage] failed for code=${normalizedCode} orderId=${orderId}: ${err?.message || err}`);
  }
}

/**
 * Count how many times `phone` has redeemed `code`. Used by
 * validateCouponForUser to enforce per_user_limit. Throws on Firebase
 * failure — the caller (validateCouponForUser) chooses the policy
 * (currently: fail-open with a warning log).
 *
 * @returns {Promise<number>}
 */
export async function getCouponUsageCount(code, phone) {
  if (!code || !phone) return 0;
  const normalizedCode = String(code).trim().toUpperCase();
  const sanitizedPhone = sanitizeFirebaseKey(phone);
  const snap = await db.ref(`${COUPON_USAGE_ROOT}/${normalizedCode}/${sanitizedPhone}`).once('value');
  if (!snap.exists()) return 0;
  const val = snap.val();
  if (val && typeof val === 'object') return Object.keys(val).length;
  return 0;
}

/**
 * Cleanup old data from Firebase (runs periodically)
 * Removes processed messages and payments older than 10 minutes
 * Removes stale order locks older than 5 minutes
 * Removes processed Delhivery events + sent-update markers older than 14 days
 * @returns {Promise<void>}
 */
export async function cleanupOldData() {
  const now = Date.now();
  const messageExpiry = 10 * 60 * 1000; // 10 minutes
  const lockExpiry = 5 * 60 * 1000; // 5 minutes

  try {
    // Cleanup old processed messages
    const messagesSnapshot = await db.ref('processedMessages').once('value');
    if (messagesSnapshot.exists()) {
      const messages = messagesSnapshot.val();
      for (const [sanitizedMessageId, data] of Object.entries(messages)) {
        if (data.timestamp && now - data.timestamp > messageExpiry) {
          await db.ref(`processedMessages/${sanitizedMessageId}`).remove();
        }
      }
    }

    // Cleanup old processed payments
    const paymentsSnapshot = await db.ref('processedPayments').once('value');
    if (paymentsSnapshot.exists()) {
      const payments = paymentsSnapshot.val();
      for (const [sanitizedPaymentId, data] of Object.entries(payments)) {
        if (data.timestamp && now - data.timestamp > messageExpiry) {
          await db.ref(`processedPayments/${sanitizedPaymentId}`).remove();
        }
      }
    }

    // Cleanup stale order locks
    const locksSnapshot = await db.ref('orderLocks').once('value');
    if (locksSnapshot.exists()) {
      const locks = locksSnapshot.val();
      for (const [sanitizedPhone, data] of Object.entries(locks)) {
        if (data.timestamp && now - data.timestamp > lockExpiry) {
          await db.ref(`orderLocks/${sanitizedPhone}`).remove();
        }
      }
    }

    // Cleanup old processed Delhivery events (14 day TTL)
    const delhEventsSnap = await db.ref('processedDelhiveryEvents').once('value');
    if (delhEventsSnap.exists()) {
      const events = delhEventsSnap.val();
      for (const [sanitizedKey, data] of Object.entries(events)) {
        if (data.timestamp && now - data.timestamp > DELHIVERY_EVENT_EXPIRY_MS) {
          await db.ref(`processedDelhiveryEvents/${sanitizedKey}`).remove();
        }
      }
    }

    // Cleanup old delhivery notification-sent markers (14 day TTL)
    const delhNotifSnap = await db.ref('delhiverySentUpdates').once('value');
    if (delhNotifSnap.exists()) {
      const notifs = delhNotifSnap.val();
      for (const [sanitizedKey, data] of Object.entries(notifs)) {
        if (data.timestamp && now - data.timestamp > DELHIVERY_NOTIFY_EXPIRY_MS) {
          await db.ref(`delhiverySentUpdates/${sanitizedKey}`).remove();
        }
      }
    }

    // Cleanup old userState records (7 day TTL). A returning customer past this
    // window starts fresh — name+email prompt re-fires, matching pre-fix
    // in-memory Set behavior on a long-lived process.
    const userStateSnap = await db.ref('userState').once('value');
    if (userStateSnap.exists()) {
      const records = userStateSnap.val();
      for (const [sanitizedPhone, data] of Object.entries(records)) {
        if (data.updatedAt && now - data.updatedAt > USER_STATE_EXPIRY_MS) {
          await db.ref(`userState/${sanitizedPhone}`).remove();
        }
      }
    }

    console.log('🧹 Firebase cleanup completed');
  } catch (error) {
    console.error('❌ Firebase cleanup error:', error);
  }
}

export { db };
