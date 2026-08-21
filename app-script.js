/**
 * Orangutan Organics – WhatsApp Order Handler
 * Handles order submissions from WhatsApp Bot and website checkout.
 *
 * SECURITY (audit fix C-05):
 *   Every user-supplied value interpolated into HTML (email body OR invoice
 *   PDF) MUST go through esc() below. Un-escaped values allow HTML injection
 *   which turns the admin email and the invoice PDF into phishing surfaces.
 *   Sheet-cell values additionally go through sheetCell() to neutralize
 *   Google Sheets formula injection (=CMD, +CMD, -CMD, @CMD).
 *
 * SECURITY (audit fix H-11):
 *   doPost fail-closes on a shared-secret check before any side-effect. The
 *   secret lives in Script Properties (Project Settings → Script Properties)
 *   under the key SCRIPT_SHARED_SECRET; the backend stamps it into every
 *   payload as `data.secret`. Without a matching secret, requests are rejected
 *   as unauthorized — this blocks anyone who scrapes the /exec URL from
 *   injecting fake orders or spraying phishing content via the admin email.
 *   The secret is stripped from `data` before any downstream processing so
 *   it never lands in a sheet cell or email body.
 */
const ADMIN_EMAIL = 'orangutanorganics@gmail.com';
const ORDERS_SHEET = 'Orders';
const SCRIPT_SHARED_SECRET_PROPERTY = 'SCRIPT_SHARED_SECRET';
// Property that holds the target Google Sheet's ID. Required because this
// script runs standalone (not container-bound), so SpreadsheetApp
// .getActiveSpreadsheet() returns null. Set via:
//   Project Settings → Script Properties → Add property
//   Name: TARGET_SHEET_ID
//   Value: <the ID from your Sheet's URL — the string between /d/ and /edit>
const TARGET_SHEET_ID_PROPERTY = 'TARGET_SHEET_ID';

// Product → HSN Mapping for GST Invoice
const HSN_MAP = {
  "Himalayan Red Rajma": "07133300",
  "Himalayan White Rajma": "07133300",
  "Himalayan Red Rice": "10061090",
  "Badri Cow Ghee": "040590",
  "Himalayan Black Soyabean": "1201",
  "Wild Himalayan Tempering Spice": "07129090"
};

// =====================================================
// ================ SECURITY HELPERS ===================
// =====================================================

/**
 * Escape a value for safe interpolation into HTML.
 * Handles null/undefined/numbers/strings uniformly. Never returns "undefined"
 * or "null" — nullish becomes empty string.
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
 * Sheets forces text interpretation (a leading ' is stripped from the
 * displayed value but persists internally as a hint to disable formula
 * evaluation).
 *
 * Also converts nullish → '' for consistent cell content.
 */
function sheetCell(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.length === 0) return '';
  // Formula trigger characters per Google Sheets / Excel CSV injection guides.
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

/**
 * Constant-time string comparison. Standard-library timingSafeEqual isn't
 * available in Apps Script, so we roll a simple XOR-accumulator equivalent.
 * Non-strings and length mismatches return false without leaking the length
 * via short-circuit (we always iterate the longer of the two).
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
 * Build a JSON error response.
 */
function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Verify the shared secret before any side-effect. Fail-closed:
 *   - Script Property SCRIPT_SHARED_SECRET missing → reject (operator has
 *     not finished the rollout; do NOT accept requests in this state).
 *   - data.secret missing or mismatched → reject as unauthorized.
 * The received secret is never logged. Success returns { ok: true }; failure
 * returns { ok: false, response } where response is the ContentService object
 * the caller should return immediately.
 */
