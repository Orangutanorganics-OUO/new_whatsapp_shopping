// shared/order-validation.js
// -----------------------------------------------------------------------------
// Order-data validation for website API routes.
//
// PURPOSE
//   Reject hostile / malformed order data at the API boundary before it can
//   reach downstream sinks (Firebase pending record, Google Sheets, Apps Script
//   email/PDF templates). Defense in depth alongside output-side HTML escaping
//   in app-script.js — closes finding C-05 from the audit.
//
// PHILOSOPHY
//   Permissive but XSS-safe. Block obvious HTML metacharacters and injection
//   scheme prefixes, cap lengths, allowlist the closed sets (state, coupon
//   format). Reject at the door in strict mode; log and proceed in warn mode
//   (safe rollout).
//
// USAGE
//   const { validateOrderData, INPUT_VALIDATION_MODE } = await import('.../shared/order-validation.js');
//   const result = validateOrderData(req.body.orderData);
//   if (!result.ok) { ... }
//   // result.cleaned holds normalized values ready to persist.
//
// -----------------------------------------------------------------------------

// ============================================================================
// ENFORCEMENT MODE (env-driven)
// ============================================================================
//   strict — validation failures return 400 to the client
//   warn   — (default) log the failure, proceed with client-supplied data
//   off    — skip validation entirely (legacy behaviour; emergency only)
const RAW_MODE = String(process.env.INPUT_VALIDATION_MODE || 'warn').toLowerCase().trim();
export const INPUT_VALIDATION_MODE = ['strict', 'warn', 'off'].includes(RAW_MODE) ? RAW_MODE : 'warn';
if (RAW_MODE !== INPUT_VALIDATION_MODE && RAW_MODE) {
  console.warn(`⚠️ [order-validation] INPUT_VALIDATION_MODE="${RAW_MODE}" is invalid; defaulting to "warn"`);
}
console.log(`[order-validation] input validation mode: ${INPUT_VALIDATION_MODE}`);

// ============================================================================
// CONSTANTS
// ============================================================================

// 28 Indian states + 8 union territories (as of 2024)
const INDIAN_STATES = new Set([
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  // Union Territories
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
]);
const INDIAN_STATES_LOWER = new Map();
for (const s of INDIAN_STATES) INDIAN_STATES_LOWER.set(s.toLowerCase(), s);

