// catalog.js
// -----------------------------------------------------------------------------
// Server-authoritative product catalog and pricing helpers.
//
// This module is the ONLY source of truth for prices when computing what to
// charge a customer via Razorpay. Client-supplied prices/totals are treated
// as UNTRUSTED and must be cross-checked against these values.
//
// SECURITY CONTRACT
//   - Every product entry has a `price_paise` (integer, in paise).
//   - Every product entry has a `verified` boolean. `verified: true` means the
//     price has been checked against the business source of truth. `false`
//     means the value is a best-effort placeholder.
//   - Callers should treat `verified: false` prices as untrusted and use the
//     `warn` enforcement mode until all products are verified.
//
// UNITS
//   - All monetary values in this module are INTEGER PAISE. No floats. Ever.
//   - Rupees appear only when explicitly converting to/from client payloads.
//
// -----------------------------------------------------------------------------

import crypto from 'crypto';

// ============================================================================
// PRODUCTS
// ============================================================================
// Canonical keys are the WhatsApp catalog retailer_ids (used by app.js's
// getProductName/getProductWeight maps — kept in sync intentionally).
//
// TODO(pricing): every entry marked `verified: false` MUST be reviewed against
// the shop's source of truth (Shopify admin, price sheet, whatever is
// authoritative) BEFORE promoting PRICING_ENFORCEMENT_MODE to `strict`.
// Once verified, flip `verified: true`.
export const PRODUCTS = Object.freeze({
  '43mypu8dye': { name: 'Himalayan Badri Cow Ghee', size: '120gm',  weight_g: 120,  price_paise: 45000,     verified: true, gst_rate: 5 },
  'l722c63kq9': { name: 'Himalayan Badri Cow Ghee', size: '295gm',  weight_g: 295,  price_paise: 106700, verified: true, gst_rate: 5 },
  'kkii6r9uvh': { name: 'Himalayan Badri Cow Ghee', size: '495gm',  weight_g: 495,  price_paise: 179500,     verified: true, gst_rate: 5 },
  'm519x5gv9s': { name: 'Himalayan White Rajma',    size: '500gm',  weight_g: 500,  price_paise: 34700, verified: true, gst_rate: 5 },
  '294l11gpcm': { name: 'Himalayan White Rajma',    size: '1kg',    weight_g: 1000, price_paise: 69100, verified: true, gst_rate: 5 },
  'ezg1lu6edm': { name: 'Himalayan Red Rajma',      size: '500gm',  weight_g: 500,  price_paise: 34700, verified: true, gst_rate: 5 },
  'tzz72lpzz2': { name: 'Himalayan Red Rajma',      size: '1kg',    weight_g: 1000, price_paise: 69100, verified: true, gst_rate: 5 },
  'esltl7pftq': { name: 'Wild Himalayan Tempering Spice', size: '100gm', weight_g: 100, price_paise: 34700, verified: true, gst_rate: 5 },
  'obdqyehm1w': { name: 'Himalayan Red Rice',       size: '1kg',    weight_g: 1000, price_paise: 34700, verified: true, gst_rate: 5 },
  '5diu7mcmbf': { name: 'Himalayan Black Soyabean', size: '500gm',  weight_g: 500,  price_paise: 34700, verified: true, gst_rate: 5 },
  '324pmzr4c9': { name: 'Himalayan Black Soyabean', size: '1kg',    weight_g: 1000, price_paise: 69100, verified: true, gst_rate: 5 },
});

// ============================================================================
// COUPONS (audit fix M-15 — single source of truth)
// ============================================================================
// Every coupon config lives here. The duplicate definition previously in
// app.js has been removed; both the bot (app.js) and the website checkout
// (via shared/catalog.js#computeExpectedTotal) resolve coupons through this
// module.
//
// Schema per coupon:
//   percent_off       — integer 1-100. Discount as % of order subtotal.
//   description       — free text shown to customer.
//   expires_at        — epoch ms after which the coupon is invalid, or null
//                       for no expiry. Checked by validateCoupon().
//   min_order_paise   — minimum order subtotal (before discount) required
//                       for the coupon to apply, or null for no minimum.
//   per_user_limit    — max number of times ONE customer (identified by
//                       phone) can redeem this coupon, or null for unlimited.
//                       Enforced by validateCouponForUser() via Firebase.
//
// Adding / changing a coupon requires a code deploy. If you need runtime
// mutability (admin UI etc.), migrate the map to Firebase — the validator
// signature would stay the same, only the lookup changes.
export const COUPONS = Object.freeze({
  OUO10: {
    percent_off: 10,
    description: '10% OFF',
    expires_at: null,
    min_order_paise: null,
    per_user_limit: null,
  },
  // Added as part of the coupon-consolidation phase — previously lived only
  // on the frontend (coupon.js) which caused drift: server validation would
  // return `unknown_coupon` for HER11 in strict mode.
  HER11: {
    percent_off: 11,
    description: "Women's Day 11% OFF",
    expires_at: null,
    min_order_paise: null,
    per_user_limit: null,
  },
});