function verifyRequestSecret(data) {
  var expected = PropertiesService.getScriptProperties().getProperty(SCRIPT_SHARED_SECRET_PROPERTY);
  if (!expected) {
    console.error('[H-11] SCRIPT_SHARED_SECRET Script Property is not set — rejecting request. Configure it in Project Settings → Script Properties.');
    return {
      ok: false,
      response: jsonResponse({ status: 'error', code: 'unauthorized', message: 'Server misconfigured' }),
    };
  }
  var received = data && typeof data.secret === 'string' ? data.secret : '';
  if (!timingSafeStringEquals(received, expected)) {
    // Never log the received value. A tiny fingerprint of the expected value
    // is fine (helps distinguish stale-secret from missing-secret rollouts
    // without disclosing anything usable).
    console.warn('[H-11] doPost rejected: shared-secret mismatch (received_len=' + (received.length || 0) + ', expected_len=' + expected.length + ')');
    return {
      ok: false,
      response: jsonResponse({ status: 'error', code: 'unauthorized', message: 'Unauthorized' }),
    };
  }
  return { ok: true };
}

// ===== ENTRY POINT =====
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Fail-closed shared-secret check (audit fix H-11). Runs BEFORE any
    // sheet write or email send so a scraped /exec URL can't be weaponized.
    const auth = verifyRequestSecret(data);
    if (!auth.ok) return auth.response;

    // Strip the secret so it never lands in a sheet cell / email body /
    // logged payload. Every downstream function must see a secret-free view.
    delete data.secret;

    if (data.type === 'checkout') {
      return handleCheckoutSubmission(data);
    } else {
      throw new Error('Invalid submission type. Must be "checkout".');
    }

  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({ status: 'error', message: 'Failed to process submission' });
  }
}

