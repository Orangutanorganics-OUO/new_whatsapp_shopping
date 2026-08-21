import express from 'express';
import axios from 'axios';

const router = express.Router();

const DELHIVERY_BASE_URL = 'https://track.delhivery.com/api';
const DELHIVERY_API_KEY = process.env.DELHIVERY_API_KEY;
const DELHIVERY_ORIGIN_PIN = process.env.DELHIVERY_ORIGIN_PIN || '110042';

// Validate environment variables
if (!DELHIVERY_API_KEY) {
  console.warn('⚠️ DELHIVERY_API_KEY not configured. Delhivery routes will fail.');
}

if (!process.env.DELHIVERY_ORIGIN_PIN) {
  console.warn('⚠️ DELHIVERY_ORIGIN_PIN not set, using default: 110042');
}

/**
 * POST /api/delhivery/calculate-shipping
 * Calculate shipping charges
 */
router.post('/calculate-shipping', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required',
      });
    }

    const { pincode, weight, paymentMode } = req.body;

    // Validation
    if (!pincode || !weight) {
      return res.status(400).json({
        success: false,
        message: 'Pincode and weight are required',
      });
    }

    // Validate pincode format
    const pincodeStr = String(pincode).trim();
    if (!/^\d{6}$/.test(pincodeStr)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pincode. Must be 6 digits',
      });
    }

    // Validate weight
    const weightNum = Number(weight);
    if (isNaN(weightNum) || weightNum <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid weight. Must be a positive number',
      });
    }

    // Check if API key is configured
    if (!DELHIVERY_API_KEY) {
      console.error('❌ DELHIVERY_API_KEY not configured');
      // Return fallback calculation
      const fallbackCharge = Math.round((weightNum / 1000) * 50 + 40);
      return res.json({
        success: true,
        shippingCharge: fallbackCharge,
        fallback: true,
        message: 'Using fallback calculation (API not configured)',
      });
    }

    const paymentType = paymentMode === 'cod' ? 'COD' : 'Pre-paid';

    const params = {
      md: 'S', // Mode: Surface
      ss: 'Delivered',
      d_pin: pincodeStr,
      o_pin: DELHIVERY_ORIGIN_PIN,
      cgm: Math.round(weightNum), // weight in grams
      pt: paymentType,
    };

    console.log('Calculating shipping for:', params);

    const response = await axios.get(`${DELHIVERY_BASE_URL}/kinko/v1/invoice/charges/.json`, {
      headers: {
        Authorization: `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      params,
      timeout: 15000, // 15 second timeout
    });

    if (response.data && response.data[0]?.total_amount) {
      const shippingCost = Math.round(response.data[0].total_amount);
      return res.json({
        success: true,
        shippingCharge: shippingCost,
        data: response.data[0],
      });
    } else {
      // Fallback calculation
      const fallbackCharge = Math.round((weightNum / 1000) * 50 + 40);
      console.warn('⚠️ Unexpected Delhivery response format, using fallback');
      return res.json({
        success: true,
        shippingCharge: fallbackCharge,
        fallback: true,
        message: 'Using fallback calculation',
      });
    }
  } catch (error) {
    console.error('❌ Delhivery shipping calculation error:', error.response?.data || error.message);

    // Return fallback on error
    const weight = req.body.weight || 1000;
    const fallbackCharge = Math.round((Number(weight) / 1000) * 50 + 40);

    // Don't return error status - return success with fallback
    return res.json({
      success: true,
      shippingCharge: fallbackCharge,
      fallback: true,
      message: 'Using fallback calculation due to API error',
    });
  }
});

/**
 * POST /api/delhivery/create-shipment
 * Create a new shipment
 */
router.post('/create-shipment', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required',
      });
    }

    const { shipmentData, pickupLocation } = req.body;

    // Validation
    if (!shipmentData || !pickupLocation) {
      return res.status(400).json({
        success: false,
        message: 'Shipment data and pickup location are required',
      });
    }

    // Check if API key is configured
    if (!DELHIVERY_API_KEY) {
      console.error('❌ DELHIVERY_API_KEY not configured');
      return res.status(503).json({
        success: false,
        message: 'Delhivery service not configured',
      });
    }

    // Validate required fields
    const requiredFields = ['name', 'add', 'pin', 'phone', 'order', 'payment_mode', 'total_amount'];
    const missingFields = requiredFields.filter(field => !shipmentData[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
      });
    }

    // Validate pincode format
    const pinStr = String(shipmentData.pin).trim();
    if (!/^\d{6}$/.test(pinStr)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pincode format. Must be 6 digits',
      });
    }

    // Validate phone format (10 digits)
    const phoneStr = String(shipmentData.phone).replace(/\D/g, '');
    if (phoneStr.length !== 10) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Must be 10 digits',
      });
    }

    const payload = {
      shipments: [shipmentData],
      pickup_location: pickupLocation,
    };

    const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

    console.log('Creating Delhivery shipment for order:', shipmentData.order);

    const response = await axios.post(`${DELHIVERY_BASE_URL}/cmu/create.json`, bodyStr, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 20000, // 20 second timeout
    });

    console.log('✅ Delhivery shipment created successfully');

    return res.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error('❌ Delhivery shipment creation error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });

    return res.status(error.response?.status || 500).json({
      success: false,
      message: 'Failed to create shipment',
      error: process.env.NODE_ENV === 'development'
        ? (error.response?.data || error.message)
        : 'Internal server error',
    });
  }
});

export default router;