// ============================================================================
// PRICING CONSTANTS
// ============================================================================
// COD charge is env-overridable (audit fix M-15). Set COD_CHARGE_PAISE in
// .env if the ops fee changes; no code deploy required. Default matches the
// value previously hardcoded across the bot + website flows.
const _rawCodCharge = Number.parseInt(process.env.COD_CHARGE_PAISE ?? '', 10);
export const COD_CHARGE_PAISE          = Number.isFinite(_rawCodCharge) && _rawCodCharge >= 0
  ? _rawCodCharge
  : 15000;   // ₹150 default
export const BULK_DISCOUNT_THRESHOLD_G = 3000;    // matches app.js:1666
export const BULK_DISCOUNT_RATE        = 0.20;    // 20% off — matches app.js:1666
export const MAX_SHIPPING_CHARGE_PAISE = 50000;   // ₹500 cap on client-declared shipping
export const PRICE_TOLERANCE_PAISE     = 100;     // ₹1 mismatch tolerance for client vs server
// Free-shipping-over-threshold rule (audit fix M-17). Previously hardcoded
// as `1000 * 100` in app.js; extracted here so bot and website flows can
// share the same threshold and it can be changed in exactly one place.
export const FREE_SHIPPING_THRESHOLD_PAISE = 100000; // ₹1000

// ============================================================================
// ENFORCEMENT MODE (env-driven)
// ============================================================================
//   strict  — reject on any mismatch or unverified SKU; always send server total to Razorpay
//   warn    — log mismatches; send server total when all SKUs verified, else client total
//   off     — no validation; send client total (legacy behaviour). Emergency only.
const RAW_MODE = String(process.env.PRICING_ENFORCEMENT_MODE || 'warn').toLowerCase().trim();
export const PRICING_ENFORCEMENT_MODE = ['strict', 'warn', 'off'].includes(RAW_MODE) ? RAW_MODE : 'warn';
if (RAW_MODE !== PRICING_ENFORCEMENT_MODE && RAW_MODE) {
  console.warn(`⚠️ [catalog] PRICING_ENFORCEMENT_MODE="${RAW_MODE}" is invalid; defaulting to "warn"`);
}
console.log(`[catalog] pricing enforcement mode: ${PRICING_ENFORCEMENT_MODE}`);

// ============================================================================
// LOOKUP / NORMALIZATION
// ============================================================================

function normalizeString(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]/g, '')
    .trim();
}

function normalizeName(name) {
  // Strip leading "himalayan" so "Badri Cow Ghee" and "Himalayan Badri Cow Ghee" collide.
  return normalizeString(name).replace(/^himalayan\s+/, '');
}

function normalizeSize(size) {
  // Unify "gm" / "g" / "gms" and "kg" / "kilogram"; strip whitespace.
  const s = normalizeString(size);
  if (!s) return '';
  return s
    .replace(/\bkilograms?\b|\bkgs?\b/g, 'kg')
    .replace(/\bgrams?\b|\bgms?\b|\bg\b/g, 'gm')
    .replace(/\s+/g, '');
}

// Build reverse indexes at module load. Both indexes are frozen.
const _bySku = PRODUCTS;
const _byNameSize = new Map();
for (const [sku, product] of Object.entries(PRODUCTS)) {
  const key = `${normalizeName(product.name)}|${normalizeSize(product.size)}`;
  if (_byNameSize.has(key)) {
    // Two SKUs collide on (name, size). Fatal at boot — indicates a catalog bug.
    throw new Error(`[catalog] duplicate name/size key "${key}" (sku=${sku})`);
  }
  _byNameSize.set(key, { sku, ...product });
}

