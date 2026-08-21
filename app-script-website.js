/**
 * Orangutan Organics – Unified Google Apps Script (Contact + Review + Checkout)
 *
 * Handles three submission types:
 *   • type: 'contact'  — website contact form (frontend → this script)
 *   • type: 'review'   — website product review (frontend → this script)
 *   • type: 'checkout' — order fulfillment payload (backend → this script)
 *
 * ------------------------------------------------------------------------
 * SECURITY POSTURE
 * ------------------------------------------------------------------------
 *
 * AUTH (audit fix H-11)
 *   Checkout submissions come from the trusted backend and MUST carry
 *   `data.secret` matching the SCRIPT_SHARED_SECRET Script Property.
 *   Constant-time compare, fail-closed on missing/wrong secret.
 *
 *   Contact + review submissions come from the browser and CANNOT carry a
 *   secret (it would be trivially extractable from the frontend bundle).
 *   These paths rely on input validation as the primary defense: length
 *   caps, format checks, and cheap sanity gates. Google Apps Script
 *   execution quotas provide a hard rate ceiling; add reCAPTCHA on the
 *   frontend if abuse becomes visible.
 *
 * XSS (audit fix C-05)
 *   Every user-supplied value interpolated into HTML (email body OR
 *   invoice PDF) goes through esc(). Un-escaped values would turn admin
 *   emails and PDF invoices into phishing surfaces.
 *
 * FORMULA INJECTION (audit fix C-05)
 *   Every value written to a sheet cell goes through sheetCell() to
 *   neutralize =/+/-/@/tab/CR-prefixed values that Sheets would
 *   otherwise interpret as formulas (CSV injection class).
 *
 * SHEET RESOLUTION (audit-fix companion to H-11)
 *   This script is standalone (not container-bound), so
 *   SpreadsheetApp.getActiveSpreadsheet() returns null. Target sheet is
 *   resolved via the TARGET_SHEET_ID Script Property.
 *
 * GST (audit fix M-16)
 *   Invoice PDF math uses per-line `gst_rate` from the payload (backend
 *   stamps it from shared/catalog.js). Falls back to 5% only for
 *   payloads that omit the field.
 *
 * ------------------------------------------------------------------------
 * REQUIRED SCRIPT PROPERTIES (Project Settings → Script Properties)
 * ------------------------------------------------------------------------
 *   SCRIPT_SHARED_SECRET   — 32-byte hex string; MUST match backend .env's
 *                            APP_SCRIPT_SHARED_SECRET. Generate with
 *                            `openssl rand -hex 32`.
 *   TARGET_SHEET_ID        — Google Sheet's ID (the string between /d/
 *                            and /edit in the sheet URL).
 * ------------------------------------------------------------------------
 */

// =====================================================
// ================ CONSTANTS ==========================
// =====================================================
const ADMIN_EMAIL   = 'orangutanorganics@gmail.com';
const CONTACT_SHEET = 'Contact Submissions';
const REVIEW_SHEET  = 'Reviews';
const CHECKOUT_SHEET = 'Orders';

const SCRIPT_SHARED_SECRET_PROPERTY = 'SCRIPT_SHARED_SECRET';
const TARGET_SHEET_ID_PROPERTY      = 'TARGET_SHEET_ID';

// Product → HSN Mapping for GST Invoice
const HSN_MAP = {
  'Himalayan Red Rajma':            '07133300',
  'Himalayan White Rajma':          '07133300',
  'Himalayan Red Rice':             '10061090',
  'Badri Cow Ghee':                 '040590',
  'Himalayan Black Soyabean':       '1201',
  'Wild Himalayan Tempering Spice': '07129090',
};

// Input caps — reject anything larger. Prevents storage exhaustion via
// giant payloads and keeps admin emails/sheet rows readable.
const CAP_NAME     = 100;
const CAP_EMAIL    = 200;
const CAP_PHONE    = 30;
const CAP_SUBJECT  = 200;
const CAP_MESSAGE  = 5000;
const CAP_LOCATION = 100;
const CAP_PRODUCT  = 100;
const CAP_SOURCE   = 50;
const CAP_TIMESTAMP = 40;

// =====================================================
// ================ SECURITY HELPERS ===================
// =====================================================

