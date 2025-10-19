import express from 'express';
import axios from 'axios';

const router = express.Router();

const DELHIVERY_BASE_URL = 'https://track.delhivery.com/api';
const DELHIVERY_API_KEY = process.env.DELHIVERY_API_KEY;
const DELHIVERY_ORIGIN_PIN = process.env.DELHIVERY_ORIGIN_PIN;

/**
 * POST /api/delhivery/calculate-shipping
 * Calculate shipping charges
 */
router.post('/calculate-shipping', async (req, res) => {
  try {
    const { pincode, weight, paymentMode } = req.body;

    // Validation
    if (!pincode || !weight) {
      return res.status(400).json({
        success: false,
        message: 'Pincode and weight are required',
      });
    }

    if (pincode.length !== 6) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pincode. Must be 6 digits',
      });
    }

    const paymentType = paymentMode === 'cod' ? 'COD' : 'Pre-paid';

    const params = {
      md: 'S', // Mode: Surface
      ss: 'Delivered',
      d_pin: pincode,
      o_pin: DELHIVERY_ORIGIN_PIN,
      cgm: weight, // weight in grams
      pt: paymentType,
    };

    console.log('Calculating shipping for:', params);

    const response = await axios.get(`${DELHIVERY_BASE_URL}/kinko/v1/invoice/charges/.json`, {
      headers: {
        Authorization: `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      params,
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
      const fallbackCharge = Math.round((weight / 1000) * 50 + 40);
      return res.json({
        success: true,
        shippingCharge: fallbackCharge,
        fallback: true,
        message: 'Using fallback calculation',
      });
    }
  } catch (error) {
    console.error('Delhivery shipping calculation error:', error.response?.data || error.message);

    // Return fallback on error
    const weight = req.body.weight || 1000;
    const fallbackCharge = Math.round((weight / 1000) * 50 + 40);

    res.json({
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
    const { shipmentData, pickupLocation } = req.body;

    // Validation
    if (!shipmentData || !pickupLocation) {
      return res.status(400).json({
        success: false,
        message: 'Shipment data and pickup location are required',
      });
    }

    // Validate required fields
    const requiredFields = ['name', 'add', 'pin', 'phone', 'order', 'payment_mode', 'total_amount'];
    for (const field of requiredFields) {
      if (!shipmentData[field]) {
        return res.status(400).json({
          success: false,
          message: `Missing required field: ${field}`,
        });
      }
    }

    const payload = {
      shipments: [shipmentData],
      pickup_location: pickupLocation,
    };

    const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

    console.log('Creating Delhivery shipment:', payload);

    const response = await axios.post(`${DELHIVERY_BASE_URL}/cmu/create.json`, bodyStr, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    console.log('Delhivery shipment response:', response.data);

    return res.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error('Delhivery shipment creation error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });

    return res.status(error.response?.status || 500).json({
      success: false,
      message: 'Failed to create shipment',
      error: error.response?.data || error.message,
    });
  }
});

export default router;
