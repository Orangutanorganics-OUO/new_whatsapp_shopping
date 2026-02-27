import express from 'express';
import axios from 'axios';

const router = express.Router();
const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_URL;

// Validate environment variables
if (!GOOGLE_SHEETS_URL) {
  console.warn('⚠️ GOOGLE_SHEETS_URL not configured. Order saving to Google Sheets will fail.');
}

/**
 * POST /api/checkout/save-order
 * Save order to Google Sheets
 */
router.post('/save-order', async (req, res) => {
  try {
    // Validate request body exists
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required',
      });
    }

    const orderData = req.body;

    // Validation
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

    // Check if Google Sheets URL is configured
    if (!GOOGLE_SHEETS_URL) {
      console.error('❌ Cannot save order: GOOGLE_SHEETS_URL not configured');
      return res.status(503).json({
        success: false,
        message: 'Service temporarily unavailable',
      });
    }

    console.log('Saving order to Google Sheets:', orderData.orderId);

    // Send to Google Sheets with timeout
    await axios.post(GOOGLE_SHEETS_URL, orderData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000, // 30 second timeout
    });

    console.log('✅ Order saved successfully:', orderData.orderId);

    return res.json({
      success: true,
      message: 'Order saved successfully',
      orderId: orderData.orderId,
    });
  } catch (error) {
    console.error('❌ Error saving order to Google Sheets:', error.response?.data || error.message);

    // Return appropriate status code
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
 * Process COD order (complete flow)
 */
router.post('/process-cod', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required',
      });
    }

    const { orderData, shipmentData, pickupLocation } = req.body;

    // Validate required fields
    if (!orderData || !orderData.orderId) {
      return res.status(400).json({
        success: false,
        message: 'Order data with orderId is required',
      });
    }

    if (!shipmentData) {
      return res.status(400).json({
        success: false,
        message: 'Shipment data is required',
      });
    }

    console.log('Processing COD order:', orderData.orderId);

    // Step 1: Create Delhivery shipment
    let delhiveryResponse = null;
    try {
      if (!process.env.DELHIVERY_API_KEY) {
        throw new Error('DELHIVERY_API_KEY not configured');
      }

      const payload = { shipments: [shipmentData], pickup_location: pickupLocation || {} };
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
          timeout: 20000, // 20 second timeout
        }
      );

      delhiveryResponse = delhiveryRes.data;
      console.log('✅ Delhivery shipment created for COD order');
    } catch (delhiveryError) {
      console.error('❌ Delhivery error (continuing):', delhiveryError.response?.data || delhiveryError.message);
      delhiveryResponse = {
        success: false,
        error: delhiveryError.message,
        details: delhiveryError.response?.data || null,
      };
    }

    // Step 2: Save order to Google Sheets
    const orderDataWithDelhivery = {
      ...orderData,
      delhiveryResponse: JSON.stringify(delhiveryResponse || {}),
    };

    try {
      if (GOOGLE_SHEETS_URL) {
        await axios.post(GOOGLE_SHEETS_URL, orderDataWithDelhivery, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000, // 30 second timeout
        });
        console.log('✅ COD order saved to Google Sheets');
      } else {
        console.warn('⚠️ GOOGLE_SHEETS_URL not configured, skipping sheet save');
      }
    } catch (sheetError) {
      console.error('❌ Google Sheets error:', sheetError.message);
      // Continue even if sheets save fails
    }

    // Return success
    return res.json({
      success: true,
      orderId: orderData.orderId,
      delhivery: delhiveryResponse,
      message: 'COD order processed successfully',
    });
  } catch (error) {
    console.error('❌ Error processing COD order:', error);
    console.error('Stack:', error.stack);

    return res.status(500).json({
      success: false,
      message: 'Failed to process COD order',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/checkout/process-prepaid
 * Process prepaid order after payment verification
 */
router.post('/process-prepaid', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required',
      });
    }

    const { orderData, shipmentData, pickupLocation, paymentDetails } = req.body;

    // Validate required fields
    if (!orderData || !orderData.orderId) {
      return res.status(400).json({
        success: false,
        message: 'Order data with orderId is required',
      });
    }

    if (!shipmentData) {
      return res.status(400).json({
        success: false,
        message: 'Shipment data is required',
      });
    }

    if (!paymentDetails) {
      return res.status(400).json({
        success: false,
        message: 'Payment details are required for prepaid orders',
      });
    }

    console.log('Processing Prepaid order:', orderData.orderId);

    // Step 1: Create Delhivery shipment (after payment is verified)
    let delhiveryResponse = null;
    try {
      if (!process.env.DELHIVERY_API_KEY) {
        throw new Error('DELHIVERY_API_KEY not configured');
      }

      const payload = { shipments: [shipmentData], pickup_location: pickupLocation || {} };
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
          timeout: 20000, // 20 second timeout
        }
      );

      delhiveryResponse = delhiveryRes.data;
      console.log('✅ Delhivery shipment created for Prepaid order');
    } catch (delhiveryError) {
      console.error('❌ Delhivery error (continuing):', delhiveryError.response?.data || delhiveryError.message);
      delhiveryResponse = {
        success: false,
        error: delhiveryError.message,
        details: delhiveryError.response?.data || null,
      };
    }

    // Step 2: Save order to Google Sheets
    const orderDataWithDetails = {
      ...orderData,
      paymentId: paymentDetails.payment_id || paymentDetails.id || '',
      delhiveryResponse: JSON.stringify(delhiveryResponse || {}),
    };

    try {
      if (GOOGLE_SHEETS_URL) {
        await axios.post(GOOGLE_SHEETS_URL, orderDataWithDetails, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000, // 30 second timeout
        });
        console.log('✅ Prepaid order saved to Google Sheets');
      } else {
        console.warn('⚠️ GOOGLE_SHEETS_URL not configured, skipping sheet save');
      }
    } catch (sheetError) {
      console.error('❌ Google Sheets error:', sheetError.message);
      // Continue even if sheets save fails
    }

    // Return success
    return res.json({
      success: true,
      orderId: orderData.orderId,
      delhivery: delhiveryResponse,
      payment: paymentDetails,
      message: 'Prepaid order processed successfully',
    });
  } catch (error) {
    console.error('❌ Error processing Prepaid order:', error);
    console.error('Stack:', error.stack);

    return res.status(500).json({
      success: false,
      message: 'Failed to process Prepaid order',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
    });
  }
});

export default router;
