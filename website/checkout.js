import express from 'express';
import axios from 'axios';

import {
  createPendingOrder,
  getPendingOrder,
  updatePendingOrder,
  tryStartFulfillment,
  // Coupon audit trail (audit fix M-15). Called after fulfillment success.
  recordCouponUsage,
} from '../shared/firebase.js';
import { validateOrderData, INPUT_VALIDATION_MODE } from '../shared/order-validation.js';
import { generateFulfillmentToken, enforceFulfillmentToken } from '../shared/order-token.js';
import { makeKeyedRateLimiter, keyByIp, keyByBodyPath } from '../shared/rate-limit.js';
// stampGstRate (audit fix M-16) — server-authoritative GST rate injection
// on every payload sent to the Apps Script's invoice renderer.
import { stampGstRate } from '../shared/catalog.js';

// Per-route rate limits (audit fix H-07).
const processPrepaidIpLimiter = makeKeyedRateLimiter({
  routeName: '/api/checkout/process-prepaid[ip]',      maxRequests: 5, windowMs: 60_000,
  keyExtractor: keyByIp,
});
const processPrepaidOrderIdLimiter = makeKeyedRateLimiter({
  routeName: '/api/checkout/process-prepaid[orderId]', maxRequests: 3, windowMs: 60_000,
  keyExtractor: keyByBodyPath(['orderData', 'orderId']),
  // If orderData or its orderId is missing, the handler will 400 shortly;
  // skip the orderId limiter and rely on the IP one.
});
const processCodIpLimiter = makeKeyedRateLimiter({
  routeName: '/api/checkout/process-cod[ip]',          maxRequests: 5, windowMs: 60_000,
  keyExtractor: keyByIp,
});

/**
 * Validate orderData at the API boundary. Behavior:
 *   strict — return 400 with structured errors; caller aborts.
 *   warn   — log the errors, proceed with client-supplied data unchanged.
 *   off    — skip validation entirely.
 * In all modes, the returned `cleaned` object is available for the caller to
 * merge into orderData before persisting — this normalizes phone/state casing
 * even in warn mode.
 *
 * Returns { proceed: true, cleaned } to continue OR { proceed: false } if the
 * caller has already responded (only happens in strict mode).
 */
function enforceOrderDataValidation(orderData, res, routeTag, requestId) {
  if (INPUT_VALIDATION_MODE === 'off') return { proceed: true, cleaned: {} };

  const result = validateOrderData(orderData);
  if (result.ok) return { proceed: true, cleaned: result.cleaned };

  const summary = result.errors.map(e => `${e.field}:${e.code}`).join(',');
  if (INPUT_VALIDATION_MODE === 'strict') {
    console.warn(`[${requestId}] [${routeTag}] orderData validation FAILED (strict) — rejecting. errors=${summary}`);
    res.status(400).json({
      success: false,
      message: 'orderData validation failed',
      errors: result.errors,
    });
    return { proceed: false };
  }

  // warn mode: log and continue
  console.warn(`[${requestId}] [${routeTag}] orderData validation FAILED (warn) — proceeding with raw values. errors=${summary}`);
  return { proceed: true, cleaned: result.cleaned || {} };
}

const router = express.Router();
const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_URL;

// Shared secret for the Apps Script /exec endpoint (audit fix H-11). Attached
// to every payload; the Apps Script's doPost verifies it (constant-time) before
// any side-effect. If unset here, we still POST so the resulting server-side
// 'unauthorized' response makes the misconfig obvious rather than dropping the
// row silently. Boot warning lives in app.js next to the other secret warnings.
const APP_SCRIPT_SHARED_SECRET = process.env.APP_SCRIPT_SHARED_SECRET;

if (!GOOGLE_SHEETS_URL) {
  console.warn('⚠️ GOOGLE_SHEETS_URL not configured. Order saving to Google Sheets will fail.');
}

// ============================================================
// SHARED HELPERS
// ============================================================

/**
 * Call the Delhivery CMU create endpoint. Throws on network/API failure.
 * The caller must inspect the returned JSON via validateDelhiveryResponse —
 * Delhivery returns 200 OK even when the shipment itself failed.
 */
