import express from 'express';
import axios from 'axios';

const router = express.Router();
const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_URL;

// WhatsApp Meta API credentials
const WHATSAPP_ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const WHATSAPP_PHONE_NO_ID = process.env.PHONE_NUMBER_ID_2;
const WHATSAPP_TEMPLATE_NAME = "website_customer_order_whatsapp_message";
const WHATSAPP_LANGUAGE_CODE = "en";

/**
 * Helper: Send WhatsApp Template Message
 */
async function sendWhatsAppMessage({ name, phone, order_id }) {
  try {
    if (!phone) {
      console.warn('❌ WhatsApp: Missing phone number');
      return;
    }

    // Ensure phone number starts with '+'
    const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    const url = `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NO_ID}/messages`;

    // const payload = {
    //   messaging_product: 'whatsapp',
    //   to: formattedPhone,
    //   type: 'template',
    //   template: {
    //     name: WHATSAPP_TEMPLATE_NAME,
    //     language: { code: WHATSAPP_LANGUAGE_CODE },
    //     components: [
    //       {
    //         type: 'header',
    //         parameters: [
    //           {
    //             type: 'image',
    //             image: { id: WHATSAPP_MEDIA_ID },
    //           },
    //         ],
    //       },
    //       {
    //         type: 'body',
    //         parameters: [
    //           { type: 'text', text: name || 'Customer' }, // {{1}} variable
    //           { type: 'text', text: order_id || '1001' }, // {{1}} variable
    //         ],
    //       },
    //     ],
    //   },
    // };
    const payload = {
  messaging_product: 'whatsapp',
  to: formattedPhone,
  type: 'template',
  template: {
    name: WHATSAPP_TEMPLATE_NAME,
    language: { code: WHATSAPP_LANGUAGE_CODE },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: name || 'Customer' },   // {{1}} = Name
          { type: 'text', text: order_id || '1001' },   // {{2}} = Order ID
        ],
      },
    ],
  },
};


    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`✅ WhatsApp message sent to ${formattedPhone}`);
  } catch (err) {
    console.error('❌ WhatsApp send error:', err.response?.data || err.message);
  }
}

/**
 * POST /api/checkout/save-order
 */
router.post('/save-order', async (req, res) => {
  try {
    const orderData = req.body;

    if (!orderData.type || orderData.type !== 'checkout') {
      return res.status(400).json({
        success: false,
        message: 'Invalid order data. Must include type: "checkout"',
      });
    }

    if (!orderData.orderId) {
      return res.status(400).json({
        success: false,
        message: 'Order ID is required',
      });
    }

    console.log('Saving order to Google Sheets:', orderData.orderId);

    await axios.post(GOOGLE_SHEETS_URL, orderData, {
      headers: { 'Content-Type': 'application/json' },
    });

    console.log('Order saved successfully:', orderData.orderId);

    // ✅ Send WhatsApp message after successful save
    await sendWhatsAppMessage({
      name: orderData.customerName,
      phone: orderData.customerPhone,
      order_id: orderData.orderId
    });

    return res.json({
      success: true,
      message: 'Order saved successfully',
      orderId: orderData.orderId,
    });
  } catch (error) {
    console.error('Error saving order to Google Sheets:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to save order',
      error: error.message,
    });
  }
});

/**
 * POST /api/checkout/process-cod
 */
router.post('/process-cod', async (req, res) => {
  try {
    const { orderData, shipmentData, pickupLocation } = req.body;

    console.log('Processing COD order:', orderData.orderId);

    // Step 1: Create Delhivery shipment
    let delhiveryResponse = null;
    try {
      const payload = { shipments: [shipmentData], pickup_location: pickupLocation };
      const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

      const delhiveryRes = await axios.post(
        'https://track.delhivery.com/api/cmu/create.json',
        bodyStr,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Token ${process.env.DELHIVERY_API_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      delhiveryResponse = delhiveryRes.data;
      console.log('✅ Delhivery shipment created for COD order');
    } catch (delhiveryError) {
      console.error('❌ Delhivery error (continuing):', delhiveryError.response?.data || delhiveryError.message);
      delhiveryResponse = {
        error: delhiveryError.message,
        details: delhiveryError.response?.data,
      };
    }

    // Step 2: Save order to Google Sheets
    const orderDataWithDelhivery = {
      ...orderData,
      delhiveryResponse: JSON.stringify(delhiveryResponse),
    };

    try {
      await axios.post(GOOGLE_SHEETS_URL, orderDataWithDelhivery, {
        headers: { 'Content-Type': 'application/json' },
      });
      console.log('✅ Order saved to Google Sheets');

      // ✅ Send WhatsApp message
      await sendWhatsAppMessage({
        name: orderData.customerName,
        phone: orderData.customerPhone,
      });
    } catch (sheetError) {
      console.error('❌ Google Sheets error:', sheetError.message);
    }

    return res.json({
      success: true,
      orderId: orderData.orderId,
      delhivery: delhiveryResponse,
      message: 'COD order processed successfully',
    });
  } catch (error) {
    console.error('Error processing COD order:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to process COD order',
      error: error.message,
    });
  }
});

/**
 * POST /api/checkout/process-prepaid
 */
router.post('/process-prepaid', async (req, res) => {
  try {
    const { orderData, shipmentData, pickupLocation, paymentDetails } = req.body;

    console.log('Processing Prepaid order:', orderData.orderId);

    let delhiveryResponse = null;
    try {
      const payload = { shipments: [shipmentData], pickup_location: pickupLocation };
      const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

      const delhiveryRes = await axios.post(
        'https://track.delhivery.com/api/cmu/create.json',
        bodyStr,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Token ${process.env.DELHIVERY_API_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      delhiveryResponse = delhiveryRes.data;
      console.log('✅ Delhivery shipment created for Prepaid order');
    } catch (delhiveryError) {
      console.error('❌ Delhivery error (continuing):', delhiveryError.response?.data || delhiveryError.message);
      delhiveryResponse = {
        error: delhiveryError.message,
        details: delhiveryError.response?.data,
      };
    }

    const orderDataWithDetails = {
      ...orderData,
      paymentId: paymentDetails.payment_id,
      delhiveryResponse: JSON.stringify(delhiveryResponse),
    };

    try {
      await axios.post(GOOGLE_SHEETS_URL, orderDataWithDetails, {
        headers: { 'Content-Type': 'application/json' },
      });
      console.log('✅ Prepaid order saved to Google Sheets');

      // ✅ Send WhatsApp message
      await sendWhatsAppMessage({
        name: orderData.customerName,
        phone: orderData.customerPhone,
      });
    } catch (sheetError) {
      console.error('❌ Google Sheets error:', sheetError.message);
    }

    return res.json({
      success: true,
      orderId: orderData.orderId,
      delhivery: delhiveryResponse,
      payment: paymentDetails,
      message: 'Prepaid order processed successfully',
    });
  } catch (error) {
    console.error('Error processing Prepaid order:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to process Prepaid order',
      error: error.message,
    });
  }
});

export default router;