// Regexes
const ORDER_ID_RE      = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE          = /^[\p{L}\p{N}][\p{L}\p{N}\s'.\-,]{0,99}$/u;
const CITY_RE          = /^[\p{L}\p{N}][\p{L}\p{N}\s.\-']{0,59}$/u;
const EMAIL_RE         = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const PINCODE_RE       = /^\d{6}$/;
const COUPON_RE        = /^[A-Z0-9]{1,20}$/i;
const PRODUCT_NAME_RE  = /^[\p{L}\p{N}][\p{L}\p{N}\s.\-()',/&]{0,99}$/u;
const PRODUCT_SIZE_RE  = /^[A-Za-z0-9][A-Za-z0-9\s.\-]{0,39}$/;

// Reject any string containing HTML metacharacters we can't afford to see
// even in fields where escape at output is applied. Belt and braces.
const FORBIDDEN_HTML_RE = /[<>{}[\]`|\\]/;

// Reject any string containing a known injection scheme prefix.
const FORBIDDEN_SCHEME_RE = /(javascript|data|vbscript|file):/i;

// ============================================================================
// HTML ESCAPE (also exported for backend-side HTML rendering, if ever needed)
// ============================================================================
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;')
    .replace(/`/g,  '&#96;');
}

// ============================================================================
// NORMALIZERS
// ============================================================================

// Accepts "+91 79067 69090", "9198765 43210", "9876543210", 9876543210, etc.
// Returns a 10-digit string or null if it can't be normalized.
export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0'))  return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

// Case-insensitive allowlist match. Returns canonical spelling or null.
export function normalizeState(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return INDIAN_STATES_LOWER.get(key) || null;
}

// Trim + coerce to string. Returns '' for nullish.
function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

// ============================================================================
// FIELD VALIDATORS (internal)
// ============================================================================

function validateName(raw, errors) {
  const name = s(raw);
  if (!name) return errors.push({ field: 'name', code: 'required', message: 'name is required' }), null;
  if (name.length > 100) return errors.push({ field: 'name', code: 'too_long', message: 'name must be <= 100 chars' }), null;
  if (FORBIDDEN_HTML_RE.test(name)) return errors.push({ field: 'name', code: 'forbidden_chars', message: 'name contains forbidden characters' }), null;
  if (FORBIDDEN_SCHEME_RE.test(name)) return errors.push({ field: 'name', code: 'forbidden_scheme', message: 'name contains a forbidden URL scheme' }), null;
  if (!NAME_RE.test(name)) return errors.push({ field: 'name', code: 'invalid_chars', message: 'name has invalid characters' }), null;
  return name;
}

function validateEmail(raw, errors) {
  const email = s(raw).toLowerCase();
  if (!email) return errors.push({ field: 'email', code: 'required', message: 'email is required' }), null;
  if (email.length > 254) return errors.push({ field: 'email', code: 'too_long', message: 'email too long' }), null;
  if (FORBIDDEN_HTML_RE.test(email)) return errors.push({ field: 'email', code: 'forbidden_chars', message: 'email contains forbidden characters' }), null;
  if (!EMAIL_RE.test(email)) return errors.push({ field: 'email', code: 'invalid_format', message: 'email format is invalid' }), null;
  return email;
}

function validatePhone(raw, errors) {
  const phone = normalizePhone(raw);
  if (!phone) return errors.push({ field: 'phone', code: 'invalid_format', message: 'phone must normalize to 10 digits (India, with optional +91/0 prefix)' }), null;
  return phone;
}

function validateAddress(raw, errors) {
  const address = s(raw);
  if (!address) return errors.push({ field: 'address', code: 'required', message: 'address is required' }), null;
  if (address.length > 300) return errors.push({ field: 'address', code: 'too_long', message: 'address must be <= 300 chars' }), null;
  if (FORBIDDEN_HTML_RE.test(address)) return errors.push({ field: 'address', code: 'forbidden_chars', message: 'address contains forbidden characters' }), null;
  if (FORBIDDEN_SCHEME_RE.test(address)) return errors.push({ field: 'address', code: 'forbidden_scheme', message: 'address contains a forbidden URL scheme' }), null;
  return address;
}

function validateCity(raw, errors) {
  const city = s(raw);
  if (!city) return errors.push({ field: 'city', code: 'required', message: 'city is required' }), null;
  if (city.length > 60) return errors.push({ field: 'city', code: 'too_long', message: 'city must be <= 60 chars' }), null;
  if (FORBIDDEN_HTML_RE.test(city)) return errors.push({ field: 'city', code: 'forbidden_chars', message: 'city contains forbidden characters' }), null;
  if (!CITY_RE.test(city)) return errors.push({ field: 'city', code: 'invalid_chars', message: 'city has invalid characters' }), null;
  return city;
}

function validateState(raw, errors) {
  const state = normalizeState(raw);
  if (!state) return errors.push({ field: 'state', code: 'invalid', message: 'state must be a valid Indian state or union territory' }), null;
  return state;
}

function validatePincode(raw, errors) {
  const pincode = s(raw);
  if (!pincode) return errors.push({ field: 'pincode', code: 'required', message: 'pincode is required' }), null;
  if (!PINCODE_RE.test(pincode)) return errors.push({ field: 'pincode', code: 'invalid_format', message: 'pincode must be exactly 6 digits' }), null;
  return pincode;
}

function validateOrderId(raw, errors) {
  const id = s(raw);
  if (!id) return errors.push({ field: 'orderId', code: 'required', message: 'orderId is required' }), null;
  if (!ORDER_ID_RE.test(id)) return errors.push({ field: 'orderId', code: 'invalid_format', message: 'orderId must be alphanumeric/_/- up to 64 chars' }), null;
  return id;
}

function validateCoupon(raw, errors) {
  if (raw === undefined || raw === null || raw === '') return undefined; // optional
  const c = s(raw).toUpperCase();
  if (!COUPON_RE.test(c)) return errors.push({ field: 'coupon', code: 'invalid_format', message: 'coupon must be alphanumeric, <= 20 chars' }), null;
  return c;
}

function validateProducts(raw, errors) {
  if (!Array.isArray(raw)) return errors.push({ field: 'products', code: 'required', message: 'products must be a non-empty array' }), null;
  if (raw.length === 0) return errors.push({ field: 'products', code: 'empty', message: 'products cannot be empty' }), null;
  if (raw.length > 20) return errors.push({ field: 'products', code: 'too_many', message: 'max 20 products per order' }), null;

  const cleaned = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (!p || typeof p !== 'object') {
      errors.push({ field: `products[${i}]`, code: 'invalid_type', message: 'each product must be an object' });
      continue;
    }
    const pname = s(p.name);
    const psize = s(p.size);
    const pqty  = Number(p.quantity);
    const pprice = Number(p.price);
    const cp = {};

    if (!pname) errors.push({ field: `products[${i}].name`, code: 'required', message: 'product name is required' });
    else if (pname.length > 100) errors.push({ field: `products[${i}].name`, code: 'too_long', message: 'product name > 100 chars' });
    else if (FORBIDDEN_HTML_RE.test(pname)) errors.push({ field: `products[${i}].name`, code: 'forbidden_chars', message: 'product name has forbidden characters' });
    else if (!PRODUCT_NAME_RE.test(pname)) errors.push({ field: `products[${i}].name`, code: 'invalid_chars', message: 'product name has invalid characters' });
    else cp.name = pname;

    if (!psize) errors.push({ field: `products[${i}].size`, code: 'required', message: 'product size is required' });
    else if (psize.length > 40) errors.push({ field: `products[${i}].size`, code: 'too_long', message: 'product size > 40 chars' });
    else if (!PRODUCT_SIZE_RE.test(psize)) errors.push({ field: `products[${i}].size`, code: 'invalid_chars', message: 'product size has invalid characters' });
    else cp.size = psize;

    if (!Number.isInteger(pqty) || pqty < 1 || pqty > 100) {
      errors.push({ field: `products[${i}].quantity`, code: 'invalid', message: 'quantity must be integer 1-100' });
    } else cp.quantity = pqty;

    if (!Number.isFinite(pprice) || pprice < 0 || pprice > 100000) {
      errors.push({ field: `products[${i}].price`, code: 'invalid', message: 'price must be a finite non-negative number <= 100000' });
    } else cp.price = pprice;

    cleaned.push(cp);
  }
  return cleaned;
}

// Lenient text field — used for values the server-side code writes (paymentMode,
// paymentStatus, paymentId). We still cap length and reject HTML metacharacters
// so that even a compromised upstream can't inject markup into the templates.
function validateLenientText(raw, fieldName, maxLen, errors) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = s(raw);
  if (v.length > maxLen) return errors.push({ field: fieldName, code: 'too_long', message: `${fieldName} > ${maxLen} chars` }), null;
  if (FORBIDDEN_HTML_RE.test(v)) return errors.push({ field: fieldName, code: 'forbidden_chars', message: `${fieldName} contains forbidden characters` }), null;
  return v;
}