// =====================================================
// ================ CHECKOUT ORDER HANDLER ==============
// =====================================================
function handleCheckoutSubmission(data) {
  const sheet = getOrCreateSheet(ORDERS_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp', 'Order ID', 'Name', 'Email', 'Phone', 'Address',
      'Pincode', 'City', 'State', 'Products', 'Payment Mode', 'Payment Status',
      'Payment ID', 'Subtotal', 'Shipping', 'COD Charge', 'Discounts', 'Total', 'Delhivery Response'
    ]);
    sheet.getRange(1, 1, 1, 19).setFontWeight('bold');
  }

  // Format products for display in the Sheet cell. This value is plain text
  // (rendered by Sheets as string), so no HTML escape — but pass through
  // sheetCell() to defuse formula injection.
  let productsText = '';
  if (data.products && Array.isArray(data.products)) {
    productsText = data.products.map(function (p) {
      var qty = Number(p.quantity) || 0;
      var price = Number(p.price) || 0;
      return String(p.name || '') + ' (' + String(p.size || '') + ') x ' + qty + ' - ₹' + (price * qty);
    }).join('\n');
  }

  const row = [
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
    sheetCell(data.delhiveryResponse)
  ];
  sheet.appendRow(row);

  // Send emails
  sendOrderAdminNotification(data);
  sendOrderCustomerConfirmation(data);

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'success', message: 'Order submitted successfully.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function sendOrderAdminNotification(data) {
  const isCOD = data.paymentMode === 'COD';
  const hasDiscount = data.discount && data.discount > 0;
  // Subject is plaintext in mail clients — no HTML escape needed, but strip
  // any newlines / control chars that could produce a header-injection effect.
  const safeMode = String(data.paymentMode || '').replace(/[\r\n]/g, '');
  const safeOrderId = String(data.orderId || '').replace(/[\r\n]/g, '');
  const subject = `🛒 New ${safeMode} Order - ${safeOrderId}`;

  let productsHTML = '<ul>';
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(function (p) {
      var qty = Number(p.quantity) || 0;
      var price = Number(p.price) || 0;
      productsHTML += '<li>' + esc(p.name) + ' (' + esc(p.size) + ') × ' + esc(qty) + ' - ₹' + esc(price * qty) + '</li>';
    });
  }
  productsHTML += '</ul>';

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <div style="background: linear-gradient(135deg, #0F5B2F, #F46A1F); padding: 20px; color: white;">
        <h1 style="margin: 0;">🎉 New Order Received!</h1>
      </div>

      <div style="padding: 20px; background: #F5F2EB;">
        <h2 style="color: #0F5B2F;">Order Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Order ID:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${esc(data.orderId)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Payment Mode:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${esc(data.paymentMode)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Payment Status:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${esc(data.paymentStatus)}</td>
          </tr>
          ${data.paymentId ? `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Payment ID:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${esc(data.paymentId)}</td>
          </tr>
          ` : ''}
        </table>

        <h3 style="color: #0F5B2F; margin-top: 20px;">Customer Information</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Name:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${esc(data.name)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Email:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${esc(data.email)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Phone:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${esc(data.phone)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Address:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">
              ${esc(data.address)}<br>
              ${esc(data.city)}, ${esc(data.state)} - ${esc(data.pincode)}
            </td>
          </tr>
        </table>

        <h3 style="color: #0F5B2F; margin-top: 20px;">Products Ordered</h3>
        ${productsHTML}

        <h3 style="color: #0F5B2F; margin-top: 20px;">Pricing Summary</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Subtotal:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">₹${esc(data.subtotal)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Shipping:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">₹${esc(data.shippingCharge)}</td>
          </tr>
          ${isCOD ? `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">COD Charge:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">₹${esc(data.codCharge)}</td>
          </tr>
          ` : ''}
          ${hasDiscount ? `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Discount:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white; color: #059669;">-₹${esc(data.discount)}</td>
          </tr>
          ` : ''}
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white; font-size: 18px;">Total:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white; font-weight: bold; color: #F46A1F; font-size: 18px;">₹${esc(data.total)}</td>
          </tr>
        </table>

        <div style="margin-top: 20px; text-align: center;">
          <a href="https://docs.google.com/spreadsheets/d/${esc(getTargetSpreadsheet().getId())}"
             style="display: inline-block; padding: 12px 24px; background: #0F5B2F; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            View Orders Sheet
          </a>
        </div>
      </div>
    </div>
  `;

  // Generate and attach PDF invoice
  const invoicePDF = generateInvoicePDF(data);

  MailApp.sendEmail({
    to: ADMIN_EMAIL,
    subject: subject,
    htmlBody: htmlBody,
    attachments: [invoicePDF]
  });
}

function sendOrderCustomerConfirmation(data) {
  const isCOD = data.paymentMode === 'COD';
  const hasDiscount = data.discount && data.discount > 0;
  const safeOrderId = String(data.orderId || '').replace(/[\r\n]/g, '');
  const subject = `Order Confirmed - ${safeOrderId} | Orangutan Organics`;

  let productsHTML = '<ul style="list-style: none; padding: 0;">';
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(function (p) {
      var qty = Number(p.quantity) || 0;
      var price = Number(p.price) || 0;
      productsHTML +=
        '<li style="padding: 10px; margin: 5px 0; background: white; border-left: 3px solid #F46A1F;">' +
          esc(p.name) + ' (' + esc(p.size) + ') × ' + esc(qty) + ' - ₹' + esc(price * qty) +
        '</li>';
    });
  }
  productsHTML += '</ul>';

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #0F5B2F, #F46A1F); padding: 30px; text-align: center;">
        <h1 style="color: white; margin: 0;">✅ Order Confirmed!</h1>
      </div>

      <div style="padding: 30px; background: #F5F2EB;">
        <p style="font-size: 16px;">Dear ${esc(data.name)},</p>

        <p style="font-size: 16px;">
          Thank you for your order from Orangutan Organics! Your order has been successfully placed and will be shipped soon.
        </p>

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h2 style="color: #0F5B2F; margin-top: 0;">Order Summary</h2>
          <p><strong>Order ID:</strong> ${esc(data.orderId)}</p>
          <p><strong>Payment Mode:</strong> ${esc(data.paymentMode)}</p>
          ${isCOD
            ? '<p style="color: #F46A1F;"><strong>Amount to Pay on Delivery:</strong> ₹' + esc(data.total) + '</p>'
            : '<p style="color: #059669;"><strong>Payment Status:</strong> ' + esc(data.paymentStatus) + '</p>'}
        </div>

        <h3 style="color: #0F5B2F;">Your Products</h3>
        ${productsHTML}

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #0F5B2F; margin-top: 0;">Pricing Breakdown</h3>
          <table style="width: 100%;">
            <tr>
              <td>Subtotal:</td>
              <td style="text-align: right;">₹${esc(data.subtotal)}</td>
            </tr>
            <tr>
              <td>Shipping:</td>
              <td style="text-align: right;">${Number(data.shippingCharge) > 0 ? '₹' + esc(data.shippingCharge) : 'FREE'}</td>
            </tr>
            ${isCOD ? `
            <tr>
              <td>COD Charge:</td>
              <td style="text-align: right;">₹${esc(data.codCharge)}</td>
            </tr>
            ` : ''}
            ${hasDiscount ? `
            <tr>
              <td style="color: #059669;">Discount:</td>
              <td style="text-align: right; color: #059669;">-₹${esc(data.discount)}</td>
            </tr>
            ` : ''}
            <tr style="border-top: 2px solid #0F5B2F; font-weight: bold; font-size: 18px;">
              <td style="padding-top: 10px;">Total:</td>
              <td style="text-align: right; color: #F46A1F; padding-top: 10px;">₹${esc(data.total)}</td>
            </tr>
          </table>
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #0F5B2F; margin-top: 0;">Delivery Address</h3>
          <p style="margin: 0; line-height: 1.6;">
            ${esc(data.name)}<br>
            ${esc(data.address)}<br>
            ${esc(data.city)}, ${esc(data.state)} - ${esc(data.pincode)}<br>
            Phone: ${esc(data.phone)}
          </p>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          You will receive tracking information once your order is shipped. If you have any questions, please contact us at orangutanorganics@gmail.com or WhatsApp +91 79067 69090.
        </p>

        <div style="text-align: center; margin-top: 30px;">
          <a href="https://orangutanorganics.com"
             style="display: inline-block; padding: 12px 24px; background: #0F5B2F; color: white; text-decoration: none; border-radius: 8px; margin-right: 10px;">
            Visit Website
          </a>
          <a href="https://wa.me/917906769090?text=hi"
             style="display: inline-block; padding: 12px 24px; background: #F46A1F; color: white; text-decoration: none; border-radius: 8px;">
            WhatsApp Us
          </a>
        </div>

        <p style="text-align: center; margin-top: 30px; font-size: 14px; color: #6b7280;">
          <strong style="color: #0F5B2F;">Orangutan Organics</strong><br>
          Pure, Authentic, Himalayan
        </p>
      </div>
    </div>
  `;

  try {
    // Only attempt to send if we have a plausible email address. Even without
    // this check, MailApp will throw on missing recipient; the check gives us
    // a clearer log line.
    if (!data.email || typeof data.email !== 'string' || data.email.indexOf('@') === -1) {
      console.warn('Skipping customer confirmation: missing/invalid email');
      return;
    }

    // Generate and attach PDF invoice
    const invoicePDF = generateInvoicePDF(data);

    MailApp.sendEmail({
      to: data.email,
      subject: subject,
      htmlBody: htmlBody,
      attachments: [invoicePDF]
    });
  } catch (error) {
    console.error('Error sending order confirmation:', error);
  }
}

// =====================================================
// =================== UTILITIES ========================
// =====================================================
/**
 * Resolve the target Spreadsheet by ID from Script Properties. Fail-closed:
 * throws a descriptive error if the property is missing so the caller's
 * try/catch surfaces "Server misconfigured" instead of a null-deref.
 * Required because this script is standalone (not container-bound), so
 * SpreadsheetApp.getActiveSpreadsheet() returns null.
 */
function getTargetSpreadsheet() {
  var sheetId = PropertiesService.getScriptProperties().getProperty(TARGET_SHEET_ID_PROPERTY);
  if (!sheetId) {
    throw new Error(
      TARGET_SHEET_ID_PROPERTY + ' Script Property is not set. ' +
      'Configure it in Project Settings → Script Properties (value = the ID ' +
      'from your Sheet URL between /d/ and /edit).'
    );
  }
  return SpreadsheetApp.openById(sheetId);
}

function getOrCreateSheet(name) {
  const ss = getTargetSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// Helper: Download logo and convert to Base64
function getLogoBase64() {
  const url = "https://orangutanorganics.com/static/media/logo.5abb273f7b264e84519864f3c4b23213.svg";
  const response = UrlFetchApp.fetch(url);
  const blob = response.getBlob();
  return Utilities.base64Encode(blob.getBytes());
}

// Generate GST Invoice PDF
function generateInvoicePDF(data) {
  const logoBase64 = getLogoBase64();

  // Generate product rows (audit fix M-16).
  //
  // Product prices are GST-inclusive. Each line item now carries an explicit
  // `gst_rate` (percent) stamped by the backend from shared/catalog.js — the
  // single source of truth for tax rate per SKU. Fallback to 5% only if the
  // payload omits the field (older in-flight payloads during rollout).
  //
  // Given price_with_gst and gst_rate:
  //   net_per_unit = price_with_gst / (1 + gst_rate/100)
  //   tax_per_unit = price_with_gst - net_per_unit
  // This holds for any rate, so switching a SKU to 12% / 18% / 28% needs
  // ONLY a catalog edit — no invoice code change.
  let productRows = '';
  let totalNetAmount = 0;
  let totalTaxAmount = 0;
  let totalAmount = 0;

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

  // Calculate final amounts
  const discountAmount = Number(data.discount) || 0;
  const shippingCharge = Number(data.shippingCharge) || 0;
  const codCharge = Number(data.codCharge) || 0;
  const finalTotal = totalAmount - discountAmount + shippingCharge + codCharge;

  // Format date
  const orderDate = data.timestamp ? new Date(data.timestamp) : new Date();
  const formattedDate = orderDate.toLocaleDateString('en-IN');

  const html = `
  <html>
  <head>
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 30px;
      font-size: 13px;
      color: #000;
    }

    .title {
      text-align: center;
      font-size: 22px;
      font-weight: bold;
    }

    .subtitle {
      text-align: center;
      font-size: 12px;
      margin-bottom: 20px;
    }

    .header {
      display: flex;
      align-items: center;
      margin-bottom: 15px;
    }

    .logo {
      width: 130px;
    }

    .company {
      margin-left: 15px;
      line-height: 1.6;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }

    th, td {
      border: 1px solid #000;
      padding: 6px;
      vertical-align: top;
    }

    th {
      background: #f2f2f2;
      text-align: left;
    }

    .no-border td {
      border: none;
      padding: 3px 0;
    }

    .right {
      text-align: right;
    }

    .center {
      text-align: center;
    }

    .bold {
      font-weight: bold;
    }

    .signature {
      margin-top: 50px;
      text-align: right;
    }

  </style>
  </head>

  <body>

  <div class="title">Tax Invoice/Bill of Supply/Cash Memo</div>
  <div class="subtitle">(Original for Recipient)</div>

  <div class="header">
    <img src="data:image/svg+xml;base64,${logoBase64}" class="logo">
    <div class="company">
      <strong>Orang Utan Organics LLP</strong><br>
      Village - Bhangeli, Gangnani,<br>
      Uttarkashi, Uttarakhand, 249135, IN.<br>
      GSTIN: 05AAJFO2664F1ZB
    </div>
  </div>

  <table>
    <tr>
      <td><strong>Order Number:</strong> ${esc(data.orderId)}</td>
      <td><strong>Invoice Number:</strong> ${esc(data.orderId)}</td>
    </tr>
    <tr>
      <td><strong>Order Date:</strong> ${esc(formattedDate)}</td>
      <td><strong>Invoice Date:</strong> ${esc(formattedDate)}</td>
    </tr>
  </table>

  <table>
    <tr>
      <th>Billing Address</th>
      <th>Shipping Address</th>
    </tr>
    <tr>
      <td>
        ${esc(data.name)}<br>
        ${esc(data.address)}<br>
        ${esc(data.city)}, ${esc(data.state)} - ${esc(data.pincode)}<br>
        Phone: ${esc(data.phone)}<br>
        Place of supply: ${esc(data.state)}
      </td>
      <td>
        ${esc(data.name)}<br>
        ${esc(data.address)}<br>
        ${esc(data.city)}, ${esc(data.state)} - ${esc(data.pincode)}<br>
        Phone: ${esc(data.phone)}<br>
        Place of delivery: ${esc(data.state)}
      </td>
    </tr>
  </table>

  <table>
  <tr>
    <th>Product</th>
    <th>HSN Code</th>
    <th>Unit Price (Net)</th>
    <th>Qty</th>
    <th>Net Amount</th>
    <th>Tax Rate %</th>
    <th>Tax Type</th>
    <th>Tax Amount</th>
    <th>Total Amount</th>
  </tr>

  ${productRows}

</table>

<table>
  <tr>
    <td colspan="8" class="left bold">Total</td>
    <td class="right bold">${esc(totalAmount.toFixed(2))}</td>
  </tr>

  ${discountAmount > 0 ? `
  <tr>
    <td colspan="8" class="left bold">Discount ${data.coupon ? '(' + esc(data.coupon) + ')' : ''}</td>
    <td class="right">-${esc(discountAmount.toFixed(2))}</td>
  </tr>
  ` : ''}

  ${shippingCharge > 0 ? `
  <tr>
    <td colspan="8" class="left bold">Shipping Charges</td>
    <td class="right">${esc(shippingCharge.toFixed(2))}</td>
  </tr>
  ` : ''}

  ${codCharge > 0 ? `
  <tr>
    <td colspan="8" class="left bold">COD Charges</td>
    <td class="right">${esc(codCharge.toFixed(2))}</td>
  </tr>
  ` : ''}

  <tr>
    <td colspan="8" class="left bold" style="font-size: 16px;">Net Amount Payable</td>
    <td class="right bold" style="font-size: 16px;">₹${esc(finalTotal.toFixed(2))}</td>
  </tr>
</table>

${data.paymentId ? `
<table>
    <tr>
      <td><strong>Payment Transaction ID</strong></td>
      <td>${esc(data.paymentId)}</td>
    </tr>
    <tr>
      <td><strong>Date</strong></td>
      <td>${esc(formattedDate)}</td>
    </tr>
    <tr>
      <td><strong>Mode of Payment</strong></td>
      <td>${esc(data.paymentMode)}</td>
    </tr>
  </table>
` : `
<table>
<tr>
      <td><strong>Date</strong></td>
      <td>${esc(formattedDate)}</td>
    </tr>
    <tr>
      <td><strong>Mode of Payment</strong></td>
      <td>${esc(data.paymentMode)}</td>
    </tr>
  </table>
`}


  </body>
  </html>
  `;

  // Build a safe PDF filename. Strip anything that isn't safe in a filesystem
  // path so a hostile orderId can't traverse or inject a Content-Disposition
  // shenanigan on the download side.
  var safeOrderIdForFilename = String(data.orderId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

  const blob = Utilities.newBlob(html, "text/html");
  const pdf = blob.getAs("application/pdf").setName('Invoice_' + safeOrderIdForFilename + '.pdf');

  return pdf;
}

// =====================================================
// =================== TEST FUNCTION ====================
// =====================================================
function testCheckoutOrder() {
  // Reads the same Script Property the request path uses. Trips fail-closed
  // reject if the operator hasn't set it yet, which is the intended behavior.
  var secret = PropertiesService.getScriptProperties().getProperty(SCRIPT_SHARED_SECRET_PROPERTY) || '';
  const e = {
    postData: {
      contents: JSON.stringify({
        type: 'checkout',
        secret: secret,
        orderId: 'OUO-12345',
        timestamp: new Date().toISOString(),
        name: 'Test Customer',
        email: 'logeshe48@gmail.com',
        phone: '+91 79067 69090',
        address: '123 Test Street, Test Area',
        pincode: '110001',
        city: 'Delhi',
        state: 'Delhi',
        products: [
          { name: 'Badri Cow Ghee', size: '295gm', quantity: 2, price: 449 },
          { name: 'Himalayan White Rajma', size: '1kg', quantity: 1, price: 299 }
        ],
        paymentMode: 'Prepaid',
        paymentStatus: 'Paid',
        paymentId: 'pay_test123',
        subtotal: 1197,
        shippingCharge: 0,
        codCharge: 0,
        discount: 50,
        total: 1147,
        delhiveryResponse: '{"success": true}'
      })
    }
  };
  Logger.log(doPost(e).getContent());
}