/**
 * Resolve a product by SKU (retailer_id) OR by (name, size). Returns null if
 * no match. Never throws.
 */
export function resolveProduct({ sku, name, size } = {}) {
  if (sku && _bySku[sku]) {
    return { sku, ..._bySku[sku] };
  }
  if (name) {
    const key = `${normalizeName(name)}|${normalizeSize(size)}`;
    const hit = _byNameSize.get(key);
    if (hit) return hit;
  }
  return null;
}

// ============================================================================
// COUPON VALIDATION
// ============================================================================

/**
 * Sync coupon validator — checks existence, expiry, and (if orderAmountPaise
 * is supplied) min-order-value. Per-user-limit is Firebase-backed and lives
 * in validateCouponForUser() below.
 *
 * @param {string} couponCode
 * @param {object} [opts]
 * @param {number} [opts.orderAmountPaise]  Pre-discount order subtotal. If
 *                                          set, min_order_paise is enforced.
 * @returns {null | {ok:true, code, percent_off, description}
 *               | {ok:false, code, reason:'expired'|'min_order_not_met',
 *                  ...detail}}
 *          Returns `null` (not {ok:false}) when the code doesn't exist —
 *          preserves backward-compat with callers that used truthy checks
 *          before we added structured failures.
 */
export function validateCoupon(couponCode, { orderAmountPaise = null } = {}) {
  if (!couponCode || typeof couponCode !== 'string') return null;
  const normalized = couponCode.trim().toUpperCase();
  const coupon = COUPONS[normalized];
  if (!coupon) return null;

  const now = Date.now();
  if (coupon.expires_at != null && now > coupon.expires_at) {
    return { ok: false, code: normalized, reason: 'expired', expires_at: coupon.expires_at };
  }

  if (
    coupon.min_order_paise != null &&
    orderAmountPaise != null &&
    Number.isFinite(orderAmountPaise) &&
    orderAmountPaise < coupon.min_order_paise
  ) {
    return {
      ok: false,
      code: normalized,
      reason: 'min_order_not_met',
      min_order_paise: coupon.min_order_paise,
      order_amount_paise: orderAmountPaise,
    };
  }

  return {
    ok: true,
    code: normalized,
    percent_off: coupon.percent_off,
    description: coupon.description,
  };
}

/**
 * Async coupon validator with per-user-limit enforcement (audit fix M-15).
 * Wraps sync validateCoupon() and additionally consults Firebase to enforce
 * per_user_limit. Callers who don't have a phone (server-side pricing where
 * only the cart is known) should keep using the sync validateCoupon() —
 * per-user-limit can only be enforced when the identity is known.
 *
 * Firebase failure is treated as fail-open on the per-user check (log +
 * proceed) — a Firebase outage should not block legitimate purchases. The
 * subsequent recordCouponUsage() call at fulfillment time still creates the
 * audit trail once Firebase recovers.
 *
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.phone               Normalized phone (E.164 or digits).
 * @param {number} [args.orderAmountPaise]
 * @param {(code, phone) => Promise<number>} args.getCouponUsageCount
 *        Injected Firebase helper (avoids catalog.js depending on firebase.js).
 * @returns {Promise<null | {ok:true,...} | {ok:false, reason,...}>}
 */
export async function validateCouponForUser({
  code,
  phone,
  orderAmountPaise = null,
  getCouponUsageCount,
}) {
  const syncResult = validateCoupon(code, { orderAmountPaise });
  if (syncResult === null || syncResult.ok === false) return syncResult;

  // syncResult.ok === true beyond this point.
  const coupon = COUPONS[syncResult.code];
  if (coupon.per_user_limit == null || !phone) return syncResult;

  if (typeof getCouponUsageCount !== 'function') {
    throw new Error('validateCouponForUser: getCouponUsageCount function is required for per-user-limit checks');
  }

  let usageCount = 0;
  try {
    usageCount = await getCouponUsageCount(syncResult.code, phone);
  } catch (err) {
    console.warn(`[validateCouponForUser] getCouponUsageCount failed for code=${syncResult.code} phone_prefix=${String(phone).slice(0, 4)}****: ${err?.message || err} — failing OPEN (allowing coupon)`);
    return syncResult;
  }

  if (usageCount >= coupon.per_user_limit) {
    return {
      ok: false,
      code: syncResult.code,
      reason: 'per_user_limit_reached',
      per_user_limit: coupon.per_user_limit,
      usage_count: usageCount,
    };
  }
  return syncResult;
}