function validateFiniteNumber(raw, fieldName, errors, { min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return errors.push({ field: fieldName, code: 'invalid', message: `${fieldName} must be a finite number` }), null;
  if (n < min || n > max) return errors.push({ field: fieldName, code: 'out_of_range', message: `${fieldName} out of range` }), null;
  return n;
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

/**
 * Validate order data submitted by the website checkout API.
 *
 * @param {object} data  The orderData payload from the client (or from a
 *                       server-side snapshot); must be an object.
 *
 * @returns {{
 *   ok: boolean,
 *   errors: Array<{field:string, code:string, message:string}>,
 *   cleaned: object|null
 * }}
 *
 * The `cleaned` object contains normalized values (trimmed, state canonicalized,
 * phone reduced to 10 digits, coupon uppercased) and only the fields that
 * validated successfully. Callers should MERGE cleaned over data (or replace
 * outright in strict mode) before persisting.
 */
export function validateOrderData(data) {
  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      errors: [{ field: '_root', code: 'missing_body', message: 'orderData object is required' }],
      cleaned: null,
    };
  }

  const errors = [];
  const cleaned = {};

  const orderId  = validateOrderId(data.orderId, errors);   if (orderId  !== null) cleaned.orderId  = orderId;
  const name     = validateName(data.name, errors);         if (name     !== null) cleaned.name     = name;
  const email    = validateEmail(data.email, errors);       if (email    !== null) cleaned.email    = email;
  const phone    = validatePhone(data.phone, errors);       if (phone    !== null) cleaned.phone    = phone;
  const address  = validateAddress(data.address, errors);   if (address  !== null) cleaned.address  = address;
  const city     = validateCity(data.city, errors);         if (city     !== null) cleaned.city     = city;
  const state    = validateState(data.state, errors);       if (state    !== null) cleaned.state    = state;
  const pincode  = validatePincode(data.pincode, errors);   if (pincode  !== null) cleaned.pincode  = pincode;
  const products = validateProducts(data.products, errors); if (products !== null) cleaned.products = products;
  const coupon   = validateCoupon(data.coupon, errors);     if (coupon   !== undefined && coupon !== null) cleaned.coupon = coupon;

  // Lenient fields (may be filled in by server-side code on prepaid path)
  const paymentMode   = validateLenientText(data.paymentMode,   'paymentMode',   40,  errors); if (paymentMode   !== null && paymentMode   !== undefined) cleaned.paymentMode   = paymentMode;
  const paymentStatus = validateLenientText(data.paymentStatus, 'paymentStatus', 40,  errors); if (paymentStatus !== null && paymentStatus !== undefined) cleaned.paymentStatus = paymentStatus;
  const paymentId     = validateLenientText(data.paymentId,     'paymentId',     100, errors); if (paymentId     !== null && paymentId     !== undefined) cleaned.paymentId     = paymentId;

  const subtotal       = validateFiniteNumber(data.subtotal,       'subtotal',       errors, { min: 0, max: 1_000_000 }); if (subtotal       !== null && subtotal       !== undefined) cleaned.subtotal       = subtotal;
  const shippingCharge = validateFiniteNumber(data.shippingCharge, 'shippingCharge', errors, { min: 0, max: 100_000 });  if (shippingCharge !== null && shippingCharge !== undefined) cleaned.shippingCharge = shippingCharge;
  const codCharge      = validateFiniteNumber(data.codCharge,      'codCharge',      errors, { min: 0, max: 10_000 });   if (codCharge      !== null && codCharge      !== undefined) cleaned.codCharge      = codCharge;
  const discount       = validateFiniteNumber(data.discount,       'discount',       errors, { min: 0, max: 1_000_000 }); if (discount       !== null && discount       !== undefined) cleaned.discount       = discount;
  const total          = validateFiniteNumber(data.total,          'total',          errors, { min: 0, max: 1_000_000 }); if (total          !== null && total          !== undefined) cleaned.total          = total;

  return { ok: errors.length === 0, errors, cleaned };
}
