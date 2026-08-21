import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';

import {
  createPendingOrder,
  getPendingOrder,
  updatePendingOrder,
  isPaymentProcessed,
  markPaymentAsProcessed,
} from '../shared/firebase.js';
import { fulfillOrder } from './checkout.js';
import {
  computeExpectedTotal,
  PRICING_ENFORCEMENT_MODE,
  PRICE_TOLERANCE_PAISE,
} from '../shared/catalog.js';
import {
  generateFulfillmentToken,
  enforceFulfillmentToken,
} from '../shared/order-token.js';
import {
  makeKeyedRateLimiter,
  keyByIp,
  keyByBodyField,
  keyGlobal,
} from '../shared/rate-limit.js';

// Per-route rate limits (audit fix H-07). Numbers per audit table.
const createOrderIpLimiter = makeKeyedRateLimiter({
  routeName: '/api/razorpay/create-order[ip]',       maxRequests: 5,   windowMs: 60_000,
  keyExtractor: keyByIp,
});
const createOrderOrderIdLimiter = makeKeyedRateLimiter({
  routeName: '/api/razorpay/create-order[orderId]',  maxRequests: 10,  windowMs: 60_000,
  keyExtractor: keyByBodyField('orderId'),
  // Legacy calls without orderId: skip this bucket, rely on the IP one.
});
const verifyPaymentIpLimiter = makeKeyedRateLimiter({
  routeName: '/api/razorpay/verify-payment[ip]',     maxRequests: 10,  windowMs: 60_000,
  keyExtractor: keyByIp,
});
const razorpayWebhookGlobalLimiter = makeKeyedRateLimiter({
  routeName: '/api/razorpay/webhook[global]',        maxRequests: 100, windowMs: 60_000,
  keyExtractor: keyGlobal,
});

const router = express.Router();

// Validate environment variables
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.warn('⚠️ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not configured. Payment routes will fail.');
}

let razorpay = null;

try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log('✅ Razorpay initialized successfully');
  }
} catch (error) {
  console.error('❌ Failed to initialize Razorpay:', error.message);
}

/**
 * POST /api/razorpay/create-order
 * Create a Razorpay order.
 *
 * Backwards-compatible fields:
 *   amount              (required, paise)
 *   currency            (optional, default INR)
 *   receipt             (optional)
 *
 * New optional fields (fulfilling the webhook safety net):
 *   orderId             (recommended) website-generated OUO_<ts> id. When present:
 *                       - attached to Razorpay as notes.orderId + notes.source='website'
 *                       - a pending order record is written to Firebase
 *                       - webhook can later fulfill the order without the client
 *   orderData           (optional) snapshot for webhook-driven fulfillment
 *   shipmentData        (optional) snapshot for webhook-driven fulfillment
 *   pickupLocation      (optional) snapshot for webhook-driven fulfillment
 *   notes               (optional) extra notes merged into the Razorpay order
 */