// ============================================================================
// PRICING
// ============================================================================

/**
 * Compute the authoritative order total from a client-supplied cart.
 *
 * @param {object} args
 * @param {Array<{sku?:string, name?:string, size?:string, quantity:number}>} args.items
 *        Cart line items. Each MUST have quantity >= 1. sku or (name, size) required.
 * @param {number}   [args.shippingChargePaise=0]  Client-declared shipping (capped by MAX_SHIPPING_CHARGE_PAISE).
 * @param {string}   [args.couponCode]             Optional coupon code.
 * @param {'prepaid'|'cod'} [args.paymentMode='prepaid']
 *
 * @returns {{
 *   ok: true,
 *   allVerified: boolean,
 *   itemsPriced: Array<{sku, name, size, quantity, unit_price_paise, line_total_paise, verified}>,
 *   subtotal_paise: number,
 *   bulk_discount_paise: number,
 *   coupon_discount_paise: number,
 *   total_discount_paise: number,
 *   shipping_paise: number,
 *   cod_charge_paise: number,
 *   total_paise: number,
 *   coupon: {code, percent_off, description} | null,
 *   cart_hash: string,
 * } | {
 *   ok: false,
 *   error: string,
 *   code: 'empty_cart' | 'invalid_qty' | 'unknown_product',
 *   detail?: object,
 * }}
 */
export function computeExpectedTotal({
  items,
  shippingChargePaise = 0,
  couponCode = null,
  paymentMode = 'prepaid',
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: 'empty_cart', error: 'cart is empty' };
  }

  const itemsPriced = [];
  let subtotal_paise = 0;
  let total_weight_g = 0;
  let allVerified = true;

  for (const item of items) {
    const qty = Number.isFinite(item.quantity) ? Math.trunc(item.quantity) : NaN;
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
      return {
        ok: false,
        code: 'invalid_qty',
        error: `invalid quantity for ${item.name || item.sku || '<unknown>'}: ${item.quantity}`,
      };
    }

    const product = resolveProduct({ sku: item.sku, name: item.name, size: item.size });
    if (!product) {
      return {
        ok: false,
        code: 'unknown_product',
        error: `unknown product: name="${item.name}" size="${item.size}" sku="${item.sku || ''}"`,
        detail: { name: item.name, size: item.size, sku: item.sku || null },
      };
    }

    const unit_price_paise = product.price_paise;
    const line_total_paise = unit_price_paise * qty;

    itemsPriced.push({
      sku: product.sku,
      name: product.name,
      size: product.size,
      quantity: qty,
      unit_price_paise,
      line_total_paise,
      verified: product.verified === true,
    });

    subtotal_paise += line_total_paise;
    total_weight_g += (product.weight_g || 0) * qty;
    if (!product.verified) allVerified = false;
  }

  // Bulk discount: 20% off subtotal when total weight >= 3kg.
  const bulk_discount_paise = total_weight_g >= BULK_DISCOUNT_THRESHOLD_G
    ? Math.round(subtotal_paise * BULK_DISCOUNT_RATE)
    : 0;

  // Coupon discount: applied to the post-bulk-discount subtotal (matches
  // the "cascading discount" observed in the WhatsApp bot flow). Passes the
  // pre-discount subtotal into validateCoupon so min_order_paise is enforced
  // consistently with the audit-fix M-15 schema. Returns:
  //   null           — no code / unknown code (silent skip, backward-compat)
  //   {ok:false,…}   — known code but expired or below min_order (silent skip;
  //                    strict-mode enforcement lives at the bot/checkout
  //                    boundary where we can surface a user-facing message)
  //   {ok:true,…}    — apply discount
  const coupon = validateCoupon(couponCode, { orderAmountPaise: subtotal_paise });
  const coupon_discount_paise = coupon && coupon.ok
    ? Math.round((subtotal_paise - bulk_discount_paise) * (coupon.percent_off / 100))
    : 0;

  const total_discount_paise = bulk_discount_paise + coupon_discount_paise;

  // Shipping — client-declared but capped and clamped. Cannot go negative.
  const shippingRaw = Number(shippingChargePaise);
  const shipping_paise = Number.isFinite(shippingRaw) && shippingRaw > 0
    ? Math.min(Math.round(shippingRaw), MAX_SHIPPING_CHARGE_PAISE)
    : 0;

  const cod_charge_paise = paymentMode === 'cod' ? COD_CHARGE_PAISE : 0;

  const total_paise =
    subtotal_paise
    - total_discount_paise
    + shipping_paise
    + cod_charge_paise;

  const cart_hash = cartHash(itemsPriced);

  return {
    ok: true,
    allVerified,
    itemsPriced,
    subtotal_paise,
    bulk_discount_paise,
    coupon_discount_paise,
    total_discount_paise,
    shipping_paise,
    cod_charge_paise,
    total_paise,
    coupon,
    cart_hash,
  };
}

