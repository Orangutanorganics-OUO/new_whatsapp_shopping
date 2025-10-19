const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/**
 * POST /api/razorpay/create-order
 * Create a Razorpay order
 */
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', receipt } = req.body;

    // Validation
    if (!amount) {
      return res.status(400).json({
        success: false,
        message: 'Amount is required'
      });
    }

    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be at least ₹1 (100 paise)'
      });
    }

    const options = {
      amount: Math.round(amount), // amount in paise
      currency: currency,
      receipt: receipt || `order_${Date.now()}`,
      payment_capture: 1 // Auto capture
    };

    console.log('Creating Razorpay order:', options);

    const order = await razorpay.orders.create(options);

    console.log('Razorpay order created:', order);

    return res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt
      },
      key_id: process.env.RAZORPAY_KEY_ID // Send key_id for frontend
    });

  } catch (error) {
    console.error('Razorpay order creation error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to create Razorpay order',
      error: error.message
    });
  }
});

/**
 * POST /api/razorpay/verify-payment
 * Verify Razorpay payment signature
 */
router.post('/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    // Validation
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required payment parameters'
      });
    }

    // Generate signature
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest('hex');

    // Verify signature
    if (expectedSign === razorpay_signature) {
      console.log('Payment verified successfully:', {
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id
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
            created_at: payment.created_at
          }
        });
      } catch (fetchError) {
        // Signature is valid but couldn't fetch details
        console.warn('Payment verified but couldn\'t fetch details:', fetchError);

        return res.json({
          success: true,
          verified: true,
          payment: {
            id: razorpay_payment_id,
            order_id: razorpay_order_id
          }
        });
      }
    } else {
      console.error('Payment verification failed: Invalid signature');

      return res.status(400).json({
        success: false,
        verified: false,
        message: 'Invalid payment signature'
      });
    }

  } catch (error) {
    console.error('Payment verification error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: error.message
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

    const payment = await razorpay.payments.fetch(paymentId);

    return res.json({
      success: true,
      payment
    });

  } catch (error) {
    console.error('Error fetching payment:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payment details',
      error: error.message
    });
  }
});

module.exports = router;
