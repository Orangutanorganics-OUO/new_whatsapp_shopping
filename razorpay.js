import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';

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
 * Create a Razorpay order
 */
router.post('/create-order', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required',
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

    const { amount, currency = 'INR', receipt } = req.body;

    // Validation
    if (!amount) {
      return res.status(400).json({
        success: false,
        message: 'Amount is required',
      });
    }

    // Validate amount is a number
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive number',
      });
    }

    if (amountNum < 100) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be at least ₹1 (100 paise)',
      });
    }

    // Validate currency
    const validCurrencies = ['INR', 'USD', 'EUR', 'GBP'];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid currency. Supported: INR, USD, EUR, GBP',
      });
    }

    const options = {
      amount: Math.round(amountNum), // amount in paise
      currency,
      receipt: receipt || `order_${Date.now()}`,
      payment_capture: 1, // Auto capture
    };

    console.log('Creating Razorpay order:', options);

    const order = await razorpay.orders.create(options);

    console.log('✅ Razorpay order created:', order.id);

    return res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      },
      key_id: process.env.RAZORPAY_KEY_ID, // Send key_id for frontend
    });
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
 * Verify Razorpay payment signature
 */
router.post('/verify-payment', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required',
      });
    }

    // Check if Razorpay is initialized
    if (!razorpay || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('❌ Razorpay not configured properly');
      return res.status(503).json({
        success: false,
        message: 'Payment service not configured',
      });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Validation
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required payment parameters: razorpay_order_id, razorpay_payment_id, razorpay_signature',
      });
    }

    // Validate format of IDs
    if (typeof razorpay_order_id !== 'string' || typeof razorpay_payment_id !== 'string' || typeof razorpay_signature !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Invalid parameter types',
      });
    }

    // Generate signature
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest('hex');

    // Verify signature using constant-time comparison
    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSign),
      Buffer.from(razorpay_signature)
    );

    if (isValid) {
      console.log('✅ Payment verified successfully:', {
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id,
      });

      // Fetch payment details
      try {
        const payment = await razorpay.payments.fetch(razorpay_payment_id);

        return res.json({
          success: true,
          verified: true,
          payment: {
            id: payment.id,
            order_id: payment.order_id,
            amount: payment.amount,
            currency: payment.currency,
            status: payment.status,
            method: payment.method,
            email: payment.email,
            contact: payment.contact,
            created_at: payment.created_at,
          },
        });
      } catch (fetchError) {
        console.warn("⚠️ Payment verified but couldn't fetch details:", fetchError.message);

        // Still return success because signature was valid
        return res.json({
          success: true,
          verified: true,
          payment: {
            id: razorpay_payment_id,
            order_id: razorpay_order_id,
          },
        });
      }
    } else {
      console.error('❌ Payment verification failed: Invalid signature');
      console.error('Expected:', expectedSign);
      console.error('Received:', razorpay_signature);

      return res.status(400).json({
        success: false,
        verified: false,
        message: 'Invalid payment signature',
      });
    }
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

export default router;