async function callDelhivery(shipmentData, pickupLocation) {
  if (!process.env.DELHIVERY_API_KEY) {
    throw new Error('DELHIVERY_API_KEY not configured');
  }
  const payload = { shipments: [shipmentData], pickup_location: pickupLocation || {} };
  const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
  const res = await axios.post(
    'https://track.delhivery.com/api/cmu/create.json',
    bodyStr,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${process.env.DELHIVERY_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 20000,
    }
  );
  return res.data;
}

/**
 * Validate Delhivery's response envelope. Delhivery returns HTTP 200 for
 * both successes and duplicates — the truth is in `success` and
 * `packages[0].status`. We also detect the "Duplicate order id" remark so
 * the caller can short-circuit into an idempotent-success recovery.
 *
 * Returns one of:
 *   { ok: true,  waybill, uploadWbn, packageInfo }
 *   { ok: false, isDuplicate: true,  reason: 'duplicate_order_id', remarks, packageInfo }
 *   { ok: false, isDuplicate: false, reason, remarks, packageInfo, raw }
 */
export function validateDelhiveryResponse(data) {
  const pkg = data?.packages?.[0];
  const envelopeOk = data?.success === true;
  const pkgStatus = pkg?.status;
  const remarks = Array.isArray(pkg?.remarks) ? pkg.remarks : [];
  const isDuplicate = remarks.some(
    (r) => typeof r === 'string' && r.toLowerCase().includes('duplicate order')
  );

  if (envelopeOk && pkgStatus === 'Success' && pkg?.waybill) {
    return {
      ok: true,
      waybill: pkg.waybill,
      uploadWbn: data.upload_wbn || null,
      packageInfo: pkg,
    };
  }
  if (isDuplicate) {
    return {
      ok: false,
      isDuplicate: true,
      reason: 'duplicate_order_id',
      remarks,
      packageInfo: pkg,
    };
  }
  return {
    ok: false,
    isDuplicate: false,
    reason:
      pkgStatus === 'Fail'
        ? `package_fail: ${remarks.join('; ') || 'no remarks'}`
        : (envelopeOk ? 'no_waybill_in_success_response' : 'envelope_not_success'),
    remarks,
    packageInfo: pkg,
    raw: data,
  };
}

/**
 * Post an order row to the Google Sheets Apps Script endpoint. Throws on
 * failure — caller handles retry semantics. NOTE: the downstream Apps Script
 * sends the customer/admin email; we cannot dedupe emails from here, so the
 * only guard against duplicate mails is: only ever call this function once
 * per orderId. That is enforced by the sheetsSaved flag on the pending
 * record — the fulfillment path checks it before calling us.
 */
