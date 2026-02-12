/**
 * Orangutan Organics – WhatsApp Order Handler
 * Handles order submissions from WhatsApp Bot
 */
const ADMIN_EMAIL = 'orangutanorganics@gmail.com';
const ORDERS_SHEET = 'Orders';

// Product → HSN Mapping for GST Invoice
const HSN_MAP = {
  "Himalayan Red Rajma": "07133300",
  "Himalayan White Rajma": "07133300",
  "Himalayan Red Rice": "10061090",
  "Badri Cow Ghee": "040590",
  "Himalayan Black Soyabean": "1201",
  "Wild Himalayan Tempering Spice": "07129090"
};

// ===== ENTRY POINT =====
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.type === 'checkout') {
      return handleCheckoutSubmission(data);
    } else {
      throw new Error('Invalid submission type. Must be "checkout".');
    }

  } catch (error) {
    console.error('Error:', error);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
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

  // Format products for display
  let productsText = '';
  if (data.products && Array.isArray(data.products)) {
    productsText = data.products.map(p => `${p.name} (${p.size}) x ${p.quantity} - ₹${p.price * p.quantity}`).join('\n');
  }

  const row = [
    data.timestamp || new Date().toISOString(),
    data.orderId || '',
    data.name || '',
    data.email || '',
    data.phone || '',
    data.address || '',
    data.pincode || '',
    data.city || '',
    data.state || '',
    productsText,
    data.paymentMode || '',
    data.paymentStatus || '',
    data.paymentId || '',
    data.subtotal || 0,
    data.shippingCharge || 0,
    data.codCharge || 0,
    data.discount || 0,
    data.total || 0,
    data.delhiveryResponse || ''
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
  const subject = `🛒 New ${data.paymentMode} Order - ${data.orderId}`;

  let productsHTML = '<ul>';
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(p => {
      productsHTML += `<li>${p.name} (${p.size}) × ${p.quantity} - ₹${p.price * p.quantity}</li>`;
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
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${data.orderId}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Payment Mode:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${data.paymentMode}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Payment Status:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${data.paymentStatus}</td>
          </tr>
          ${data.paymentId ? `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Payment ID:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${data.paymentId}</td>
          </tr>
          ` : ''}
        </table>

        <h3 style="color: #0F5B2F; margin-top: 20px;">Customer Information</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Name:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${data.name}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Email:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${data.email}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Phone:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">${data.phone}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Address:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">
              ${data.address}<br>
              ${data.city}, ${data.state} - ${data.pincode}
            </td>
          </tr>
        </table>

        <h3 style="color: #0F5B2F; margin-top: 20px;">Products Ordered</h3>
        ${productsHTML}

        <h3 style="color: #0F5B2F; margin-top: 20px;">Pricing Summary</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Subtotal:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">₹${data.subtotal}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Shipping:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">₹${data.shippingCharge}</td>
          </tr>
          ${isCOD ? `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">COD Charge:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white;">₹${data.codCharge}</td>
          </tr>
          ` : ''}
          ${hasDiscount ? `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white;">Discount:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white; color: #059669;">-₹${data.discount}</td>
          </tr>
          ` : ''}
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: white; font-size: 18px;">Total:</td>
            <td style="padding: 8px; border: 1px solid #ddd; background: white; font-weight: bold; color: #F46A1F; font-size: 18px;">₹${data.total}</td>
          </tr>
        </table>

        <div style="margin-top: 20px; text-align: center;">
          <a href="https://docs.google.com/spreadsheets/d/${SpreadsheetApp.getActiveSpreadsheet().getId()}"
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
  const subject = `Order Confirmed - ${data.orderId} | Orangutan Organics`;

  let productsHTML = '<ul style="list-style: none; padding: 0;">';
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(p => {
      productsHTML += `
        <li style="padding: 10px; margin: 5px 0; background: white; border-left: 3px solid #F46A1F;">
          ${p.name} (${p.size}) × ${p.quantity} - ₹${p.price * p.quantity}
        </li>
      `;
    });
  }
  productsHTML += '</ul>';

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #0F5B2F, #F46A1F); padding: 30px; text-align: center;">
        <h1 style="color: white; margin: 0;">✅ Order Confirmed!</h1>
      </div>

      <div style="padding: 30px; background: #F5F2EB;">
        <p style="font-size: 16px;">Dear ${data.name},</p>

        <p style="font-size: 16px;">
          Thank you for your order from Orangutan Organics! Your order has been successfully placed and will be shipped soon.
        </p>

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h2 style="color: #0F5B2F; margin-top: 0;">Order Summary</h2>
          <p><strong>Order ID:</strong> ${data.orderId}</p>
          <p><strong>Payment Mode:</strong> ${data.paymentMode}</p>
          ${isCOD ? '<p style="color: #F46A1F;"><strong>Amount to Pay on Delivery:</strong> ₹' + data.total + '</p>' : '<p style="color: #059669;"><strong>Payment Status:</strong> ' + data.paymentStatus + '</p>'}
        </div>

        <h3 style="color: #0F5B2F;">Your Products</h3>
        ${productsHTML}

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #0F5B2F; margin-top: 0;">Pricing Breakdown</h3>
          <table style="width: 100%;">
            <tr>
              <td>Subtotal:</td>
              <td style="text-align: right;">₹${data.subtotal}</td>
            </tr>
            <tr>
              <td>Shipping:</td>
              <td style="text-align: right;">${data.shippingCharge > 0 ? '₹' + data.shippingCharge : 'FREE'}</td>
            </tr>
            ${isCOD ? `
            <tr>
              <td>COD Charge:</td>
              <td style="text-align: right;">₹${data.codCharge}</td>
            </tr>
            ` : ''}
            ${hasDiscount ? `
            <tr>
              <td style="color: #059669;">Discount:</td>
              <td style="text-align: right; color: #059669;">-₹${data.discount}</td>
            </tr>
            ` : ''}
            <tr style="border-top: 2px solid #0F5B2F; font-weight: bold; font-size: 18px;">
              <td style="padding-top: 10px;">Total:</td>
              <td style="text-align: right; color: #F46A1F; padding-top: 10px;">₹${data.total}</td>
            </tr>
          </table>
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #0F5B2F; margin-top: 0;">Delivery Address</h3>
          <p style="margin: 0; line-height: 1.6;">
            ${data.name}<br>
            ${data.address}<br>
            ${data.city}, ${data.state} - ${data.pincode}<br>
            Phone: ${data.phone}
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
function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// Helper: Download logo and convert to Base64
function getLogoBase64() {
  const url = "https://orangutanorganics.com/static/media/Orang-utan-color-logo-1.df123e4b4aafc86a4500.png";
  const response = UrlFetchApp.fetch(url);
  const blob = response.getBlob();
  return Utilities.base64Encode(blob.getBytes());
}

// Generate GST Invoice PDF
function generateInvoicePDF(data) {
  const logoBase64 = getLogoBase64();

  // Generate product rows with corrected GST calculation
  // NOTE: Product prices INCLUDE 5% GST
  // So Net Amount = Price / 1.05, Tax = Net * 0.05, Total = Price
  let productRows = '';
  let totalNetAmount = 0;
  let totalTaxAmount = 0;
  let totalAmount = 0;

  if (data.products && Array.isArray(data.products)) {
    data.products.forEach(p => {
      const hsn = HSN_MAP[p.name] || "";
      const priceWithGST = p.price; // This already includes 5% GST
      const netPerUnit = priceWithGST / 1.05; // Remove GST to get net price
      const netAmount = netPerUnit * p.quantity;
      const taxRate = 5;
      const taxAmount = netAmount * (taxRate / 100);
      const total = netAmount + taxAmount; // This equals priceWithGST * quantity

      totalNetAmount += netAmount;
      totalTaxAmount += taxAmount;
      totalAmount += total;

      productRows += `
      <tr>
        <td>${p.name} (${p.size})</td>
        <td>${hsn}</td>
        <td class="right">${netPerUnit.toFixed(2)}</td>
        <td class="right">${p.quantity}</td>
        <td class="right">${netAmount.toFixed(2)}</td>
        <td class="right">${taxRate}</td>
        <td class="right">IGST</td>
        <td class="right">${taxAmount.toFixed(2)}</td>
        <td class="right">${total.toFixed(2)}</td>
      </tr>
      `;
    });
  }

  // Calculate final amounts
  const discountAmount = data.discount || 0;
  const shippingCharge = data.shippingCharge || 0;
  const codCharge = data.codCharge || 0;
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
    <img src="data:image/png;base64,${logoBase64}" class="logo">
    <div class="company">
      <strong>Orang Utan Organics LLP</strong><br>
      Village - Bhangeli, Gangnani,<br>
      Uttarkashi, Uttarakhand, 249135, IN.<br>
      GSTIN: 05AAJFO2664F1ZB
    </div>
  </div>

  <table>
    <tr>
      <td><strong>Order Number:</strong> ${data.orderId}</td>
      <td><strong>Invoice Number:</strong> ${data.orderId}</td>
    </tr>
    <tr>
      <td><strong>Order Date:</strong> ${formattedDate}</td>
      <td><strong>Invoice Date:</strong> ${formattedDate}</td>
    </tr>
  </table>

  <table>
    <tr>
      <th>Billing Address</th>
      <th>Shipping Address</th>
    </tr>
    <tr>
      <td>
        ${data.name}<br>
        ${data.address}<br>
        ${data.city}, ${data.state} - ${data.pincode}<br>
        Phone: ${data.phone}<br>
        Place of supply: ${data.state}
      </td>
      <td>
        ${data.name}<br>
        ${data.address}<br>
        ${data.city}, ${data.state} - ${data.pincode}<br>
        Phone: ${data.phone}<br>
        Place of delivery: ${data.state}
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
    <td class="right bold">${totalAmount.toFixed(2)}</td>
  </tr>

  ${discountAmount > 0 ? `
  <tr>
    <td colspan="8" class="left bold">Discount ${data.coupon ? '(' + data.coupon + ')' : ''}</td>
    <td class="right">-${discountAmount.toFixed(2)}</td>
  </tr>
  ` : ''}

  ${shippingCharge > 0 ? `
  <tr>
    <td colspan="8" class="left bold">Shipping Charges</td>
    <td class="right">${shippingCharge.toFixed(2)}</td>
  </tr>
  ` : ''}

  ${codCharge > 0 ? `
  <tr>
    <td colspan="8" class="left bold">COD Charges</td>
    <td class="right">${codCharge.toFixed(2)}</td>
  </tr>
  ` : ''}

  <tr>
    <td colspan="8" class="left bold" style="font-size: 16px;">Net Amount Payable</td>
    <td class="right bold" style="font-size: 16px;">₹${finalTotal.toFixed(2)}</td>
  </tr>
</table>

${data.paymentId ? `
<table>
    <tr>
      <td><strong>Payment Transaction ID</strong></td>
      <td>${data.paymentId}</td>
    </tr>
    <tr>
      <td><strong>Date</strong></td>
      <td>${formattedDate}</td>
    </tr>
    <tr>
      <td><strong>Mode of Payment</strong></td>
      <td>${data.paymentMode}</td>
    </tr>
  </table>
` : `
<table>
<tr>
      <td><strong>Date</strong></td>
      <td>${formattedDate}</td>
    </tr>
    <tr>
      <td><strong>Mode of Payment</strong></td>
      <td>${data.paymentMode}</td>
    </tr>
  </table>
`}


  </body>
  </html>
  `;

  const blob = Utilities.newBlob(html, "text/html");
  const pdf = blob.getAs("application/pdf").setName(`Invoice_${data.orderId}.pdf`);

  return pdf;
}

// =====================================================
// =================== TEST FUNCTION ====================
// =====================================================
function testCheckoutOrder() {
  const e = {
    postData: {
      contents: JSON.stringify({
        type: 'checkout',
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