/**
 * Deterministic SHA-256 hash of a priced cart. Used to stamp Razorpay notes
 * and the Firebase pending record so process-prepaid / the webhook can prove
 * the cart being fulfilled matches the cart that was paid for.
 */
export function cartHash(itemsPriced) {
  // Canonicalize: sort by sku, take only the fields that affect price.
  const canonical = [...itemsPriced]
    .map(i => ({ sku: i.sku, qty: i.quantity, unit: i.unit_price_paise }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

// ============================================================================
// GST STAMPING (audit fix M-16)
// ============================================================================
// Server-authoritative GST rate injection. The Apps Script invoice renderer
// (app-script.js#generateInvoicePDF) previously hardcoded a `/1.05` divisor
// to invert an implicit 5% rate — brittle if pricing model ever changes.
// Every payload sent to the Apps Script is now augmented with per-line
// `gst_rate` from this catalog so the invoice can compute net/tax explicitly.
//
// Callers: app.js#sendOrderToAppScript, website/checkout.js#saveOrderToSheets,
// website/checkout.js /save-order route.

/**
 * Return a copy of `products` with each entry augmented by `gst_rate` from
 * the catalog. Idempotent: an existing `gst_rate` on the input is preserved.
 * Falls back to 5 (the historical implicit rate) if the SKU / name+size is
 * not in the catalog — safe because the current invoice math also defaults
 * to 5 for unknown-rate lines.
 *
 * @param {Array<{sku?:string, product_retailer_id?:string, name?:string, size?:string, gst_rate?:number}>} products
 * @returns {Array}  A new array; input is not mutated.
 */
export function stampGstRate(products) {
  if (!Array.isArray(products)) return products;
  return products.map((p) => {
    if (p && typeof p.gst_rate === 'number' && Number.isFinite(p.gst_rate)) {
      return p; // already stamped — respect it (test fixtures, retries)
    }
    const catalog = resolveProduct({
      sku: p?.sku || p?.product_retailer_id,
      name: p?.name,
      size: p?.size,
    });
    const rate = catalog?.gst_rate;
    return {
      ...p,
      gst_rate: Number.isFinite(rate) ? rate : 5,
    };
  });
}

// ============================================================================
// PRICING RULE HELPERS (audit fix M-17)
// ============================================================================
// Single-source-of-truth primitives for business rules that were previously
// hardcoded across the bot COD/prepaid paths and the website checkout. Any
// change (raise bulk discount threshold, tune free-shipping cutoff) is now
// a one-line edit here that both flows pick up.

/**
 * Compute the bulk-discount amount in paise. Returns 0 when the weight is
 * below the threshold. Matches the rule inlined in computeExpectedTotal.
 */
export function computeBulkDiscount(subtotalPaise, weightG) {
  const subtotal = Number(subtotalPaise);
  const weight = Number(weightG);
  if (!Number.isFinite(subtotal) || subtotal <= 0) return 0;
  if (!Number.isFinite(weight) || weight < BULK_DISCOUNT_THRESHOLD_G) return 0;
  return Math.round(subtotal * BULK_DISCOUNT_RATE);
}

/**
 * True when an order (post-discount, pre-COD-charge) qualifies for free
 * shipping. Previously the bot's hardcoded `session.amount > 1000 * 100`.
 */
export function shouldWaiveShipping(orderAmountPaise) {
  const amount = Number(orderAmountPaise);
  return Number.isFinite(amount) && amount >= FREE_SHIPPING_THRESHOLD_PAISE;
}

// ============================================================================
// PUBLIC CONFIG PROJECTION (frontend-facing)
// ============================================================================
// The frontend needs a stable, minimal view of the coupon catalog so it can
// display + validate at cart-review time. It MUST NOT see enforcement-side
// fields (expires_at, min_order_paise, per_user_limit) — those are decided
// server-side; the frontend has no legitimate use for them and disclosing
// them would let an attacker probe the ruleset.

/**
 * Whitelisted coupon projection safe to expose over HTTP. Always returns a
 * fresh array (no shared references into the frozen COUPONS map) so the
 * caller can serialize / mutate defensively.
 */
export function getPublicCouponConfig() {
  return Object.entries(COUPONS).map(([code, c]) => ({
    code,
    percent_off: c.percent_off,
    description: c.description,
  }));
}

/**
 * Whitelisted product projection safe to expose over HTTP. Never leak
 * `gst_rate` (enforcement-side — the invoice renderer needs it, the browser
 * doesn't). `verified` IS exposed so a dev/admin build can visually flag
 * unverified rows, and so the frontend can defensively hide `price_paise: 0`
 * placeholders if it chooses to.
 *
 * IMPORTANT: some catalog entries currently have `price_paise: 0` as
 * placeholders (unverified prices). Those will serialize as-is here. The
 * frontend consuming this endpoint must decide whether to render them or
 * suppress them — see the boot warning below.
 */
export function getPublicProductConfig() {
  return Object.entries(PRODUCTS).map(([sku, p]) => ({
    sku,
    name: p.name,
    size: p.size,
    weight_g: p.weight_g,
    price_paise: p.price_paise,
    verified: p.verified === true,
  }));
}

/**
 * Pricing-rule primitives the frontend needs to render the cart summary
 * consistently with what the backend will compute. Every value here is
 * already a safe-to-expose business rule (thresholds, rates, caps) — no
 * secrets.
 */
export function getPublicPricingConfig() {
  return {
    bulk_discount_threshold_g:      BULK_DISCOUNT_THRESHOLD_G,
    bulk_discount_rate:             BULK_DISCOUNT_RATE,
    free_shipping_threshold_paise:  FREE_SHIPPING_THRESHOLD_PAISE,
    cod_charge_paise:               COD_CHARGE_PAISE,
    max_shipping_charge_paise:      MAX_SHIPPING_CHARGE_PAISE,
  };
}

// Boot-time integrity warning for the frontend's newly-authoritative source
// of pricing. Any product with price_paise <= 0 will render as ₹0 in the
// browser once the frontend fully switches to /api/config as its price
// source — a bad UX and potential exploit vector. Loud log at boot ensures
// the operator notices before promoting PRICING_ENFORCEMENT_MODE to strict.
const _zeroPricedSkus = Object.entries(PRODUCTS)
  .filter(([, p]) => !(Number.isFinite(p.price_paise) && p.price_paise > 0))
  .map(([sku]) => sku);
if (_zeroPricedSkus.length > 0) {
  console.warn(
    `⚠️ [catalog] ${_zeroPricedSkus.length} product(s) have price_paise <= 0: ${_zeroPricedSkus.join(', ')}. ` +
    'These will serialize as ₹0 in GET /api/config. Verify and set real prices in shared/catalog.js before flipping PRICING_ENFORCEMENT_MODE to strict.'
  );
}

/**
 * Stable version identifier for the public config payload. Used as an ETag
 * so browsers / CDNs can revalidate cheaply — regenerates naturally on any
 * config change (new coupon, edited percent_off, price bump, rule tweak) via
 * the sha256 hash of the full public payload.
 *
 * Computed at module load. The input MUST fold in every field the endpoint
 * serves — coupons + products + pricing today, plus discount_config later if
 * we grow it — so ETag always tracks the true response body.
 */
export const CATALOG_CONFIG_VERSION = (() => {
  const publicPayload = {
    coupons:  getPublicCouponConfig(),
    products: getPublicProductConfig(),
    pricing:  getPublicPricingConfig(),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(publicPayload))
    .digest('hex')
    .slice(0, 12);
})();