router.post('/create-order', createOrderIpLimiter, createOrderOrderIdLimiter, async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ success: false, message: 'Request body is required' });
    }
    if (!razorpay) {
      console.error('❌ Razorpay not initialized');
      return res.status(503).json({ success: false, message: 'Payment service not configured' });
    }

    const {
      amount,
      currency = 'INR',
      receipt,
      orderId,          // new (optional)
      orderData,        // new (optional)
      shipmentData,     // new (optional)
      pickupLocation,   // new (optional)
      notes: userNotes, // new (optional)
    } = req.body;

    if (!amount) {
      return res.status(400).json({ success: false, message: 'Amount is required' });
    }
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }
    if (amountNum < 100) {
      return res.status(400).json({ success: false, message: 'Amount must be at least ₹1 (100 paise)' });
    }
    const validCurrencies = ['INR', 'USD', 'EUR', 'GBP'];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({ success: false, message: 'Invalid currency. Supported: INR, USD, EUR, GBP' });
    }

    // ------------------------------------------------------------------
    // SERVER-AUTHORITATIVE PRICING (fix for audit finding C-03)
    // ------------------------------------------------------------------
    // Never trust `amount` from the client. Recompute from the catalog and
    // (mode-dependent) reject or overwrite. See catalog.js for the mode
    // semantics. `amountToChargePaise` is what actually goes to Razorpay.
    let amountToChargePaise = Math.round(amountNum); // safe legacy fallback
    let amountSource = 'client';
    let pricingBreakdown = null;
    let pricingResult = null;

    // Locate the cart the client sent. The website frontend sends it as
    // orderData.products; some future callers may send it top-level as `cart`.
    const cartItems = Array.isArray(req.body.cart)
      ? req.body.cart
      : (Array.isArray(orderData?.products) ? orderData.products : null);

    // Shipping is client-declared today (frontend calls
    // /api/delhivery/calculate-shipping before checkout). Convention: rupees
    // in `orderData.shippingCharge`, or paise in `orderData.shippingChargePaise`
    // if a newer client uses that field.
    const clientShippingRupees = Number(orderData?.shippingCharge);
    const clientShippingPaise = Number(orderData?.shippingChargePaise);
    const shippingChargePaise = Number.isFinite(clientShippingPaise) && clientShippingPaise >= 0
      ? Math.round(clientShippingPaise)
      : (Number.isFinite(clientShippingRupees) && clientShippingRupees >= 0
          ? Math.round(clientShippingRupees * 100)
          : 0);

    const couponCode = orderData?.coupon || req.body.coupon || null;

    if (!cartItems || cartItems.length === 0) {
      // Cart is missing entirely. In strict mode this is an immediate reject —
      // we have nothing to price against. In warn/off, log and continue with
      // the client's amount so legacy callers aren't blocked.
      const msg = `[create-order] no cart in request (orderId=${orderId || 'none'}) — cannot server-price`;
      if (PRICING_ENFORCEMENT_MODE === 'strict') {
        console.error(`${msg} — REJECTED (strict mode)`);
        return res.status(400).json({
          success: false,
          message: 'orderData.products (or top-level cart) is required for pricing validation',
        });
      }
      console.warn(`${msg} — accepting client amount (mode=${PRICING_ENFORCEMENT_MODE})`);
    } else {
      pricingResult = computeExpectedTotal({
        items: cartItems,
        shippingChargePaise,
        couponCode,
        paymentMode: 'prepaid', // create-order is prepaid path only
      });

      if (!pricingResult.ok) {
        // Server can't price this cart at all (unknown SKU, invalid qty, etc.)
        if (PRICING_ENFORCEMENT_MODE === 'strict') {
          console.error(`[create-order] pricing_error (strict) orderId=${orderId || 'none'} code=${pricingResult.code} — ${pricingResult.error}`);
          return res.status(400).json({
            success: false,
            message: 'Cart could not be priced by the server',
            code: pricingResult.code,
            detail: pricingResult.detail || null,
          });
        }
        console.warn(`[create-order] pricing_error (mode=${PRICING_ENFORCEMENT_MODE}) orderId=${orderId || 'none'} code=${pricingResult.code} — ${pricingResult.error}. Falling back to client amount.`);
      } else {
        // Successfully priced. Compare client vs server.
        const clientPaise = Math.round(amountNum);
        const serverPaise = pricingResult.total_paise;
        const diff = clientPaise - serverPaise;
        const mismatch = Math.abs(diff) > PRICE_TOLERANCE_PAISE;
        pricingBreakdown = {
          subtotal_paise: pricingResult.subtotal_paise,
          bulk_discount_paise: pricingResult.bulk_discount_paise,
          coupon_discount_paise: pricingResult.coupon_discount_paise,
          shipping_paise: pricingResult.shipping_paise,
          cod_charge_paise: pricingResult.cod_charge_paise,
          total_paise: pricingResult.total_paise,
          all_verified: pricingResult.allVerified,
          cart_hash: pricingResult.cart_hash,
          coupon: pricingResult.coupon,
        };

        if (mismatch) {
          console.warn(
            `[create-order] pricing_mismatch orderId=${orderId || 'none'} ` +
            `client_paise=${clientPaise} server_paise=${serverPaise} diff_paise=${diff} ` +
            `all_verified=${pricingResult.allVerified} mode=${PRICING_ENFORCEMENT_MODE}`
          );
          if (PRICING_ENFORCEMENT_MODE === 'strict') {
            return res.status(400).json({
              success: false,
              message: 'Cart total mismatch — server pricing disagrees with client',
              code: 'pricing_mismatch',
              server_total_paise: serverPaise,
              client_total_paise: clientPaise,
              tolerance_paise: PRICE_TOLERANCE_PAISE,
            });
          }
        } else {
          console.log(`[create-order] pricing_ok orderId=${orderId || 'none'} paise=${serverPaise} all_verified=${pricingResult.allVerified}`);
        }

        // Pick the amount to actually charge.
        //   strict → server always (already validated above).
        //   warn   → server if every SKU has verified=true, else client (safer for unverified catalog rollout).
        //   off    → client (legacy behaviour — no security guarantee).
        if (PRICING_ENFORCEMENT_MODE === 'strict') {
          amountToChargePaise = serverPaise;
          amountSource = 'server';
        } else if (PRICING_ENFORCEMENT_MODE === 'warn' && pricingResult.allVerified) {
          amountToChargePaise = serverPaise;
          amountSource = 'server';
        } else {
          amountToChargePaise = clientPaise;
          amountSource = 'client';
          if (PRICING_ENFORCEMENT_MODE === 'warn' && !pricingResult.allVerified) {
            console.warn(`[create-order] using CLIENT amount because catalog is not fully verified (orderId=${orderId || 'none'})`);
          }
        }
      }
    }

    // Build Razorpay notes. Attach cart hash when available so downstream
    // fulfillment can prove the cart being shipped matches the cart that was priced.
    const notes = { ...(userNotes || {}) };
    if (orderId) {
      notes.orderId = String(orderId);
      notes.source = 'website';
    }
    if (pricingBreakdown?.cart_hash) {
      notes.cart_hash = pricingBreakdown.cart_hash;
    }

    const options = {
      amount: amountToChargePaise,
      currency,
      receipt: receipt || `order_${Date.now()}`,
      payment_capture: 1,
      ...(Object.keys(notes).length ? { notes } : {}),
    };

    console.log(`[create-order] orderId=${orderId || 'none'} amount=${options.amount} ${options.currency} amount_source=${amountSource} mode=${PRICING_ENFORCEMENT_MODE}`);

    const order = await razorpay.orders.create(options);
    console.log(`[create-order] ✅ Razorpay order ${order.id} created (orderId=${orderId || 'none'})`);

    // Persist pending order snapshot so the webhook can recover this order
    // without any further client involvement. Only when the frontend gave us
    // an orderId — the legacy flow (no orderId) keeps working via process-prepaid.
    //
    // H-01: on the first materialization we mint a fulfillmentToken and return
    // it to the caller. Every subsequent mutating call for this orderId must
    // present it (enforced by enforceFulfillmentToken() in the retry branch
    // below and in verify-payment / process-prepaid / process-cod).
    let fulfillmentTokenForResponse = null;
    const requestId = `co_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (orderId) {
      try {
        const newTokenIfCreated = generateFulfillmentToken();

        const createResult = await createPendingOrder(orderId, {
          source: 'website',
          paymentMode: 'prepaid',
          status: 'pending_payment',
          amount: options.amount,
          amount_source: amountSource,             // 'server' | 'client'
          pricing_breakdown: pricingBreakdown,     // null if we couldn't price
          pricing_mode: PRICING_ENFORCEMENT_MODE,
          currency: options.currency,
          razorpayOrderId: order.id,
          orderData: orderData || null,
          shipmentData: shipmentData || null,
          pickupLocation: pickupLocation || null,
          fulfillmentToken: newTokenIfCreated,
        });

        if (createResult.created) {
          // First materialization — return the token so the client can store it.
          fulfillmentTokenForResponse = newTokenIfCreated;
        } else {
          // A pending record already exists for this orderId. Three categories:
          //   (a) Legitimate abandon-and-retry from the SAME client — status is
          //       still 'pending_payment' AND the caller presents a matching
          //       fulfillmentToken. Refresh razorpayOrderId + pricing + snapshot.
          //   (b) Hijack attempt — caller does NOT have the token. In strict
          //       mode: 403. In warn mode: log and proceed (safe rollout).
          //   (c) Double-tap after payment or hijack after payment — status is
          //       past 'pending_payment'. Refuse with 409. (C-06 hardening.)
          const existing = createResult.existing;

          // (c) — status-based lock (C-06)
          if (existing && existing.status && existing.status !== 'pending_payment') {
            console.warn(`[${requestId}] [create-order] ⛔ refusing to modify orderId=${orderId} — status=${existing.status} (past pending_payment). Possible hijack or duplicate submit.`);
            return res.status(409).json({
              success: false,
              code: 'order_already_in_flight',
              message: `Order ${orderId} is ${existing.status}; cannot be re-created. Use a fresh orderId.`,
            });
          }

          // (b) — token binding (H-01)
          const tokenGate = enforceFulfillmentToken({
            pendingRecord: existing,
            suppliedToken: req.body.fulfillmentToken,
            routeTag: 'create-order',
            requestId,
          });
          if (!tokenGate.ok) {
            return res.status(403).json({
              success: false,
              code: tokenGate.code,
              message: tokenGate.message,
            });
          }

          // (a) — legitimate retry. Refresh razorpayOrderId + pricing; preserve
          // existing snapshot unless the caller supplied new values. Never
          // rotate or overwrite fulfillmentToken.
          await updatePendingOrder(orderId, {
            razorpayOrderId: order.id,
            amount: options.amount,
            amount_source: amountSource,
            pricing_breakdown: pricingBreakdown,
            pricing_mode: PRICING_ENFORCEMENT_MODE,
            ...(orderData ? { orderData } : {}),
            ...(shipmentData ? { shipmentData } : {}),
            ...(pickupLocation ? { pickupLocation } : {}),
          });

          // Only re-issue the token to the client if the record actually has
          // one AND the caller presented a valid one (i.e. gate.checked=true &&
          // reason='match'). Otherwise the client already has it (successful
          // retry) or is a grandfathered flow that never had one. Never leak
          // the token to a warn-mode "missing" caller.
          if (existing?.fulfillmentToken && tokenGate.reason === 'match') {
            fulfillmentTokenForResponse = existing.fulfillmentToken;
          }
          console.log(`[${requestId}] [create-order] pending record for ${orderId} already existed (status=${existing?.status}); refreshed razorpayOrderId=${order.id}; token=${tokenGate.reason}`);
        }
      } catch (firebaseErr) {
        console.error(`[${requestId}] [create-order] ⚠️ Failed to write pending order ${orderId} to Firebase — webhook fulfillment disabled for this order:`, firebaseErr.message);
      }
    }

    const responseBody = {
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      },
      key_id: process.env.RAZORPAY_KEY_ID,
    };
    // Only include the token when we minted a fresh one OR the client proved
    // ownership on a legitimate retry. Never included when null.
    if (fulfillmentTokenForResponse) {
      responseBody.fulfillmentToken = fulfillmentTokenForResponse;
    }
    return res.json(responseBody);
  } catch (error) {
    console.error('❌ Razorpay order creation error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create Razorpay order',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/razorpay/verify-payment
 * Verify Razorpay payment signature and, when possible, transition the pending
 * order record to `paid`.
 *
 * Backwards-compatible fields:
 *   razorpay_order_id, razorpay_payment_id, razorpay_signature (all required)
 *
 * New optional field:
 *   orderId   If the frontend passes it, we use it directly to key the pending
 *             record update. If absent, we try to derive it from
 *             payment.notes.orderId returned by the Razorpay API.
 */
router.post('/verify-payment', verifyPaymentIpLimiter, async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ success: false, message: 'Request body is required' });
    }
    if (!razorpay || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('❌ Razorpay not configured properly');
      return res.status(503).json({ success: false, message: 'Payment service not configured' });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId: hintedOrderId, // optional, new
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required payment parameters: razorpay_order_id, razorpay_payment_id, razorpay_signature',
      });
    }
    if (typeof razorpay_order_id !== 'string' || typeof razorpay_payment_id !== 'string' || typeof razorpay_signature !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid parameter types' });
    }

    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest('hex');

    // Length-guarded constant-time comparison — timingSafeEqual throws on
    // mismatched lengths, and equal-length buffers force the timing property.
    let isValid = false;
    if (expectedSign.length === razorpay_signature.length) {
      isValid = crypto.timingSafeEqual(Buffer.from(expectedSign), Buffer.from(razorpay_signature));
    }

    if (!isValid) {
      console.error(`[verify-payment] ❌ Invalid signature for razorpay_order_id=${razorpay_order_id}`);
      return res.status(400).json({ success: false, verified: false, message: 'Invalid payment signature' });
    }

    console.log(`[verify-payment] ✅ Signature valid — razorpay_order_id=${razorpay_order_id}, payment_id=${razorpay_payment_id}`);

    // Fetch payment details from Razorpay. This gives us notes.orderId when
    // create-order attached it, and is our source of truth for method/status.
    let payment = null;
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (fetchError) {
      console.warn(`[verify-payment] ⚠️ Signature valid but payment fetch failed for ${razorpay_payment_id}:`, fetchError.message);
    }

    const notesOrderId = payment?.notes?.orderId || null;
    const orderId = hintedOrderId || notesOrderId || null;

    // Best-effort transition of the pending record → 'paid'. This is a hint,
    // not the source of truth — the webhook is authoritative. Failure here
    // MUST NOT block the client, so we swallow with a loud log.
    if (orderId) {
      try {
        const existing = await getPendingOrder(orderId);
        if (existing) {
          // H-01: prove the caller owns this order before mutating its state.
          // Grandfathered records without a token skip the check.
          const requestId = `vp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const tokenGate = enforceFulfillmentToken({
            pendingRecord: existing,
            suppliedToken: req.body.fulfillmentToken,
            routeTag: 'verify-payment',
            requestId,
          });
          if (!tokenGate.ok) {
            return res.status(403).json({
              success: false,
              code: tokenGate.code,
              message: tokenGate.message,
            });
          }
          if (existing.status !== 'fulfilled' && existing.status !== 'fulfilling') {
            await updatePendingOrder(orderId, {
              status: 'paid',
              paymentId: razorpay_payment_id,
              razorpayOrderId: razorpay_order_id,
              paidAt: Date.now(),
            });
            console.log(`[verify-payment] pending order ${orderId} transitioned ${existing.status} → paid`);
          } else {
            console.log(`[verify-payment] pending order ${orderId} already ${existing.status}; no status change`);
          }
        } else {
          // Legacy flow: create-order didn't write a pending record (frontend
          // hasn't been updated yet). We don't create it here because we don't
          // have the orderData/shipmentData snapshot — process-prepaid will
          // create it lazily with the full snapshot.
          console.log(`[verify-payment] no pending record for orderId=${orderId} — legacy flow, process-prepaid will create it`);
        }
      } catch (fbErr) {
        console.error(`[verify-payment] ⚠️ Failed to update pending order ${orderId} in Firebase:`, fbErr.message);
      }
    }

    return res.json({
      success: true,
      verified: true,
      payment: payment ? {
        id: payment.id,
        order_id: payment.order_id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        method: payment.method,
        email: payment.email,
        contact: payment.contact,
        created_at: payment.created_at,
        notes: payment.notes || null,
      } : {
        id: razorpay_payment_id,
        order_id: razorpay_order_id,
      },
    });
  } catch (error) {
    console.error('❌ Payment verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/razorpay/payment/:paymentId
 * Fetch payment details
 */
router.get('/payment/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    // Validate paymentId
    if (!paymentId || typeof paymentId !== 'string' || paymentId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment ID',
      });
    }

    // Check if Razorpay is initialized
    if (!razorpay) {
      console.error('❌ Razorpay not initialized');
      return res.status(503).json({
        success: false,
        message: 'Payment service not configured',
      });
    }

    console.log('Fetching payment details for:', paymentId);

    const payment = await razorpay.payments.fetch(paymentId);

    console.log('✅ Payment details fetched successfully');

    return res.json({
      success: true,
      payment,
    });
  } catch (error) {
    console.error('❌ Error fetching payment:', error);

    // Check if it's a 404 (payment not found)
    if (error.statusCode === 404 || error.error?.code === 'BAD_REQUEST_ERROR') {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payment details',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/razorpay/webhook
 * Razorpay-delivered webhook. Signature-verified. Handles website-sourced
 * payments (notes.source === 'website'); ignores everything else.
 *
 * Handled events:
 *   payment.captured  → run fulfillment (Delhivery + Sheets), idempotent
 *   payment.failed    → mark pending record as payment_failed
 *
 * Response codes matter here:
 *   200  we've handled or intentionally ignored the event; Razorpay will stop retrying
 *   401  signature mismatch — Razorpay will retry (may indicate config drift)
 *   500  unhandled server error — Razorpay will retry
 * We deliberately DO NOT return 5xx for business-logic failures (fulfillment
 * errors etc.). Those are captured on the pending record for out-of-band retry;
 * making Razorpay retry them buys nothing.
 */
router.post('/webhook', razorpayWebhookGlobalLimiter, async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[razorpay-webhook] ❌ RAZORPAY_WEBHOOK_SECRET not configured — refusing to process.');
      return res.status(503).json({ success: false, message: 'Webhook secret not configured' });
    }

    const signature = req.get('X-Razorpay-Signature');
    if (!signature) {
      console.warn('[razorpay-webhook] ⚠️ missing X-Razorpay-Signature header');
      return res.status(400).json({ success: false, message: 'Missing signature' });
    }

    // The global express.json({ verify }) middleware in app.js stashes the raw
    // request body on req.rawBody. That's what we HMAC — parsed JSON is NOT
    // byte-identical to what Razorpay signed.
    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : (req.body ? JSON.stringify(req.body) : '');

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    let valid = false;
    if (expected.length === signature.length) {
      try {
        valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      console.warn('[razorpay-webhook] ⚠️ signature mismatch — rejecting');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const payload = req.body || {};
    const event = payload.event;
    const payment = payload.payload?.payment?.entity || null;
    const paymentId = payment?.id || null;
    const notes = payment?.notes || {};
    const orderId = notes.orderId || null;
    const source = notes.source || null;

    console.log(`[razorpay-webhook] event=${event} paymentId=${paymentId} orderId=${orderId} source=${source}`);

    // Route: only website-sourced payments are our responsibility here. WhatsApp
    // bot payments are handled by app.js /payments-webhook — if the Razorpay
    // dashboard delivers non-website events to this URL too, we acknowledge
    // and move on so Razorpay doesn't retry.
    if (source !== 'website') {
      console.log(`[razorpay-webhook] ignoring — source is not 'website' (source=${source})`);
      return res.sendStatus(200);
    }

    if (!orderId) {
      console.error(`[razorpay-webhook] 🚨 website payment with no notes.orderId — cannot fulfill. paymentId=${paymentId}`);
      // 200 so Razorpay stops retrying; nothing we do server-side will fix a payload with no orderId.
      return res.sendStatus(200);
    }

    // Idempotency: same paymentId can't be processed twice.
    if (paymentId) {
      try {
        if (await isPaymentProcessed(paymentId)) {
          console.log(`[razorpay-webhook] paymentId ${paymentId} already processed — skipping`);
          return res.sendStatus(200);
        }
      } catch (fbErr) {
        console.error(`[razorpay-webhook] ⚠️ isPaymentProcessed check failed for ${paymentId}; proceeding without guard:`, fbErr.message);
      }
    }

    if (event === 'payment.captured' || event === 'payment.authorized') {
      const pending = await getPendingOrder(orderId);
      if (!pending) {
        console.error(`[razorpay-webhook] 🚨 pending order ${orderId} not found (paymentId=${paymentId}) — cannot fulfill from webhook. Manual reconciliation needed.`);
        if (paymentId) {
          try { await markPaymentAsProcessed(paymentId); } catch {}
        }
        return res.sendStatus(200);
      }

      await updatePendingOrder(orderId, {
        status: pending.status === 'fulfilled' ? 'fulfilled' : 'paid',
        paymentId,
        paidAt: pending.paidAt || Date.now(),
      });

      if (!pending.orderData || !pending.shipmentData) {
        // Legacy flow: create-order was called without the snapshot, so the
        // webhook can't independently fulfill. process-prepaid will still run
        // when the client eventually calls it. Log and stand down.
        console.warn(`[razorpay-webhook] pending order ${orderId} has no orderData/shipmentData snapshot — cannot self-fulfill. Waiting for process-prepaid.`);
        if (paymentId) {
          try { await markPaymentAsProcessed(paymentId); } catch {}
        }
        return res.sendStatus(200);
      }

      let outcome;
      try {
        outcome = await fulfillOrder(orderId, `webhook_${paymentId || orderId}`);
      } catch (fulfillErr) {
        console.error(`[razorpay-webhook] ❌ fulfillOrder threw for ${orderId}:`, fulfillErr);
        // Don't mark payment processed — allow client-initiated retry via process-prepaid.
        return res.sendStatus(200);
      }

      if (outcome.status === 'fulfilled' || outcome.status === 'already_fulfilled') {
        if (paymentId) {
          try { await markPaymentAsProcessed(paymentId); } catch (e) {
            console.error(`[razorpay-webhook] ⚠️ markPaymentAsProcessed failed for ${paymentId}:`, e.message);
          }
        }
        console.log(`[razorpay-webhook] ✅ ${outcome.status} for orderId=${orderId}, waybill=${outcome.waybill}`);
      } else {
        // in_progress OR error — leave paymentId unmarked so a subsequent
        // process-prepaid or webhook retry can complete it.
        console.warn(`[razorpay-webhook] fulfillment outcome for ${orderId}: ${outcome.status} (${outcome.message || ''})`);
      }
      return res.sendStatus(200);
    }

    if (event === 'payment.failed') {
      try {
        await updatePendingOrder(orderId, {
          status: 'payment_failed',
          paymentId,
          paymentFailedAt: Date.now(),
        });
      } catch (fbErr) {
        console.error(`[razorpay-webhook] ⚠️ failed to mark ${orderId} payment_failed:`, fbErr.message);
      }
      if (paymentId) {
        try { await markPaymentAsProcessed(paymentId); } catch {}
      }
      console.log(`[razorpay-webhook] ❌ payment.failed recorded for orderId=${orderId}`);
      return res.sendStatus(200);
    }

    // Other events (refunds, disputes, etc.) — acknowledge, no action here.
    console.log(`[razorpay-webhook] event ${event} not handled — acknowledging`);
    return res.sendStatus(200);
  } catch (err) {
    console.error('[razorpay-webhook] ❌ CRITICAL unhandled error:', err);
    console.error(err.stack);
    // 500 so Razorpay retries — this covers transient failures we couldn't classify.
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

export default router;