async function saveOrderToSheets(orderPayload) {
  if (!GOOGLE_SHEETS_URL) {
    throw new Error('GOOGLE_SHEETS_URL not configured');
  }
  if (!APP_SCRIPT_SHARED_SECRET) {
    console.warn(`⚠️ [saveOrderToSheets] APP_SCRIPT_SHARED_SECRET unset — request will be rejected by any script with H-11 enforcement. orderId=${orderPayload?.orderId || 'unknown'}`);
  }
  // Stamp secret + augment each product line with gst_rate from the catalog
  // (audit fix M-16). Non-destructive on the caller's object.
  const signedPayload = {
    ...orderPayload,
    products: stampGstRate(orderPayload?.products || []),
    secret: APP_SCRIPT_SHARED_SECRET || '',
  };
  await axios.post(GOOGLE_SHEETS_URL, signedPayload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

// ============================================================
// FULFILLMENT (shared between prepaid client-initiated,
//              prepaid webhook-initiated, and COD)
// ============================================================

/**
 * Fulfill an order that already has a pending record in Firebase.
 * Idempotent — safe to call any number of times with the same orderId.
 *
 * Preconditions:
 *   - A pendingOrders/<orderId> record exists with orderData + shipmentData
 *   - For prepaid: payment has been captured (status should be 'paid')
 *
 * Order of operations (deliberately Delhivery-first):
 *   1. Acquire an exclusive fulfillment lock (transactional).
 *   2. If a waybill is already stored on the record, skip Delhivery.
 *   3. Otherwise call Delhivery. Validate the response envelope.
 *      - Success              → store waybill, proceed.
 *      - Duplicate order id   → if we already know the waybill, use it and
 *                               proceed; otherwise mark failed_fulfillment
 *                               and flag for manual recovery.
 *      - Any other failure    → mark failed_fulfillment, return error.
 *   4. Save to Sheets — only if the record's sheetsSaved flag isn't set.
 *      - Success → set sheetsSaved.
 *      - Failure → mark failed_fulfillment, keep waybill on record so a
 *                  retry can skip step 3, return error.
 *   5. Mark status = fulfilled.
 *
 * Returns one of:
 *   { status: 'fulfilled',          waybill, delhiveryResponse }
 *   { status: 'already_fulfilled',  waybill, delhiveryResponse }
 *   { status: 'in_progress' }
 *   { status: 'error',              stage, message, ...details }
 */
export async function fulfillOrder(orderId, requestId = `fulfill_${Date.now()}`) {
  // Step 1: acquire the lock
  const lock = await tryStartFulfillment(orderId);
  if (!lock.ok) {
    if (lock.reason === 'already_fulfilled') {
      console.log(`[${requestId}] ✅ orderId=${orderId} already fulfilled (idempotent hit). waybill=${lock.record?.waybill}`);
      return {
        status: 'already_fulfilled',
        waybill: lock.record?.waybill,
        delhiveryResponse: lock.record?.delhiveryResponse,
      };
    }
    if (lock.reason === 'in_progress') {
      console.warn(`[${requestId}] ⏳ orderId=${orderId} fulfillment already in progress (started ${Date.now() - (lock.record?.fulfillingStartedAt || 0)}ms ago)`);
      return { status: 'in_progress' };
    }
    if (lock.reason === 'not_found') {
      console.error(`[${requestId}] 🚨 orderId=${orderId} — pending record missing; cannot fulfill`);
      return { status: 'error', stage: 'lookup', message: 'Pending order record missing' };
    }
    if (lock.reason === 'payment_failed') {
      console.warn(`[${requestId}] ❌ orderId=${orderId} — payment previously marked failed; refusing to fulfill`);
      return { status: 'error', stage: 'payment_check', message: 'Payment failed for this order' };
    }
    return { status: 'error', stage: 'lock', message: `Cannot acquire fulfillment lock: ${lock.reason}` };
  }

  const record = lock.record;
  const { orderData, shipmentData, pickupLocation, paymentMode = 'prepaid' } = record;
  const refnum = shipmentData?.order || orderId;

  if (!orderData || !shipmentData) {
    console.error(`[${requestId}] 🚨 orderId=${orderId} — pending record missing orderData/shipmentData`);
    await updatePendingOrder(orderId, {
      status: 'failed_fulfillment',
      fulfillmentError: 'missing_snapshot',
      fulfillmentErrorAt: Date.now(),
    });
    return { status: 'error', stage: 'snapshot', message: 'Order snapshot missing on server — client must retry with full payload' };
  }

  // Step 2/3: Delhivery
  let waybill = record.waybill || null;
  let delhiveryResponse = record.delhiveryResponse || null;

  if (!waybill) {
    console.log(`[${requestId}] 📦 orderId=${orderId} refnum=${refnum} — calling Delhivery`);

    let raw;
    try {
      raw = await callDelhivery(shipmentData, pickupLocation);
    } catch (err) {
      const errPayload = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[${requestId}] 📦 orderId=${orderId} refnum=${refnum} — Delhivery NETWORK error: ${errPayload}`);
      await updatePendingOrder(orderId, {
        status: 'failed_fulfillment',
        fulfillmentError: `delhivery_network: ${err.message}`,
        fulfillmentErrorAt: Date.now(),
      });
      return { status: 'error', stage: 'delhivery_call', message: 'Delhivery API network/timeout error', detail: err.message };
    }

    const validation = validateDelhiveryResponse(raw);
    const tag = validation.ok ? 'PASS' : validation.isDuplicate ? 'DUPLICATE' : 'FAIL';
    console.log(`[${requestId}] 📦 orderId=${orderId} refnum=${refnum} — Delhivery ${tag}: ${JSON.stringify(raw)}`);

    if (validation.ok) {
      waybill = validation.waybill;
      delhiveryResponse = raw;
      await updatePendingOrder(orderId, {
        waybill,
        delhiveryUploadWbn: validation.uploadWbn,
        delhiveryResponse: raw,
      });
    } else if (validation.isDuplicate) {
      // Delhivery says this refnum already exists. Two sub-cases:
      //   (a) We successfully created it earlier and stored the waybill on this
      //       record. Just use it — this is the ideal recovery path for the
      //       double-invocation bug.
      //   (b) We DON'T have a stored waybill (e.g. Firebase write failed after
      //       Delhivery succeeded, or this record was created after the fact).
      //       We can't recover automatically — needs manual reconciliation via
      //       Delhivery's tracking API by refnum.
      if (record.waybill) {
        waybill = record.waybill;
        delhiveryResponse = record.delhiveryResponse || raw;
        console.log(`[${requestId}] ✅ orderId=${orderId} refnum=${refnum} — duplicate ack; using stored waybill=${waybill}`);
      } else {
        console.error(`[${requestId}] 🚨 orderId=${orderId} refnum=${refnum} — Delhivery reports DUPLICATE but no waybill stored. Manual reconciliation required.`);
        await updatePendingOrder(orderId, {
          status: 'failed_fulfillment',
          fulfillmentError: 'delhivery_duplicate_no_stored_waybill',
          fulfillmentErrorAt: Date.now(),
          delhiveryResponse: raw,
        });
        return {
          status: 'error',
          stage: 'delhivery_duplicate',
          message: 'Delhivery reports duplicate refnum but no waybill is on record — manual reconciliation required',
          refnum,
        };
      }
    } else {
      await updatePendingOrder(orderId, {
        status: 'failed_fulfillment',
        fulfillmentError: `delhivery_fail: ${validation.reason}`,
        fulfillmentErrorAt: Date.now(),
        delhiveryResponse: raw,
      });
      return {
        status: 'error',
        stage: 'delhivery_response',
        message: `Delhivery rejected shipment: ${validation.reason}`,
        remarks: validation.remarks,
      };
    }
  } else {
    console.log(`[${requestId}] ✅ orderId=${orderId} refnum=${refnum} — waybill=${waybill} already recorded; skipping Delhivery call`);
  }

  // Step 4: Sheets (skip if already saved on an earlier attempt)
  if (!record.sheetsSaved) {
    // Explicitly stamp the fields the Apps Script's doPost + email templates
    // depend on. Frontend's `orderData` doesn't carry these — they're an
    // Apps-Script-side contract, not part of the validated order shape:
    //   type          — doPost routes on this; missing = "Invalid submission
    //                   type" error, no sheet write, no emails.
    //   paymentMode   — Apps Script checks `=== 'COD'` (Title case) for the
    //                   COD-only email sections. Backend's internal value is
    //                   lowercase 'cod'/'prepaid' — normalize at the boundary.
    //   paymentStatus — admin email renders it verbatim ("Payment Status: X").
    //                   Frontend doesn't send it; derive from paymentMode.
    const displayMode   = paymentMode === 'cod' ? 'COD' : 'Prepaid';
    const displayStatus = paymentMode === 'cod' ? 'Pending' : 'Paid';
    const sheetPayload = {
      ...orderData,
      type: 'checkout',
      paymentMode:   displayMode,
      paymentStatus: displayStatus,
      paymentId:     paymentMode === 'prepaid' ? (record.paymentId || '') : '',
      delhiveryResponse: JSON.stringify(delhiveryResponse || {}),
      waybill,
    };
    try {
      await saveOrderToSheets(sheetPayload);
      await updatePendingOrder(orderId, {
        sheetsSaved: true,
        sheetsSavedAt: Date.now(),
      });
      console.log(`[${requestId}] ✅ orderId=${orderId} — Sheets saved`);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[${requestId}] 📊 orderId=${orderId} — Sheets save FAILED: ${detail}`);
      await updatePendingOrder(orderId, {
        status: 'failed_fulfillment',
        fulfillmentError: `sheets_save: ${err.message}`,
        fulfillmentErrorAt: Date.now(),
      });
      // Waybill is safely stored on the record. Retry will skip Delhivery and
      // only re-attempt Sheets — safe for shipment, safe for duplicate email.
      return {
        status: 'error',
        stage: 'sheets_save',
        message: 'Order shipped but Sheets save failed — will be retried',
        waybill,
        delhiveryResponse,
      };
    }
  } else {
    console.log(`[${requestId}] ✅ orderId=${orderId} — Sheets already saved on prior attempt; skipping`);
  }

  // Step 5: mark fulfilled
  await updatePendingOrder(orderId, {
    status: 'fulfilled',
    fulfilledAt: Date.now(),
    fulfillmentError: null,
  });

  console.log(`[${requestId}] ✅ orderId=${orderId} FULFILLED (waybill=${waybill})`);

  // Audit-trail coupon usage (audit fix M-15). Best-effort — recordCouponUsage
  // internally logs+swallows Firebase errors. Coupon + phone are on the pending
  // record's orderData (populated by the frontend on the initial submission).
  // `record` and `orderData` are already in scope from earlier in this function.
  const redeemedCoupon = orderData?.coupon;
  const customerPhone = orderData?.phone;
  if (redeemedCoupon && customerPhone) {
    await recordCouponUsage(redeemedCoupon, customerPhone, orderId);
  }

  return { status: 'fulfilled', waybill, delhiveryResponse };
}

// ============================================================
// ROUTES
// ============================================================

/**
 * POST /api/checkout/save-order
 * Direct save-to-Sheets route (legacy). Unchanged.
 */
router.post('/save-order', async (req, res) => {
  const requestId = `save_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ success: false, message: 'Request body is required' });
    }
    const orderData = req.body;
    if (!orderData.type || orderData.type !== 'checkout') {
      return res.status(400).json({ success: false, message: 'Invalid order data. Must include type: "checkout"' });
    }
    if (!orderData.orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required' });
    }

    // Input validation (audit fix C-05) — strict mode returns 400, warn mode logs and continues.
    const gate = enforceOrderDataValidation(orderData, res, 'save-order', requestId);
    if (!gate.proceed) return;
    const sanitizedOrderData = { ...orderData, ...gate.cleaned };

    if (!GOOGLE_SHEETS_URL) {
      console.error('[save-order] ❌ GOOGLE_SHEETS_URL not configured');
      return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
    }
    if (!APP_SCRIPT_SHARED_SECRET) {
      console.warn(`[save-order] ⚠️ APP_SCRIPT_SHARED_SECRET unset — request will be rejected by any script with H-11 enforcement. orderId=${sanitizedOrderData.orderId}`);
    }

    console.log(`[save-order] orderId=${sanitizedOrderData.orderId}`);
    // Explicitly stamp `type` so the Apps Script's doPost routes to the
    // checkout handler. Frontend's orderData doesn't carry it; without it,
    // Apps Script returns "Invalid submission type" and no emails send.
    await axios.post(
      GOOGLE_SHEETS_URL,
      {
        ...sanitizedOrderData,
        type: 'checkout',
        products: stampGstRate(sanitizedOrderData.products || []),
        secret: APP_SCRIPT_SHARED_SECRET || '',
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    console.log(`[save-order] ✅ orderId=${sanitizedOrderData.orderId}`);

    return res.json({ success: true, message: 'Order saved successfully', orderId: sanitizedOrderData.orderId });
  } catch (error) {
    console.error('[save-order] ❌ error:', error.response?.data || error.message);
    const statusCode = error.response?.status || 500;
    return res.status(statusCode).json({
      success: false,
      message: 'Failed to save order',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/checkout/process-cod
 * Process a COD order: create Delhivery shipment + save to Sheets. Idempotent.
 */
router.post('/process-cod', processCodIpLimiter, async (req, res) => {
  const requestId = `cod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ success: false, message: 'Request body is required' });
    }
    const { orderData, shipmentData, pickupLocation } = req.body;
    if (!orderData?.orderId) {
      return res.status(400).json({ success: false, message: 'orderData.orderId is required' });
    }
    if (!shipmentData) {
      return res.status(400).json({ success: false, message: 'shipmentData is required' });
    }

    // Input validation (audit fix C-05) — strict mode returns 400, warn mode logs and continues.
    const gate = enforceOrderDataValidation(orderData, res, 'process-cod', requestId);
    if (!gate.proceed) return;
    const sanitizedOrderData = { ...orderData, ...gate.cleaned };

    const orderId = sanitizedOrderData.orderId;
    console.log(`[${requestId}] 🧾 process-cod start: orderId=${orderId}`);

    // Ensure a pending record exists (COD skips the create-order/verify-payment path).
    const existing = await getPendingOrder(orderId);

    // H-01: prove caller ownership before mutating an existing record.
    // First-time COD calls (no existing record) skip the check — there's
    // nothing to compare against; the token is minted on creation below.
    if (existing) {
      const tokenGate = enforceFulfillmentToken({
        pendingRecord: existing,
        suppliedToken: req.body.fulfillmentToken,
        routeTag: 'process-cod',
        requestId,
      });
      if (!tokenGate.ok) {
        return res.status(403).json({
          success: false,
          code: tokenGate.code,
          message: tokenGate.message,
        });
      }
    }

    let newlyMintedToken = null;
    if (!existing) {
      newlyMintedToken = generateFulfillmentToken();
      await createPendingOrder(orderId, {
        source: 'website',
        paymentMode: 'cod',
        status: 'paid', // COD is "paid on delivery" — for our purposes, ready to fulfill immediately
        orderData: sanitizedOrderData,
        shipmentData,
        pickupLocation: pickupLocation || null,
        fulfillmentToken: newlyMintedToken,
      });
    } else {
      await updatePendingOrder(orderId, {
        paymentMode: existing.paymentMode || 'cod',
        status: existing.status === 'fulfilled' ? 'fulfilled' : (existing.status === 'fulfilling' ? existing.status : 'paid'),
        orderData: existing.orderData || sanitizedOrderData,
        shipmentData: existing.shipmentData || shipmentData,
        pickupLocation: existing.pickupLocation || pickupLocation || null,
      });
    }

    const outcome = await fulfillOrder(orderId, requestId);
    return respondFromOutcome(res, orderId, outcome, requestId, undefined, newlyMintedToken);
  } catch (err) {
    console.error(`[${requestId}] ❌ Uncaught error in process-cod:`, err);
    console.error(err.stack);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * POST /api/checkout/process-prepaid
 * Process a prepaid order after Razorpay verification: Delhivery + Sheets. Idempotent.
 */
router.post('/process-prepaid', processPrepaidIpLimiter, processPrepaidOrderIdLimiter, async (req, res) => {
  const requestId = `pre_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ success: false, message: 'Request body is required' });
    }
    const { orderData, shipmentData, pickupLocation, paymentDetails } = req.body;
    if (!orderData?.orderId) {
      return res.status(400).json({ success: false, message: 'orderData.orderId is required' });
    }
    if (!shipmentData) {
      return res.status(400).json({ success: false, message: 'shipmentData is required' });
    }
    if (!paymentDetails) {
      return res.status(400).json({ success: false, message: 'paymentDetails is required for prepaid orders' });
    }

    // Input validation (audit fix C-05) — strict mode returns 400, warn mode logs and continues.
    const gate = enforceOrderDataValidation(orderData, res, 'process-prepaid', requestId);
    if (!gate.proceed) return;
    const sanitizedOrderData = { ...orderData, ...gate.cleaned };

    const orderId = sanitizedOrderData.orderId;
    const paymentId = paymentDetails.payment_id || paymentDetails.id || null;
    console.log(`[${requestId}] 🧾 process-prepaid start: orderId=${orderId} paymentId=${paymentId}`);

    // Ensure a pending record exists. When the (new) frontend supplies orderId
    // to create-order, one exists already. When the (old) frontend doesn't,
    // we create it here — that's the backwards-compatible path.
    const existing = await getPendingOrder(orderId);

    // H-01 hardening (audit finding referenced from C-06): if the pending
    // record was created by our own create-order route (i.e. it has a
    // razorpayOrderId on file) and the caller is presenting a payment for a
    // DIFFERENT Razorpay order, refuse to fulfill. This blocks an attacker
    // with their own paid Razorpay order from pointing it at a victim's
    // pending record. Legacy-flow records (no razorpayOrderId on file) skip
    // this check — nothing to compare against.
    const claimedRzpOrderId = paymentDetails?.order_id || null;
    if (existing && existing.razorpayOrderId && claimedRzpOrderId && existing.razorpayOrderId !== claimedRzpOrderId) {
      console.warn(`[${requestId}] ⛔ razorpay_order_id mismatch for orderId=${orderId}: pending=${existing.razorpayOrderId} caller=${claimedRzpOrderId}`);
      return res.status(403).json({
        success: false,
        code: 'razorpay_order_mismatch',
        message: 'razorpay_order_id does not match the pending order — refusing to fulfill',
      });
    }

    // H-01 fulfillment-token check. Applies only when a pending record exists;
    // legacy lazy-create path (record materialized here for the first time)
    // has nothing to compare against.
    if (existing) {
      const tokenGate = enforceFulfillmentToken({
        pendingRecord: existing,
        suppliedToken: req.body.fulfillmentToken,
        routeTag: 'process-prepaid',
        requestId,
      });
      if (!tokenGate.ok) {
        return res.status(403).json({
          success: false,
          code: tokenGate.code,
          message: tokenGate.message,
        });
      }
    }

    let newlyMintedToken = null;
    if (!existing) {
      // Legacy lazy-create — no create-order predecessor. Mint a token now so
      // any subsequent mutating call (e.g., a retry) can be checked.
      newlyMintedToken = generateFulfillmentToken();
      await createPendingOrder(orderId, {
        source: 'website',
        paymentMode: 'prepaid',
        status: 'paid',
        orderData: sanitizedOrderData,
        shipmentData,
        pickupLocation: pickupLocation || null,
        paymentId,
        razorpayOrderId: claimedRzpOrderId,
        fulfillmentToken: newlyMintedToken,
      });
    } else {
      const nextStatus =
        existing.status === 'fulfilled' ? 'fulfilled'
        : existing.status === 'fulfilling' ? existing.status
        : 'paid';
      await updatePendingOrder(orderId, {
        status: nextStatus,
        paymentId: paymentId || existing.paymentId,
        razorpayOrderId: claimedRzpOrderId || existing.razorpayOrderId,
        // Don't clobber a good snapshot with an incomplete retry payload.
        orderData: existing.orderData || sanitizedOrderData,
        shipmentData: existing.shipmentData || shipmentData,
        pickupLocation: existing.pickupLocation || pickupLocation || null,
      });
    }

    const outcome = await fulfillOrder(orderId, requestId);
    return respondFromOutcome(res, orderId, outcome, requestId, paymentDetails, newlyMintedToken);
  } catch (err) {
    console.error(`[${requestId}] ❌ Uncaught error in process-prepaid:`, err);
    console.error(err.stack);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Translate a fulfillOrder outcome into an HTTP response.
 * - fulfilled/already_fulfilled → 200 with waybill (alreadyFulfilled flag when idempotent replay)
 * - in_progress                 → 409 (client should retry)
 * - error                       → 502 (upstream/downstream failure) or 500 (unknown)
 * We deliberately DO NOT return { success: true } for anything other than
 * fulfilled/already_fulfilled — this is the fix for the "silent duplicate email" bug.
 *
 * @param {string} [newlyMintedToken]  If the caller just materialized a new
 *   pending record (legacy lazy-create path in process-prepaid or first-call
 *   process-cod), pass the freshly-minted fulfillmentToken here. It will be
 *   included in the 200 body so the client can store it for future retries.
 *   Never echo an EXISTING record's token back — the caller should already
 *   have it, and re-issuing expands the token's exposure surface.
 */
function respondFromOutcome(res, orderId, outcome, requestId, paymentDetails, newlyMintedToken) {
  if (outcome.status === 'fulfilled' || outcome.status === 'already_fulfilled') {
    return res.status(200).json({
      success: true,
      orderId,
      waybill: outcome.waybill,
      delhivery: outcome.delhiveryResponse,
      ...(paymentDetails ? { payment: paymentDetails } : {}),
      ...(newlyMintedToken ? { fulfillmentToken: newlyMintedToken } : {}),
      alreadyFulfilled: outcome.status === 'already_fulfilled',
      message: outcome.status === 'already_fulfilled'
        ? 'Order was already fulfilled (idempotent replay)'
        : 'Order processed successfully',
    });
  }
  if (outcome.status === 'in_progress') {
    return res.status(409).json({
      success: false,
      orderId,
      message: 'Order fulfillment already in progress; retry in a moment',
    });
  }
  console.error(`[${requestId}] ❌ orderId=${orderId} outcome=error stage=${outcome.stage} — ${outcome.message}`);
  return res.status(502).json({
    success: false,
    orderId,
    stage: outcome.stage,
    message: outcome.message,
    ...(outcome.remarks ? { remarks: outcome.remarks } : {}),
    ...(outcome.waybill ? { waybill: outcome.waybill } : {}),
  });
}

export default router;