/**
 * Escape a value for safe interpolation into HTML.
 * Handles null/undefined/numbers/strings uniformly. Never returns
 * "undefined" or "null" — nullish becomes empty string.
 */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;')
    .replace(/`/g,  '&#96;');
}

/**
 * Neutralize a value before writing to a Google Sheets cell. Prefixes any
 * value starting with a formula trigger character with a single quote so
 * Sheets forces text interpretation.
 */
function sheetCell(value) {
  if (value == null) return '';
  var s = String(value);
  if (s.length === 0) return '';
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

/**
 * Strip newlines / control chars from a string that will land in an
 * email header (Subject line etc.). Prevents header-injection attacks.
 */
function stripCtrl(value) {
  return String(value == null ? '' : value).replace(/[\r\n\t\v\f]/g, '');
}

/**
 * Constant-time string comparison. Standard-library timingSafeEqual
 * isn't available in Apps Script. Non-strings and length mismatches
 * return false; length differences short-circuit but that's fine —
 * the secret length is not the sensitive part.
 */
function timingSafeStringEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build a JSON response.
 */
function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Verify the shared secret before any side-effect. Fail-closed on missing
 * Script Property (rollout not finished) OR mismatched secret.
 * Returns { ok: true } on success, { ok: false, response } on failure.
 */
function verifyRequestSecret(data) {
  var expected = PropertiesService.getScriptProperties()
    .getProperty(SCRIPT_SHARED_SECRET_PROPERTY);
  if (!expected) {
    console.error('[H-11] SCRIPT_SHARED_SECRET Script Property is not set — rejecting request. Configure it in Project Settings → Script Properties.');
    return {
      ok: false,
      response: jsonResponse({ status: 'error', code: 'unauthorized', message: 'Server misconfigured' }),
    };
  }
  var received = (data && typeof data.secret === 'string') ? data.secret : '';
  if (!timingSafeStringEquals(received, expected)) {
    console.warn('[H-11] doPost rejected: shared-secret mismatch (received_len=' + (received.length || 0) + ', expected_len=' + expected.length + ')');
    return {
      ok: false,
      response: jsonResponse({ status: 'error', code: 'unauthorized', message: 'Unauthorized' }),
    };
  }
  return { ok: true };
}

// =====================================================
// ================ INPUT VALIDATION ===================
// =====================================================

/**
 * Sanitize + validate a contact-form payload. Returns a `cleaned` view
 * containing only the fields we'll process, all length-capped and
 * trimmed. Rejects on missing required fields or bad email shape.
 */
function validateContactData(data) {
  if (!data || typeof data !== 'object') return { ok: false, message: 'Empty request' };
  var name    = String(data.name    || '').trim().slice(0, CAP_NAME);
  var email   = String(data.email   || '').trim().slice(0, CAP_EMAIL);
  var phone   = String(data.phone   || '').trim().slice(0, CAP_PHONE);
  var subject = String(data.subject || '').trim().slice(0, CAP_SUBJECT);
  var message = String(data.message || '').trim().slice(0, CAP_MESSAGE);
  var timestamp = String(data.timestamp || new Date().toISOString()).slice(0, CAP_TIMESTAMP);

  if (!name)    return { ok: false, message: 'name is required' };
  if (!email)   return { ok: false, message: 'email is required' };
  if (!message) return { ok: false, message: 'message is required' };
  if (email.indexOf('@') === -1 || email.indexOf('.') === -1) {
    return { ok: false, message: 'invalid email' };
  }
  return { ok: true, cleaned: { name, email, phone, subject, message, timestamp } };
}

/**
 * Sanitize + validate a product-review payload.
 */
function validateReviewData(data) {
  if (!data || typeof data !== 'object') return { ok: false, message: 'Empty request' };
  var product  = String(data.product  || '').trim().slice(0, CAP_PRODUCT);
  var name     = String(data.name     || '').trim().slice(0, CAP_NAME);
  var email    = String(data.email    || '').trim().slice(0, CAP_EMAIL);
  var location = String(data.location || '').trim().slice(0, CAP_LOCATION);
  var review   = String(data.review   || '').trim().slice(0, CAP_MESSAGE);
  var source   = String(data.source   || 'Website').trim().slice(0, CAP_SOURCE);
  var rating   = Number(data.rating);

  if (!product) return { ok: false, message: 'product is required' };
  if (!name)    return { ok: false, message: 'name is required' };
  if (!email)   return { ok: false, message: 'email is required' };
  if (!review)  return { ok: false, message: 'review is required' };
  if (email.indexOf('@') === -1) return { ok: false, message: 'invalid email' };
  if (!isFinite(rating) || rating < 1 || rating > 5 || Math.floor(rating) !== rating) {
    return { ok: false, message: 'rating must be integer 1-5' };
  }
  return { ok: true, cleaned: { product, name, email, location, rating, review, source } };
}

// =====================================================
// ================ ENTRY POINT ========================
// =====================================================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var type = data && data.type;

    // Checkout: server-to-server. Auth-required.
    if (type === 'checkout') {
      var auth = verifyRequestSecret(data);
      if (!auth.ok) return auth.response;
      // Strip secret so it never lands in a sheet cell, email body, or log.
      delete data.secret;
      return handleCheckoutSubmission(data);
    }

    // Contact + review: frontend-facing. Input validation is the gate.
    if (type === 'contact') {
      var cv = validateContactData(data);
      if (!cv.ok) return jsonResponse({ status: 'error', message: cv.message });
      return handleContactSubmission(cv.cleaned);
    }
    if (type === 'review') {
      var rv = validateReviewData(data);
      if (!rv.ok) return jsonResponse({ status: 'error', message: rv.message });
      return handleReviewSubmission(rv.cleaned);
    }

    return jsonResponse({ status: 'error', message: 'Invalid submission type. Must be "contact", "review", or "checkout".' });
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({ status: 'error', message: 'Failed to process submission' });
  }
}

// =====================================================
// ================ CONTACT FORM HANDLER ================
// =====================================================
function handleContactSubmission(data) {
  var sheet = getOrCreateSheet(CONTACT_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Timestamp', 'Name', 'Email', 'Phone', 'Subject', 'Message']);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }

  sheet.appendRow([
    sheetCell(data.timestamp),
    sheetCell(data.name),
    sheetCell(data.email),
    sheetCell(data.phone),
    sheetCell(data.subject),
    sheetCell(data.message),
  ]);

  sendContactEmail(data);

  return jsonResponse({ status: 'success', message: 'Contact form submitted successfully.' });
}

function sendContactEmail(data) {
  // Subject is a mail header — strip control chars but don't HTML-escape.
  var safeSubject = stripCtrl(data.subject) || '(No Subject)';
  var subject = '📩 New Contact Form: ' + safeSubject;

  var htmlBody =
    '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<h2 style="color:#0F5B2F;">New Contact Form Submission</h2>' +
      '<table style="border-collapse: collapse;">' +
        '<tr><td style="padding:6px;"><strong>Name:</strong></td><td style="padding:6px;">' + esc(data.name) + '</td></tr>' +
        '<tr><td style="padding:6px;"><strong>Email:</strong></td><td style="padding:6px;">' + esc(data.email) + '</td></tr>' +
        '<tr><td style="padding:6px;"><strong>Phone:</strong></td><td style="padding:6px;">' + esc(data.phone || 'Not provided') + '</td></tr>' +
        '<tr><td style="padding:6px;"><strong>Subject:</strong></td><td style="padding:6px;">' + esc(data.subject) + '</td></tr>' +
      '</table>' +
      '<h3 style="color:#0F5B2F; margin-top:20px;">Message</h3>' +
      '<div style="background:#F5F2EB; padding:12px; border-left:4px solid #F46A1F; white-space:pre-wrap;">' + esc(data.message) + '</div>' +
      '<p style="font-size:12px; color:#6b7280; margin-top:20px;">Submitted at: ' + esc(data.timestamp) + '</p>' +
    '</div>';

  try {
    MailApp.sendEmail({ to: ADMIN_EMAIL, subject: subject, htmlBody: htmlBody });
  } catch (error) {
    console.error('Error sending contact email:', error);
  }
}

// =====================================================
// ================ PRODUCT REVIEW HANDLER ==============
// =====================================================
function handleReviewSubmission(data) {
  var sheet = getOrCreateSheet(REVIEW_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date', 'Product', 'Name', 'Email', 'Location', 'Rating', 'Review', 'Source', 'Display']);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
  }

  sheet.appendRow([
    sheetCell(new Date().toLocaleDateString('en-IN')),
    sheetCell(data.product),
    sheetCell(data.name),
    sheetCell(data.email),
    sheetCell(data.location),
    Number(data.rating) || 0, // number cell, not user text — no injection risk
    sheetCell(data.review),
    sheetCell(data.source),
    'No', // Display flag — default hidden, admin flips to 'Yes' to publish
  ]);

  sendReviewAdminNotification(data);
  sendReviewCustomerConfirmation(data);

  return jsonResponse({ status: 'success', message: 'Review submitted successfully.' });
}

function sendReviewAdminNotification(data) {
  var safeProduct = stripCtrl(data.product);
  var rating = Number(data.rating) || 0;
  var subject = '⭐ New ' + rating + '-Star Review - ' + safeProduct;

  var stars = '';
  for (var i = 0; i < rating; i++) stars += '⭐';

  var htmlBody =
    '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<h2 style="color:#0F5B2F;">New Product Review Submitted</h2>' +
      '<table style="border-collapse:collapse;">' +
        '<tr><td style="padding:6px;"><strong>Product:</strong></td><td style="padding:6px;">' + esc(data.product) + '</td></tr>' +
        '<tr><td style="padding:6px;"><strong>Rating:</strong></td><td style="padding:6px;">' + stars + ' (' + esc(rating) + '/5)</td></tr>' +
        '<tr><td style="padding:6px;"><strong>Name:</strong></td><td style="padding:6px;">' + esc(data.name) + '</td></tr>' +
        '<tr><td style="padding:6px;"><strong>Email:</strong></td><td style="padding:6px;">' + esc(data.email) + '</td></tr>' +
        '<tr><td style="padding:6px;"><strong>Location:</strong></td><td style="padding:6px;">' + esc(data.location || 'Not provided') + '</td></tr>' +
      '</table>' +
      '<h3 style="color:#0F5B2F; margin-top:20px;">Review</h3>' +
      '<div style="background:#F5F2EB; padding:12px; border-left:4px solid #F46A1F; white-space:pre-wrap;">' + esc(data.review) + '</div>' +
      '<hr style="margin:20px 0;">' +
      '<p style="font-size:13px; color:#6b7280;"><strong>Note:</strong> Review is currently hidden (Display = "No"). Change it to "Yes" in the Reviews sheet to publish.</p>' +
    '</div>';

  try {
    MailApp.sendEmail({ to: ADMIN_EMAIL, subject: subject, htmlBody: htmlBody });
  } catch (error) {
    console.error('Error sending review admin email:', error);
  }
}

function sendReviewCustomerConfirmation(data) {
  var firstName = String(data.name || '').split(' ')[0] || 'there';
  var safeProduct = stripCtrl(data.product);
  var subject = 'Thank you for your review, ' + stripCtrl(firstName) + '!';
  var rating = Number(data.rating) || 0;
  var stars = '';
  for (var i = 0; i < rating; i++) stars += '⭐';

  var htmlBody =
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">' +
      '<div style="background: linear-gradient(135deg, #0F5B2F, #F46A1F); padding: 30px; text-align: center;">' +
        '<h1 style="color: white; margin: 0;">Thank You!</h1>' +
      '</div>' +
      '<div style="padding: 30px; background: #F5F2EB;">' +
        '<p style="font-size:16px;">Hi ' + esc(firstName) + ',</p>' +
        '<p style="font-size:16px;">Thank you for reviewing <strong>' + esc(data.product) + '</strong>. We appreciate your feedback and support for Himalayan farmers!</p>' +
        '<div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">' +
          '<p><strong>Your Rating:</strong> ' + stars + ' (' + esc(rating) + '/5)</p>' +
          '<p><strong>Your Review:</strong></p>' +
          '<blockquote style="border-left:3px solid #F46A1F; padding-left:12px; margin:8px 0; white-space:pre-wrap;">' + esc(data.review) + '</blockquote>' +
        '</div>' +
        '<p style="font-size:14px; color:#6b7280;">Your review will be published on our website after verification (usually within 24–48 hours).</p>' +
        '<p style="text-align:center; margin-top:30px; font-size:14px; color:#6b7280;">With gratitude,<br><strong style="color:#0F5B2F;">The Orangutan Organics Team</strong></p>' +
      '</div>' +
    '</div>';

  try {
    MailApp.sendEmail({ to: data.email, subject: subject, htmlBody: htmlBody });
  } catch (error) {
    console.error('Error sending review confirmation:', error);
  }
}

// =====================================================
// ================ CHECKOUT ORDER HANDLER ==============
// =====================================================
function handleCheckoutSubmission(data) {
  var sheet = getOrCreateSheet(CHECKOUT_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp', 'Order ID', 'Name', 'Email', 'Phone', 'Address',
      'Pincode', 'City', 'State', 'Products', 'Payment Mode', 'Payment Status',
      'Payment ID', 'Subtotal', 'Shipping', 'COD Charge', 'Discounts', 'Total', 'Delhivery Response',
    ]);
    sheet.getRange(1, 1, 1, 19).setFontWeight('bold');
  }

  // Format products for the sheet cell — plain text, but pipe through
  // sheetCell() so a hostile product name can't inject a formula.
  var productsText = '';
  if (data.products && Array.isArray(data.products)) {
    productsText = data.products.map(function (p) {
      var qty = Number(p.quantity) || 0;
      var price = Number(p.price) || 0;
      return String(p.name || '') + ' (' + String(p.size || '') + ') x ' + qty + ' - ₹' + (price * qty);
    }).join('\n');
  }

  sheet.appendRow([
    sheetCell(data.timestamp || new Date().toISOString()),
    sheetCell(data.orderId),
    sheetCell(data.name),
    sheetCell(data.email),
    sheetCell(data.phone),
    sheetCell(data.address),
    sheetCell(data.pincode),
    sheetCell(data.city),
    sheetCell(data.state),
    sheetCell(productsText),
    sheetCell(data.paymentMode),
    sheetCell(data.paymentStatus),
    sheetCell(data.paymentId),
    Number(data.subtotal) || 0,
    Number(data.shippingCharge) || 0,
    Number(data.codCharge) || 0,
    Number(data.discount) || 0,
    Number(data.total) || 0,
    sheetCell(data.delhiveryResponse),
  ]);

  sendOrderAdminNotification(data);
  sendOrderCustomerConfirmation(data);

  return jsonResponse({ status: 'success', message: 'Order submitted successfully.' });
}

function sendOrderAdminNotification(data) {
  var isCOD = data.paymentMode === 'COD';
  var hasDiscount = Number(data.discount) > 0;
  var safeMode = stripCtrl(data.paymentMode);
  var safeOrderId = stripCtrl(data.orderId);
  var subject = '🛒 New ' + safeMode + ' Order - ' + safeOrderId;

  var productsHTML = '<ul>';
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(function (p) {
      var qty = Number(p.quantity) || 0;
      var price = Number(p.price) || 0;
      productsHTML += '<li>' + esc(p.name) + ' (' + esc(p.size) + ') × ' + esc(qty) + ' - ₹' + esc(price * qty) + '</li>';
    });
  }
  productsHTML += '</ul>';

  var htmlBody =
    '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<div style="background: linear-gradient(135deg, #0F5B2F, #F46A1F); padding: 20px; color: white;">' +
        '<h1 style="margin: 0;">🎉 New Order Received!</h1>' +
      '</div>' +
      '<div style="padding: 20px; background: #F5F2EB;">' +
        '<h2 style="color: #0F5B2F;">Order Details</h2>' +
        '<table style="width:100%; border-collapse:collapse;">' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Order ID:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.orderId) + '</td></tr>' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Payment Mode:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.paymentMode) + '</td></tr>' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Payment Status:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.paymentStatus) + '</td></tr>' +
          (data.paymentId ?
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Payment ID:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.paymentId) + '</td></tr>' : '') +
        '</table>' +
        '<h3 style="color:#0F5B2F; margin-top:20px;">Customer Information</h3>' +
        '<table style="width:100%; border-collapse:collapse;">' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Name:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.name) + '</td></tr>' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Email:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.email) + '</td></tr>' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Phone:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.phone) + '</td></tr>' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Address:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">' + esc(data.address) + '<br>' + esc(data.city) + ', ' + esc(data.state) + ' - ' + esc(data.pincode) + '</td></tr>' +
        '</table>' +
        '<h3 style="color:#0F5B2F; margin-top:20px;">Products Ordered</h3>' +
        productsHTML +
        '<h3 style="color:#0F5B2F; margin-top:20px;">Pricing Summary</h3>' +
        '<table style="width:100%; border-collapse:collapse;">' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Subtotal:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">₹' + esc(data.subtotal) + '</td></tr>' +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Shipping:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">₹' + esc(data.shippingCharge) + '</td></tr>' +
          (isCOD ?
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">COD Charge:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white;">₹' + esc(data.codCharge) + '</td></tr>' : '') +
          (hasDiscount ?
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white;">Discount:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white; color:#059669;">-₹' + esc(data.discount) + '</td></tr>' : '') +
          '<tr><td style="padding:8px; border:1px solid #ddd; font-weight:bold; background:white; font-size:18px;">Total:</td>' +
              '<td style="padding:8px; border:1px solid #ddd; background:white; font-weight:bold; color:#F46A1F; font-size:18px;">₹' + esc(data.total) + '</td></tr>' +
        '</table>' +
        '<div style="margin-top:20px; text-align:center;">' +
          '<a href="https://docs.google.com/spreadsheets/d/' + esc(getTargetSpreadsheet().getId()) + '" ' +
             'style="display:inline-block; padding:12px 24px; background:#0F5B2F; color:white; text-decoration:none; border-radius:8px; font-weight:bold;">View Orders Sheet</a>' +
        '</div>' +
      '</div>' +
    '</div>';

  try {
    var invoicePDF = generateInvoicePDF(data);
    MailApp.sendEmail({
      to: ADMIN_EMAIL,
      subject: subject,
      htmlBody: htmlBody,
      attachments: [invoicePDF],
    });
  } catch (error) {
    console.error('Error sending order admin email:', error);
  }
}

function sendOrderCustomerConfirmation(data) {
  var isCOD = data.paymentMode === 'COD';
  var hasDiscount = Number(data.discount) > 0;
  var safeOrderId = stripCtrl(data.orderId);
  var subject = 'Order Confirmed - ' + safeOrderId + ' | Orangutan Organics';

  // Skip cleanly on missing/invalid email — MailApp would throw a less
  // informative error otherwise.
  if (!data.email || typeof data.email !== 'string' || data.email.indexOf('@') === -1) {
    console.warn('Skipping customer confirmation: missing/invalid email for orderId=' + safeOrderId);
    return;
  }

  var productsHTML = '<ul style="list-style: none; padding: 0;">';
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(function (p) {
      var qty = Number(p.quantity) || 0;
      var price = Number(p.price) || 0;
      productsHTML +=
        '<li style="padding:10px; margin:5px 0; background:white; border-left:3px solid #F46A1F;">' +
          esc(p.name) + ' (' + esc(p.size) + ') × ' + esc(qty) + ' - ₹' + esc(price * qty) +
        '</li>';
    });
  }
  productsHTML += '</ul>';

  var htmlBody =
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">' +
      '<div style="background: linear-gradient(135deg, #0F5B2F, #F46A1F); padding: 30px; text-align: center;">' +
        '<h1 style="color: white; margin: 0;">✅ Order Confirmed!</h1>' +
      '</div>' +
      '<div style="padding: 30px; background: #F5F2EB;">' +
        '<p style="font-size:16px;">Dear ' + esc(data.name) + ',</p>' +
        '<p style="font-size:16px;">Thank you for your order from Orangutan Organics! Your order has been successfully placed and will be shipped soon.</p>' +

        (hasDiscount ?
        '<div style="background: linear-gradient(135deg, #dcfce7, #a7f3d0); padding:15px; border-radius:8px; margin:20px 0; text-align:center;">' +
          '<h3 style="color:#059669; margin:0;">🎉 You Saved ₹' + esc(data.discount) + '!</h3>' +
        '</div>' : '') +

        '<div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">' +
          '<h2 style="color:#0F5B2F; margin-top:0;">Order Summary</h2>' +
          '<p><strong>Order ID:</strong> ' + esc(data.orderId) + '</p>' +
          '<p><strong>Payment Mode:</strong> ' + esc(data.paymentMode) + '</p>' +
          (isCOD
            ? '<p style="color:#F46A1F;"><strong>Amount to Pay on Delivery:</strong> ₹' + esc(data.total) + '</p>'
            : '<p style="color:#059669;"><strong>Payment Status:</strong> ' + esc(data.paymentStatus) + '</p>') +
        '</div>' +

        '<h3 style="color:#0F5B2F;">Your Products</h3>' +
        productsHTML +

        '<div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">' +
          '<h3 style="color:#0F5B2F; margin-top:0;">Pricing Breakdown</h3>' +
          '<table style="width:100%;">' +
            '<tr><td>Subtotal:</td><td style="text-align:right;">₹' + esc(data.subtotal) + '</td></tr>' +
            '<tr><td>Shipping:</td><td style="text-align:right;">' + (Number(data.shippingCharge) > 0 ? '₹' + esc(data.shippingCharge) : 'FREE') + '</td></tr>' +
            (isCOD ? '<tr><td>COD Charge:</td><td style="text-align:right;">₹' + esc(data.codCharge) + '</td></tr>' : '') +
            (hasDiscount ? '<tr><td style="color:#059669;">Discount:</td><td style="text-align:right; color:#059669;">-₹' + esc(data.discount) + '</td></tr>' : '') +
            '<tr style="border-top:2px solid #0F5B2F; font-weight:bold; font-size:18px;">' +
              '<td style="padding-top:10px;">Total:</td>' +
              '<td style="text-align:right; color:#F46A1F; padding-top:10px;">₹' + esc(data.total) + '</td>' +
            '</tr>' +
          '</table>' +
        '</div>' +

        '<div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">' +
          '<h3 style="color:#0F5B2F; margin-top:0;">Delivery Address</h3>' +
          '<p style="margin:0; line-height:1.6;">' +
            esc(data.name) + '<br>' +
            esc(data.address) + '<br>' +
            esc(data.city) + ', ' + esc(data.state) + ' - ' + esc(data.pincode) + '<br>' +
            'Phone: ' + esc(data.phone) +
          '</p>' +
        '</div>' +

        '<p style="font-size:14px; color:#6b7280; margin-top:30px;">' +
          'You will receive tracking information once your order is shipped. If you have any questions, contact us at orangutanorganics@gmail.com or WhatsApp +91 79067 69090.' +
        '</p>' +

        '<div style="text-align:center; margin-top:30px;">' +
          '<a href="https://orangutanorganics.com" style="display:inline-block; padding:12px 24px; background:#0F5B2F; color:white; text-decoration:none; border-radius:8px; margin-right:10px;">Visit Website</a>' +
          '<a href="https://wa.me/917906769090?text=hi" style="display:inline-block; padding:12px 24px; background:#F46A1F; color:white; text-decoration:none; border-radius:8px;">WhatsApp Us</a>' +
        '</div>' +

        '<p style="text-align:center; margin-top:30px; font-size:14px; color:#6b7280;">' +
          '<strong style="color:#0F5B2F;">Orangutan Organics</strong><br>Pure, Authentic, Himalayan' +
        '</p>' +
      '</div>' +
    '</div>';

  try {
    var invoicePDF = generateInvoicePDF(data);
    MailApp.sendEmail({
      to: data.email,
      subject: subject,
      htmlBody: htmlBody,
      attachments: [invoicePDF],
    });
  } catch (error) {
    console.error('Error sending order confirmation:', error);
  }
}

// =====================================================
// =================== UTILITIES ========================
// =====================================================

/**
 * Resolve the target Spreadsheet by ID from Script Properties. Fail-closed
 * — throws if TARGET_SHEET_ID isn't set (surfaces as the outer doPost
 * catch's 'Failed to process submission' rather than a null-deref).
 */
function getTargetSpreadsheet() {
  var sheetId = PropertiesService.getScriptProperties()
    .getProperty(TARGET_SHEET_ID_PROPERTY);
  if (!sheetId) {
    throw new Error(
      TARGET_SHEET_ID_PROPERTY + ' Script Property is not set. ' +
      'Configure it in Project Settings → Script Properties ' +
      '(value = the ID from your Sheet URL between /d/ and /edit).'
    );
  }
  return SpreadsheetApp.openById(sheetId);
}

function getOrCreateSheet(name) {
  var ss = getTargetSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// Fetch the site logo and return as base64. SVG source — validated to
// render correctly in Apps Script's HTML→PDF converter for this specific
// asset. If a future SVG update ships with unsupported features (external
// font refs, filters, etc.) and breaks the PDF logo, fall back to PNG here
// AND flip the img MIME to data:image/png below.
function getLogoBase64() {
  var url = 'https://orangutanorganics.com/static/media/logo.5abb273f7b264e84519864f3c4b23213.svg';
  var response = UrlFetchApp.fetch(url);
  var blob = response.getBlob();
  return Utilities.base64Encode(blob.getBytes());
}

/**
 * Generate a GST invoice PDF.
 *
 * Product prices are GST-inclusive. Each line item now carries an explicit
 * `gst_rate` (percent) stamped by the backend from shared/catalog.js.
 * Falls back to 5% for legacy payloads that omit the field.
 *
 * Given price_with_gst and gst_rate:
 *   net_per_unit = price_with_gst / (1 + gst_rate/100)
 *   tax_per_unit = price_with_gst - net_per_unit
 * Works for any rate — switching a SKU to 12% / 18% / 28% needs only a
 * catalog edit, no invoice code change.
 */
function generateInvoicePDF(data) {
  var logoBase64 = getLogoBase64();

  var productRows = '';
  var totalNetAmount = 0;
  var totalTaxAmount = 0;
  var totalAmount = 0;

  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(function (p) {
      var qty = Number(p.quantity) || 0;
      var priceWithGST = Number(p.price) || 0;
      var gstRate = Number(p.gst_rate);
      if (!isFinite(gstRate) || gstRate < 0) gstRate = 5;
      var netPerUnit = priceWithGST / (1 + gstRate / 100);
      var taxPerUnit = priceWithGST - netPerUnit;
      var netAmount = netPerUnit * qty;
      var taxAmount = taxPerUnit * qty;
      var total = netAmount + taxAmount;
      var hsn = HSN_MAP[p.name] || '';

      totalNetAmount += netAmount;
      totalTaxAmount += taxAmount;
      totalAmount += total;

      productRows +=
        '<tr>' +
          '<td>' + esc(p.name) + ' (' + esc(p.size) + ')</td>' +
          '<td>' + esc(hsn) + '</td>' +
          '<td class="right">' + esc(netPerUnit.toFixed(2)) + '</td>' +
          '<td class="right">' + esc(qty) + '</td>' +
          '<td class="right">' + esc(netAmount.toFixed(2)) + '</td>' +
          '<td class="right">' + esc(gstRate) + '</td>' +
          '<td class="right">IGST</td>' +
          '<td class="right">' + esc(taxAmount.toFixed(2)) + '</td>' +
          '<td class="right">' + esc(total.toFixed(2)) + '</td>' +
        '</tr>';
    });
  }

  var discountAmount = Number(data.discount) || 0;
  var shippingCharge = Number(data.shippingCharge) || 0;
  var codCharge = Number(data.codCharge) || 0;
  var finalTotal = totalAmount - discountAmount + shippingCharge + codCharge;

  var orderDate = data.timestamp ? new Date(data.timestamp) : new Date();
  var formattedDate = orderDate.toLocaleDateString('en-IN');

  var html =
    '<html><head><style>' +
    'body { font-family: Arial, sans-serif; padding: 30px; font-size: 13px; color: #000; }' +
    '.title { text-align: center; font-size: 22px; font-weight: bold; }' +
    '.subtitle { text-align: center; font-size: 12px; margin-bottom: 20px; }' +
    '.header { display: flex; align-items: center; margin-bottom: 15px; }' +
    '.logo { width: 130px; }' +
    '.company { margin-left: 15px; line-height: 1.6; }' +
    'table { width: 100%; border-collapse: collapse; margin-top: 12px; }' +
    'th, td { border: 1px solid #000; padding: 6px; vertical-align: top; }' +
    'th { background: #f2f2f2; text-align: left; }' +
    '.right { text-align: right; } .center { text-align: center; } .bold { font-weight: bold; }' +
    '.signature { margin-top: 50px; text-align: right; }' +
    '</style></head><body>' +

    '<div class="title">Tax Invoice/Bill of Supply/Cash Memo</div>' +
    '<div class="subtitle">(Original for Recipient)</div>' +

    '<div class="header">' +
      '<img src="data:image/svg+xml;base64,' + logoBase64 + '" class="logo">' +
      '<div class="company">' +
        '<strong>Orang Utan Organics LLP</strong><br>' +
        'Village - Bhangeli, Gangnani,<br>' +
        'Uttarkashi, Uttarakhand, 249135, IN.<br>' +
        'GSTIN: 05AAJFO2664F1ZB' +
      '</div>' +
    '</div>' +

    '<table>' +
      '<tr><td><strong>Order Number:</strong> ' + esc(data.orderId) + '</td>' +
          '<td><strong>Invoice Number:</strong> ' + esc(data.orderId) + '</td></tr>' +
      '<tr><td><strong>Order Date:</strong> ' + esc(formattedDate) + '</td>' +
          '<td><strong>Invoice Date:</strong> ' + esc(formattedDate) + '</td></tr>' +
    '</table>' +

    '<table>' +
      '<tr><th>Billing Address</th><th>Shipping Address</th></tr>' +
      '<tr>' +
        '<td>' + esc(data.name) + '<br>' + esc(data.address) + '<br>' +
          esc(data.city) + ', ' + esc(data.state) + ' - ' + esc(data.pincode) + '<br>' +
          'Phone: ' + esc(data.phone) + '<br>Place of supply: ' + esc(data.state) + '</td>' +
        '<td>' + esc(data.name) + '<br>' + esc(data.address) + '<br>' +
          esc(data.city) + ', ' + esc(data.state) + ' - ' + esc(data.pincode) + '<br>' +
          'Phone: ' + esc(data.phone) + '<br>Place of delivery: ' + esc(data.state) + '</td>' +
      '</tr>' +
    '</table>' +

    '<table>' +
      '<tr>' +
        '<th>Product</th><th>HSN Code</th><th>Unit Price (Net)</th><th>Qty</th>' +
        '<th>Net Amount</th><th>Tax Rate %</th><th>Tax Type</th>' +
        '<th>Tax Amount</th><th>Total Amount</th>' +
      '</tr>' +
      productRows +
    '</table>' +

    '<table>' +
      '<tr>' +
        '<td colspan="8" class="left bold">Total</td>' +
        '<td class="right bold">' + esc(totalAmount.toFixed(2)) + '</td>' +
      '</tr>' +
      (discountAmount > 0 ?
      '<tr>' +
        '<td colspan="8" class="left bold">Discount ' + (data.coupon ? '(' + esc(data.coupon) + ')' : '') + '</td>' +
        '<td class="right">-' + esc(discountAmount.toFixed(2)) + '</td>' +
      '</tr>' : '') +
      (shippingCharge > 0 ?
      '<tr>' +
        '<td colspan="8" class="left bold">Shipping Charges</td>' +
        '<td class="right">' + esc(shippingCharge.toFixed(2)) + '</td>' +
      '</tr>' : '') +
      (codCharge > 0 ?
      '<tr>' +
        '<td colspan="8" class="left bold">COD Charges</td>' +
        '<td class="right">' + esc(codCharge.toFixed(2)) + '</td>' +
      '</tr>' : '') +
      '<tr>' +
        '<td colspan="8" class="left bold" style="font-size:16px;">Net Amount Payable</td>' +
        '<td class="right bold" style="font-size:16px;">₹' + esc(finalTotal.toFixed(2)) + '</td>' +
      '</tr>' +
    '</table>' +

    (data.paymentId ?
    '<table>' +
      '<tr><td><strong>Payment Transaction ID</strong></td><td>' + esc(data.paymentId) + '</td></tr>' +
      '<tr><td><strong>Date</strong></td><td>' + esc(formattedDate) + '</td></tr>' +
      '<tr><td><strong>Mode of Payment</strong></td><td>' + esc(data.paymentMode) + '</td></tr>' +
    '</table>' :
    '<table>' +
      '<tr><td><strong>Date</strong></td><td>' + esc(formattedDate) + '</td></tr>' +
      '<tr><td><strong>Mode of Payment</strong></td><td>' + esc(data.paymentMode) + '</td></tr>' +
    '</table>') +

    '<div class="signature">' +
      '<p><strong>For Orang Utan Organics LLP</strong></p><br><br>' +
      '<p>Authorized Signatory</p>' +
    '</div>' +

    '</body></html>';

  // Sanitize the filename — strip anything that isn't safe in a filesystem
  // path so a hostile orderId can't traverse or inject a Content-Disposition
  // shenanigan on the download side.
  var safeOrderIdForFilename = String(data.orderId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

  var blob = Utilities.newBlob(html, 'text/html');
  var pdf = blob.getAs('application/pdf').setName('Invoice_' + safeOrderIdForFilename + '.pdf');
  return pdf;
}

// =====================================================
// =================== TEST FUNCTIONS ===================
// =====================================================

function testContactForm() {
  var e = {
    postData: {
      contents: JSON.stringify({
        type: 'contact',
        name: 'Test User',
        email: 'test@example.com',
        phone: '+91 12345 67890',
        subject: 'Website Inquiry',
        message: 'Hello, this is a test contact form message.',
        timestamp: new Date().toISOString(),
      }),
    },
  };
  Logger.log(doPost(e).getContent());
}

function testReviewForm() {
  var e = {
    postData: {
      contents: JSON.stringify({
        type: 'review',
        product: 'Badri Cow Ghee',
        name: 'Test Customer',
        email: 'test@example.com',
        location: 'Delhi',
        rating: 5,
        review: 'Excellent product and packaging!',
        source: 'Website',
      }),
    },
  };
  Logger.log(doPost(e).getContent());
}

function testCheckoutOrder() {
  // Read the same Script Property the request path uses so a real payload
  // is constructed. Trips the fail-closed reject if the operator hasn't
  // set the secret yet — intended behavior.
  var secret = PropertiesService.getScriptProperties()
    .getProperty(SCRIPT_SHARED_SECRET_PROPERTY) || '';
  var e = {
    postData: {
      contents: JSON.stringify({
        type: 'checkout',
        secret: secret,
        orderId: 'OUO-TEST-' + Date.now(),
        timestamp: new Date().toISOString(),
        name: 'Test Customer',
        email: 'logeshe48@gmail.com',
        phone: '+91 79067 69090',
        address: '123 Test Street, Test Area',
        pincode: '110001',
        city: 'Delhi',
        state: 'Delhi',
        products: [
          { name: 'Badri Cow Ghee',           size: '295gm', quantity: 2, price: 449, gst_rate: 5 },
          { name: 'Himalayan White Rajma',    size: '1kg',   quantity: 1, price: 299, gst_rate: 5 },
        ],
        paymentMode: 'Prepaid',
        paymentStatus: 'Paid',
        paymentId: 'pay_test123',
        subtotal: 1197,
        shippingCharge: 0,
        codCharge: 0,
        discount: 50,
        total: 1147,
        delhiveryResponse: '{"success": true}',
      }),
    },
  };
  Logger.log(doPost(e).getContent());
}
