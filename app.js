// server-whatsapp-payments.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import ShortUniqueId from 'short-unique-id';
import cors from 'cors';

import helmet from 'helmet';
import morgan from 'morgan';
import bodyParser from 'body-parser';

import delhiveryRoutes from './delhivery.js';
import razorpayRoutes from './razorpay.js';
import checkoutRoutes from './checkout.js';

// Firebase Realtime Database
import {
  isMessageProcessed,
  markMessageAsProcessed,
  isPaymentProcessed,
  markPaymentAsProcessed,
  acquireOrderLock,
  saveOrderSession,
  getOrderSession,
  cleanupOldData
} from './firebase.js';

// ============================================
// GLOBAL ERROR HANDLERS (Prevent Server Crash)
// ============================================

// Handle uncaught exceptions (synchronous errors)
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION! Server is still running...');
  console.error('Error:', err.name, err.message);
  console.error('Stack:', err.stack);
  // Don't exit the process - keep server running
});

// Handle unhandled promise rejections (async errors)
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION! Server is still running...');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  // Don't exit the process - keep server running
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

// Handle SIGINT gracefully (Ctrl+C)
process.on('SIGINT', () => {
  console.log('👋 SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

const app = express();

// ============================================
// RATE LIMITING (In-Memory)
// ============================================
const requestCounts = new Map(); // IP => { count, resetTime }

// Simple rate limiter middleware
const rateLimiter = (maxRequests = 100, windowMs = 60000) => {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    // Get or create request record for this IP
    let record = requestCounts.get(ip);

    if (!record || now > record.resetTime) {
      // New window or expired window - reset
      record = {
        count: 1,
        resetTime: now + windowMs
      };
      requestCounts.set(ip, record);
      return next();
    }

    // Increment count
    record.count++;

    if (record.count > maxRequests) {
      console.warn(`⚠️ Rate limit exceeded for IP: ${ip} (${record.count} requests)`);
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((record.resetTime - now) / 1000) + ' seconds'
      });
    }

    next();
  };
};

// Cleanup old rate limit records every 10 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [ip, record] of requestCounts.entries()) {
    if (now > record.resetTime + 60000) { // Cleanup records 1 minute after expiry
      requestCounts.delete(ip);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired rate limit records`);
  }
}, 10 * 60 * 1000);

// ============================================
// MIDDLEWARE CONFIGURATION
// ============================================

// capture raw body for webhook signature verification if needed
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(morgan('combined')); // Logging
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// CORS Configuration - Allow both production and localhost (for testing)
const allowedOrigins = [
  'https://orangutanorganics.com',
  'https://www.orangutanorganics.com',
  'http://localhost:3000',
  'http://localhost:3001'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS blocked request from: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Apply rate limiting to all routes (100 requests per minute per IP)
app.use(rateLimiter(100, 60000));


app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Orangutan Organics API Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API Routes
app.use('/api/delhivery', delhiveryRoutes);
app.use('/api/razorpay', razorpayRoutes);
app.use('/api/checkout', checkoutRoutes);




// --- ENV ---
const {
  PORT = 3000,
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  PAYMENT_CONFIGURATION_NAME, // NEW - set this to the "name" you created in Meta (e.g. upi_test)
  FLOW_ID,
  DELHIVERY_TOKEN,
  DELHIVERY_ORIGIN_PIN = '110042',
  DELHIVERY_CHARGES_URL = 'https://track.delhivery.com/api/kinko/v1/invoice/charges/.json',
  DELHIVERY_CREATE_URL = 'https://track.delhivery.com/api/cmu/create.json',

  // Optional: provider/BSP-based payment lookup (set this if your BSP provides a REST lookup)
  PAYMENTS_LOOKUP_BASE_URL,
  PAYMENTS_LOOKUP_API_KEY
} = process.env;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const APP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxQ7weoRaky32T-dT3kazdBd-axrzG2lPF4x9W_REmIfjCE9PUYEZbm9hO4M9h3QPdvBg/exec"

// ============================================
// ENVIRONMENT VARIABLE VALIDATION
// ============================================
const requiredEnvVars = ['VERIFY_TOKEN', 'ACCESS_TOKEN', 'PHONE_NUMBER_ID', 'FLOW_ID', 'DELHIVERY_TOKEN'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ CRITICAL: Missing required environment variables:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('⚠️  Server will continue but some features may not work!');
}


let intentBasedQA = new Map(); // Store Q&A with intents separately

function parseIntentBasedQA() {
  intentBasedQA.clear();

  intentBasedQA.set('buy now', {
    answer: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347`,
    intents: ['View Products', "Customer Reviews"]
  });
}

// Initialize intent-based Q&A
parseIntentBasedQA();

async function sendWhyPeopleLoveUs(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We're glad you're curious!💚
Here’s why our community loves Orang Utan Organics 👇
\nPick what you’d like to explore:`
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "nutrition_info",
                  title: "Nutrition info"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "farmer_impact",
                  title: "Farmer Impact"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "main_menu",
                  title: "Main Menu"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendwherewe(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We’re rooted in Village Bhangeli, 2300m above sea level, in the Gangotri Valley 🏞\n🌱 Certified Organic Base\n📍 46 km from Uttarkashi, Uttarakhand\n💚 Home to just 40 small landholder families we support\n\nWould you like to see what life looks like up here?\nView Gallery: https://www.instagram.com/orangutan.organics/`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_101",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_101",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendmatters(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We protect:\n• Native seeds & biodiversity\n• Water sources & soil health\n• Farmer dignity & livelihoods\nBuying from us = standing up for the planet & Himalayan farmers. Learn about our latest impact project? See Report: https://orangutanorganics.com/why-it-matters`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_102",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_102",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendhowitworks(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We are tracing our products from our Himalayan farm to your plate with just a QR code, launching soon. We’ll notify you when it’s live!`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_103",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_103",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendtraceprod(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Every product is traceable🔁 From seed-to-shelf, you’ll know:\n• The exact farm\n• The harvest date\n• The batch testing results\nWant to trace your future order?\nSee how it works: https://orangutanorganics.com/who-are-we/traceability`,
          },
          action: {
            buttons: [
              
              {
                type: "reply",
                reply: {
                  id: "works_101",
                  title: "How It Works"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "prod_102",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "story_102",
                  title: "Back2 Sourcing Story"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendshopandexplore(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347 \n\nWe are also available on Amazon.`,
          },
          action: {
            buttons: [
              
              {
                type: "reply",
                reply: {
                  id: "prod_1001",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "review_1001",
                  title: "Customer Reviews"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "main_men_101",
                  title: "Main Menu"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}


async function sendcustreview(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Don’t just take our word for it 💬\nHere’s what conscious buyers like you are saying 👇\nWebsite and amazon review: https://orangutanorganics.com/products \n\nInstagram love: https://www.instagram.com/p/DOIOa4rkv5C/`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "prod_105",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "stop_102",
                  title: "Back2 Shop & Explore"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}


async function sendrecipes(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `Explore farm-fresh, nutritious recipes from our chef community:\n🥄 Red Rajma Curry with Tempering Spice\n🥄 Soyabean Stir-Fry\n🥄 Ghee-roasted Red Rice\nGet one sent to you now? View Recipe: https://orangutanorganics.com/who-are-we/recipes`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "view_products",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "back_nutri",
                  title: "back 2 nutri info"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendfarmerimpact(to) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `We directly reinvest in:\n• Soil conservation 🌍\n• Enhancing livelihoods via our farmers consortium 📘\n• Organic certifications for villages 🧾\nSee our Farmer’s Impact : https://orangutanorganics.com/who-are-we/farmer-impact`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "view_products",
                  title: "View Products"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "back_ppl_love_us",
                  title: "back 2 y ppl <3 us"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent "Why People Love Us" quick reply message to ${to}`);
  } catch (err) {
    console.error(
      "sendWhyPeopleLoveUs error:",
      err.response?.data || err.message || err
    );
  }
}

async function sendWhatsAppTrackingCTA(to, awb) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: {
          text: "Here is your Tracking link to check the status of your order 🚚",
        },
        action: {
          name: "cta_url",
          parameters: {
            display_text: "Track Your Order",
            url: `https://www.delhivery.com/track-v2/package/${awb}`,
          },
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log(`✅ Tracking CTA sent to ${to} for AWB ${awb}`);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppTrackingCTA error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppInteractiveMessage(to, body, buttons) {
  const formattedButtons = buttons.map((btn, index) => ({
    type: 'reply',
    reply: {
      id: `btn_${index}_${btn.id}`,
      title: btn.title
    }
  }));

  return axios({
    method: 'POST',
    url: `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    data: {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: body
        },
        action: {
          buttons: formattedButtons
        }
      }
    },
  });
}

function findIntentBasedResponse(userMessage) {
  const normalizedMessage = userMessage.toLowerCase().trim();
  
  // Direct matches
  if (intentBasedQA.has(normalizedMessage)) {
    return intentBasedQA.get(normalizedMessage);
  }
  
  // Partial matches for flexibility
  for (let [key, value] of intentBasedQA.entries()) {
    if (normalizedMessage.includes(key) || key.includes(normalizedMessage)) {
      return value;
    }
  }
  
  // Check for trace-related keywords
  if (normalizedMessage.includes('trace') || normalizedMessage.includes('track') || 
      normalizedMessage.includes('origin') || normalizedMessage.includes('source')) {
    return intentBasedQA.get('trace your products');
  }
  
  return null;
}

if (!PAYMENT_CONFIGURATION_NAME) {
  console.warn('Warning: PAYMENT_CONFIGURATION_NAME not set. The order_details message requires the exact payment configuration name from Meta.');
}

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// --- STATE STORE ---
const orderSessions = {};        // orderId => session
const phoneToOrderIds = {};      // phone => [orderId,...]
const idleTimers = {};
const remindedUsers = new Set();
// NOTE: processedMessages and processedPayments now stored in Firebase for reliability
const completedUsers = new Set();
const resolvedUsers = new Set();

// ============================================
// MEMORY CLEANUP (Prevent Memory Leaks)
// ============================================

// Cleanup old sessions, payments, and state (runs every hour)
setInterval(async () => {
  const now = Date.now();
  const sessionExpiryTime = 24 * 60 * 60 * 1000; // 24 hours
  let cleanupStats = {
    sessions: 0,
    timers: 0,
    phoneMapping: 0
  };

  // 1. Cleanup Firebase data (messages, payments, locks)
  try {
    await cleanupOldData();
  } catch (err) {
    console.error('❌ Firebase cleanup failed:', err);
  }

  // 2. Cleanup old/completed order sessions
  for (const [orderId, session] of Object.entries(orderSessions)) {
    const sessionAge = now - (session.createdAt || session.timestamp || 0);
    const shouldCleanup =
      (session.finalized && sessionAge > sessionExpiryTime) || // Finalized sessions older than 24h
      (!session.finalized && sessionAge > 2 * sessionExpiryTime) || // Abandoned sessions older than 48h
      session.payment_status === 'completed' || // Completed payments
      session.payment_status === 'failed'; // Failed payments

    if (shouldCleanup) {
      delete orderSessions[orderId];
      cleanupStats.sessions++;
    }
  }

  // 3. Cleanup idle timers for removed sessions
  for (const orderId of Object.keys(idleTimers)) {
    if (!orderSessions[orderId]) {
      clearTimeout(idleTimers[orderId]);
      delete idleTimers[orderId];
      cleanupStats.timers++;
    }
  }

  // 4. Cleanup phone-to-order mappings for removed sessions
  for (const [phone, orderIds] of Object.entries(phoneToOrderIds)) {
    const validOrderIds = orderIds.filter(orderId => orderSessions[orderId]);
    if (validOrderIds.length === 0) {
      delete phoneToOrderIds[phone];
      cleanupStats.phoneMapping++;
    } else if (validOrderIds.length < orderIds.length) {
      phoneToOrderIds[phone] = validOrderIds;
    }
  }

  // 5. Cleanup old processed messages (older than 10 minutes)
  const messageExpiryTime = 10 * 60 * 1000; // 10 minutes
  for (const [messageId, timestamp] of processedMessages.entries()) {
    if (now - timestamp > messageExpiryTime) {
      processedMessages.delete(messageId);
      cleanupStats.messages = (cleanupStats.messages || 0) + 1;
    }
  }

  // Log cleanup stats if anything was cleaned
  const totalCleaned = Object.values(cleanupStats).reduce((a, b) => a + b, 0);
  if (totalCleaned > 0) {
    console.log(`🧹 Cleanup: ${cleanupStats.sessions} sessions, ${cleanupStats.payments} payments, ${cleanupStats.timers} timers, ${cleanupStats.phoneMapping} phone mappings`);
  }
}, 60 * 60 * 1000); // Run cleanup every hour

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Normalize and validate phone number
 * @param {string} phone - Phone number to normalize
 * @returns {string} - Normalized phone number (digits only)
 */
function normalizePhone(phone) {
  if (!phone) return '';

  // Remove all non-digit characters
  const normalized = (phone || '').replace(/\D/g, '');

  // Validate phone number length (10 digits for India)
  if (normalized.length > 0 && normalized.length !== 10 && normalized.length !== 12) {
    console.warn(`⚠️ Unusual phone number length: ${normalized.length} digits`);
  }

  return normalized;
}

/**
 * Sanitize user input to prevent XSS and injection attacks
 * @param {string} input - User input to sanitize
 * @returns {string} - Sanitized input
 */
function sanitizeInput(input) {
  if (!input || typeof input !== 'string') return '';

  return input
    .replace(/[<>]/g, '') // Remove HTML tags
    .replace(/[&]/g, '&amp;') // Escape ampersand
    .replace(/["']/g, '') // Remove quotes
    .trim()
    .slice(0, 1000); // Limit length to prevent DoS
}

/**
 * Verify WhatsApp webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - X-Hub-Signature-256 header value
 * @returns {boolean} - True if signature is valid
 */
function verifyWhatsAppSignature(payload, signature) {
  if (!signature || !payload) {
    console.warn('⚠️ Missing signature or payload for webhook verification');
    return false;
  }

  // Meta sends signature as "sha256=<hash>"
  if (!signature.startsWith('sha256=')) {
    console.warn('⚠️ Invalid signature format');
    return false;
  }

  // If APP_SECRET is not configured, skip verification (log warning)
  if (!process.env.APP_SECRET) {
    console.warn('⚠️ APP_SECRET not configured. Webhook signature verification is disabled. Add APP_SECRET to .env for production security.');
    return true; // Allow webhook but log warning
  }

  try {
    // Calculate expected signature
    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', process.env.APP_SECRET)
      .update(payload)
      .digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    console.error('❌ Error verifying webhook signature:', error.message);
    return false;
  }
}

async function sendWhatsAppText(to, text) {
  // Validate inputs
  if (!to) {
    console.warn(`⚠️ Cannot send message: recipient phone number is missing`);
    return false;
  }

  if (!text || text.trim() === '') {
    console.warn(`⚠️ Attempted to send empty message to ${to}`);
    return false;
  }

  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error(`❌ Cannot send message: ACCESS_TOKEN or PHONE_NUMBER_ID not configured`);
    return false;
  }

  try {
    await axios.post(GRAPH_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 10000 // 10 second timeout
    });
    console.log(`✅ Message sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ Error sending message to ${to}:`, err.response?.data || err.message || err);
    // Don't throw - just log and return false to prevent server crash
    return false;
  }
}

async function sendWhatsAppTemplate(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "have_a_query", // 👈 your approved template name
        language: { code: "en" }, // 👈 language code
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log(`✅ Template "have_a_query" sent to ${to}`);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppTemplate error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppList(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "Namaste from Orang Utan Organics 🌱",
        },
        body: {
          text: `Perched at 2,300 mtr in the Gangotri Valley, we are here to share the true taste of the Himalayas. \nHow can we brighten your day?`,
        },
        action: {
          button: "Options",
          sections: [
            {
              rows: [
                 { id: "1001", title: "Shop & Explore" },
                { id: "1002", title: "Why People Love Us" },
                { id: "1004", title: "Track Your Order" },
                { id: "1005", title: "Have A Query" },
              ],
            },
          ],
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log("✅ WhatsApp list message sent successfully:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppList error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppList_ss(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "",
        },
        body: {
          text: "Every purchase helps a real Himalayan farmer.\n✅ Small landholder support\n✅ Gangotri Valley & high altitude-based collective\n✅ Traceable from farm to pack\nWant to see how your food travels from seed to shelf? Track Origin: https://orangutanorganics.com/who-are-we/traceability",
        },
        action: {
          button: "Options",
          sections: [
            {
              rows: [
                { id: "priority_express_1", title: "Where we’re from" },
                { id: "priority_mail_2", title: "Why It Matters" },
                { id: "fgh_3", title: "Trace Your Products" },
                { id: "er_5", title: "Main Menu" },
                // { id: "cv", title: "Have A Query" },
              ],
            },
          ],
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log("✅ WhatsApp list message sent successfully:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppList error:", err.response?.data || err.message || err);
  }
}

async function sendWhatsAppList_ni(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "",
        },
        body: {
          text: "Our products are:\n• 100% Himalayan grown & natural\n• NABL Lab-Tested for purity & nutrients\n• Rich in Iron, Fiber, and Antioxidants 🌾\nHere is Nutrition Info Table: https://orangutanorganics.com/nutrition",
        },
        action: {
          button: "Options",
          sections: [
            {
              rows: [
                { id: "priority_express_1_1", title: "Recipes" },
                { id: "priority_mail_2_1", title: "Sourcing Story" },
                { id: "fgh_31", title: "View Products" },
                { id: "er_51", title: "back 2 y ppl <3 us" },
                // { id: "cv", title: "Have A Query" },
              ],
            },
          ],
        },
      },
    };

    const response = await axios.post(GRAPH_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    console.log("✅ WhatsApp list message sent successfully:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ sendWhatsAppList error:", err.response?.data || err.message || err);
  }
}




async function sendWhatsAppCatalog(to) {
  try {
    // 1️⃣ Send the catalog message
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "product_list",
          header: { type: "text", text: "Featured Products 🌟" },
          body: { text: "Browse our catalog and pick your favorites 🌱" },
          footer: { text: "OrangUtan Organics" },
          action: {
            catalog_id: "1262132998945503",
            sections: [
              {
                title: "Our Products",
                product_items: [
                  { product_retailer_id: "43mypu8dye" },
                  { product_retailer_id: "l722c63kq9" },
                  { product_retailer_id: "kkii6r9uvh" },
                  { product_retailer_id: "m519x5gv9s" },
                  { product_retailer_id: "294l11gpcm" },
                  { product_retailer_id: "ezg1lu6edm" },
                  { product_retailer_id: "tzz72lpzz2" },
                  { product_retailer_id: "esltl7pftq" },
                  { product_retailer_id: "obdqyehm1w" },
                  { product_retailer_id: "5diu7mcmbf" },
                  { product_retailer_id: "324pmzr4c9" }
                ]
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    // 🕐 Optional: small delay to ensure order
    await new Promise((res) => setTimeout(res, 100));

    // 2️⃣ Send the "Main Menu" quick reply button
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          header: {
          type: "text",
          text: "OR",
        },
          body: {
            text: "Would you like to return to the Main Menu?"
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "main_menu",
                  title: "Main Menu"
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Sent catalog + Main Menu button to ${to}`);
  } catch (err) {
    console.error(
      "sendWhatsAppCatalog error",
      err.response?.data || err.message || err
    );
  }
}







async function sendWhatsAppFlow(to, flowId, flowToken = null) {
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "Fill Delivery Details" },
      body: { text: "Please tap below to provide your info securely." },
      footer: { text: "OrangUtan Organics" },
      action: {
        name: "flow",
        parameters: {
          flow_id: flowId,
          flow_message_version: "3",
          flow_cta: "Enter Details"
        }
      }
    }
  };
  if (flowToken) data.interactive.action.parameters.flow_token = flowToken;
  try {
    await axios.post(GRAPH_URL, data, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
  } catch (err) {
    console.error('sendWhatsAppFlow error', err.response?.data || err.message || err);
  }
}

// --- App Script Integration ---
async function sendOrderToAppScript(orderData) {
  if (!APP_SCRIPT_URL) {
    console.warn('⚠️ APP_SCRIPT_URL not configured. Skipping order submission to Google Sheets.');
    return null;
  }

  // Validate orderData
  if (!orderData || !orderData.orderId) {
    console.error('❌ Invalid order data: orderId is required');
    return null;
  }

  try {
    // Format products for App Script with safety checks
    const products = (orderData.productItems || []).map(item => ({
      name: getProductName[item.product_retailer_id] || item.name || 'Item',
      size: `${getProductWeight[item.product_retailer_id] || 0}gm`,
      quantity: parseInt(item.quantity, 10) || 1,
      price: parseFloat(item.item_price || item.price || 0)
    }));

    const payload = {
      type: 'checkout',
      orderId: orderData.orderId || '',
      timestamp: orderData.timestamp || new Date().toISOString(),
      name: orderData.name || '',
      email: orderData.email || '',
      phone: orderData.phone || '',
      address: orderData.address || '',
      pincode: orderData.pincode || '',
      city: orderData.city || '',
      state: orderData.state || '',
      products: products,
      paymentMode: orderData.paymentMode || '',
      paymentStatus: orderData.paymentStatus || '',
      paymentId: orderData.paymentId || '',
      subtotal: parseFloat(orderData.subtotal || 0),
      shippingCharge: parseFloat(orderData.shippingCharge || 0),
      codCharge: parseFloat(orderData.codCharge || 0),
      discount: parseFloat(orderData.discount || 0),
      total: parseFloat(orderData.total || 0),
      delhiveryResponse: orderData.delhiveryResponse || ''
    };

    const res = await axios.post(APP_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000 // 30 second timeout for Google Sheets
    });

    console.log(`✅ Order sent to App Script - Order ID: ${orderData.orderId}`);
    return res.data;
  } catch (err) {
    console.error('❌ sendOrderToAppScript error:', err.response?.data || err.message || err);
    // Don't throw - just log and return null so order processing continues
    return null;
  }
}

// product metadata (as you had)
const getProductName =
  { "43mypu8dye":"Himalayan badri cow ghee 120gm" ,
    "l722c63kq9":"Himalayan badri cow ghee 295gm" ,
    "kkii6r9uvh":"Himalayan badri cow ghee 495gm" ,
    "m519x5gv9s":"Himalayan White Rajma 500gm" ,
    "294l11gpcm":"Himalayan White Rajma 1kg" ,
    "ezg1lu6edm":"Himalayan Red Rajma 500gm" ,
    "tzz72lpzz2":"Himalayan Red Rajma 1kg" ,
    "esltl7pftq":"Wild Himalayan Tempering Spice" ,
    "obdqyehm1w":"Himalayan Red Rice",
    "5diu7mcmbf":"Himalayan Black Soyabean 500gm",
    "324pmzr4c9":"Himalayan Black Soyabean 1kg"
  
  };

const getProductWeight =
  { "43mypu8dye":120 ,
    "l722c63kq9":295 ,
    "kkii6r9uvh":495 ,
    "m519x5gv9s":500 ,
    "294l11gpcm":1000 ,
    "ezg1lu6edm":500 ,
    "tzz72lpzz2":1000 ,
    "esltl7pftq":100 ,
    "obdqyehm1w":1000,
    "5diu7mcmbf":500,
    "324pmzr4c9":1000
  };

// ---------------- Coupon System ----------------
const COUPONS = {
  "OUO10": { discount: 0.10, description: "10% OFF" } // 10% discount
};

function validateCoupon(couponCode) {
  if (!couponCode || couponCode.trim() === '') {
    return null;
  }

  // Case-insensitive lookup
  const normalizedCode = couponCode.trim().toUpperCase();

  if (COUPONS[normalizedCode]) {
    return {
      code: normalizedCode,
      discount: COUPONS[normalizedCode].discount,
      description: COUPONS[normalizedCode].description
    };
  }

  return null;
}

// ---------------- NEW: send order_details (WhatsApp native payment) ----------------
async function sendWhatsAppOrderDetails(to, session) {
  if (!PAYMENT_CONFIGURATION_NAME) {
    console.error("Cannot send order_details: PAYMENT_CONFIGURATION_NAME not configured in env.");
    throw new Error("PAYMENT_CONFIGURATION_NAME missing");
  }

  // Build items for order_details; amounts must be integer * offset (offset=100 for INR)
  const items = (session.productItems || []).map((it) => {
    const retailer_id = it.product_retailer_id || it.retailer_id || it.id || '';
    const name = getProductName[retailer_id] || it.name || 'Item';
    // Prefer item.item_price if present (likely in catalog order payload), assume rupees -> convert to paise
    const unitPricePaise = Math.round((parseFloat(it.item_price || it.price || 0) || 0) * 100) || 0;
    const qty = parseInt(it.quantity || it.qty || it.quantity_ordered || 1, 10) || 1;
    const amountValue = unitPricePaise || Math.round((session.amount || 0) / Math.max(1, (session.productItems || []).length));
    return {
      retailer_id,
      name,
      amount: { value: amountValue, offset: 100 },
      quantity: qty
    };
  });

  // total amount (paise) is session.amount (we keep this convention)
  const prod_cost = session.amount || items.reduce((s, it) => s + (it.amount?.value || 0) * (it.quantity || 1), 0);
  let shippingChargePaise = 0;
  const product_data = session.productItems || [];
   let total_wgt = 0;
    for (let i = 0; i < product_data.length; i++) {
      const id = product_data[i].product_retailer_id;
      const q = parseInt(product_data[i].quantity, 10) || 1;
      total_wgt += ((getProductWeight[id] || 0) * q);
    }

    // Calculate bulk discount (20% off if weight >= 3000 grams)
    let bulkDiscountPaise = 0;
    if (total_wgt >= 3000) {
      bulkDiscountPaise = Math.round(prod_cost * 0.20);
    }

    // Apply coupon discount
    let couponDiscountPaise = 0;
    const couponData = validateCoupon(session.customer?.coupon);
    if (couponData) {
      // Apply coupon on the product cost (before bulk discount)
      couponDiscountPaise = Math.round(prod_cost * couponData.discount);
      session.coupon = couponData.code;
      session.couponDiscount = couponDiscountPaise;
    }

    // Total discount combines bulk + coupon
    const discountPaise = bulkDiscountPaise + couponDiscountPaise;

    try {
      const chargesResp = await getDelhiveryCharges({
        origin_pin: DELHIVERY_ORIGIN_PIN,
        dest_pin: session.customer?.pincode || session.customer?.pin || '',
        cgm: total_wgt,
        pt: 'Pre-paid'
      });
      if (chargesResp && Array.isArray(chargesResp) && chargesResp[0]?.total_amount) {
        shippingChargePaise = Math.round(chargesResp[0].total_amount * 100);
      } else if (chargesResp?.total_amount) {
        // sometimes partners return object
        shippingChargePaise = Math.round(chargesResp.total_amount * 100);
      } else {
        console.warn("Could not parse delhivery charges response:", chargesResp);
      }
    } catch (err) {
      console.warn('Error retrieving delhivery charges for prepaid', err.message || err);
    }

    // Calculate discounted amount for free shipping check and total
    const discountedAmount = prod_cost - discountPaise;

    // Set shipping charge to zero if order value (after discount) is greater than 1000 rupees
    if (discountedAmount > 1000 * 100) {
      shippingChargePaise = 0;
    }

    session.shipping_charge = shippingChargePaise;
    session.discount = discountPaise;
    session.amount = discountedAmount; // Update session amount with discounted value


    const totalAmountValue = discountedAmount + shippingChargePaise
  




  // Build order payload with discount if applicable
  const orderParams = {
    status: "pending",
    items,
    subtotal: { value: prod_cost, offset: 100 },
    tax: { value: 0, offset: 100 },
    shipping: { value: Math.round((session.shipping_charge || 0)), offset: 100 }
  };

  // Add discount field if any discount was applied
  if (discountPaise > 0) {
    let discountDescription = "";
    if (bulkDiscountPaise > 0 && couponDiscountPaise > 0) {
      discountDescription = `Bulk Discount (20% OFF) + Coupon ${couponData.code} (${couponData.description})`;
    } else if (bulkDiscountPaise > 0) {
      discountDescription = "Bulk Discount (20% OFF)";
    } else if (couponDiscountPaise > 0) {
      discountDescription = `Coupon ${couponData.code} (${couponData.description})`;
    }

    orderParams.discount = {
      value: discountPaise,
      offset: 100,
      description: discountDescription
    };
  }

  let bodyText = "Please review your order and complete the payment. NOTE: shipment cost is included";
  if (discountPaise > 0) {
    if (bulkDiscountPaise > 0 && couponDiscountPaise > 0) {
      bodyText = `🎉 Bulk Discount (20% OFF) + Coupon ${couponData.code} (${couponData.description}) applied! ` + bodyText;
    } else if (bulkDiscountPaise > 0) {
      bodyText = "🎉 Bulk Discount (20% OFF) applied! " + bodyText;
    } else if (couponDiscountPaise > 0) {
      bodyText = `🎉 Coupon ${couponData.code} (${couponData.description}) applied! ` + bodyText;
    }
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "order_details",
      header: { type: "text", text: `Order ${session.orderId}` },
      body: { text: bodyText },
      footer: { text: "OrangUtan Organics" },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: session.orderId,
          type: "physical-goods",
          currency: "INR",
          total_amount: { value: totalAmountValue, offset: 100 },
          payment_type: "payment_gateway:razorpay", // using UPI payment config; if using gateway use "payment_gateway:razorpay" etc.
          payment_configuration: PAYMENT_CONFIGURATION_NAME,
          order: orderParams
        }
      }
    }
  };

  try {
    const res = await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    return res.data;
  } catch (err) {
    console.error('sendWhatsAppOrderDetails error', err.response?.data || err.message || err);
    throw err;
  }
}

// ---------------- re-usable finalization of a paid order ----------------
async function finalizePaidOrder(session, paymentInfo = {}) {
  const phone = session.phone || '';
  session.payment_status = 'paid';
  try {
    let successMsg = "✅ Payment successful!";
    if (session.discount > 0) {
      successMsg += " 🎉 Discounts applied!";
    }
    successMsg += " Your order is confirmed.";
    await sendWhatsAppText(phone, successMsg);

    // compute shipping using Delhivery (same logic you used before)
    let shippingChargePaise = 0;
    const product_data = session.productItems || [];

    let total_wgt = 0;
    for (let i = 0; i < product_data.length; i++) {
      const id = product_data[i].product_retailer_id;
      const q = parseInt(product_data[i].quantity, 10) || 1;
      total_wgt += ((getProductWeight[id] || 0) * q);
    }

    // Calculate bulk discount (20% off if weight >= 3000 grams)
    let bulkDiscountPaise = 0;
    if (total_wgt >= 3000) {
      bulkDiscountPaise = Math.round(session.amount * 0.20);
      session.amount = session.amount - bulkDiscountPaise;
    }

    // Apply coupon discount (if not already applied)
    let couponDiscountPaise = session.couponDiscount || 0;
    if (!couponDiscountPaise && session.customer?.coupon) {
      const couponData = validateCoupon(session.customer.coupon);
      if (couponData) {
        couponDiscountPaise = Math.round(session.amount * couponData.discount);
        session.amount = session.amount - couponDiscountPaise;
        session.coupon = couponData.code;
        session.couponDiscount = couponDiscountPaise;
      }
    }

    session.discount = bulkDiscountPaise + couponDiscountPaise;

    // Build final product description
    let final_product_name = "";
    for (let i = 0; i < product_data.length; i++) {
      final_product_name += (getProductName[product_data[i].product_retailer_id] || 'Item') + "(" + (product_data[i].quantity || 1) + ")" + "\n";
    }
    if (bulkDiscountPaise > 0) {
      final_product_name += "Bulk Discount (20% OFF): -₹" + (bulkDiscountPaise / 100).toFixed(2) + "\n";
    }
    if (couponDiscountPaise > 0) {
      final_product_name += `Coupon ${session.coupon} (10% OFF): -₹` + (couponDiscountPaise / 100).toFixed(2) + "\n";
    }
    final_product_name += "+ shipping charge";

    try {
      const chargesResp = await getDelhiveryCharges({
        origin_pin: DELHIVERY_ORIGIN_PIN,
        dest_pin: session.customer?.pincode || session.customer?.pin || '',
        cgm: total_wgt,
        pt: 'Pre-paid'
      });
      if (chargesResp && Array.isArray(chargesResp) && chargesResp[0]?.total_amount) {
        shippingChargePaise = Math.round(chargesResp[0].total_amount * 100);
      } else if (chargesResp?.total_amount) {
        // sometimes partners return object
        shippingChargePaise = Math.round(chargesResp.total_amount * 100);
      } else {
        console.warn("Could not parse delhivery charges response:", chargesResp);
      }
    } catch (err) {
      console.warn('Error retrieving delhivery charges for prepaid', err.message || err);
    }

    // Set shipping charge to zero if order value is greater than 1000 rupees
    if (session.amount > 1000 * 100) {
      shippingChargePaise = 0;
    }

    session.shipping_charge = shippingChargePaise;

    // Build shipment payload for Delhivery
    const shipment = {
      name: session.customer?.name || 'Customer',
      add: `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
      pin: session.customer?.pincode || session.customer?.pin || '',
      city: session.customer?.city || '',
      state: session.customer?.state || '',
      country: 'India',
      phone: session.customer?.phone || phone,
      order: `Order_${session.orderId || Date.now()}`,
      payment_mode: "Prepaid",
      products_desc: final_product_name,
      hsn_code: "",
      cod_amount: "0",
      total_amount: String(Math.round(session.amount / 100)), // rupees
      seller_add: "",
      seller_name: "",
      seller_inv: "",
      quantity: "",
      waybill: "",
      shipment_width: "100",
      shipment_height: "100",
      weight: "",
      shipping_mode: "Surface",
      address_type: ""
    };

    let delhiveryResp = null;
    try {
      delhiveryResp = await createDelhiveryShipment({ shipment });
      await sendWhatsAppText(phone, `📦 Shipment created. We'll share tracking once available.`);
    } catch (err) {
      console.error('Delhivery create after payment failed', err.message || err);
      await sendWhatsAppText(phone, `⚠️ Payment received but shipment creation failed. We'll follow up.`);
    }

    // Send order to App Script (triggers emails and sheet storage)
    try {
      await sendOrderToAppScript({
        orderId: session.orderId || '',
        timestamp: new Date().toISOString(),
        name: session.customer?.name || '',
        email: session.customer?.email || '',
        phone: session.customer?.phone || phone,
        address: `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
        pincode: session.customer?.pincode || '',
        city: session.customer?.city || '',
        state: session.customer?.state || '',
        productItems: session.productItems || [],
        paymentMode: 'Prepaid',
        paymentStatus: 'Paid',
        paymentId: '',
        subtotal: (session.amount / 100),
        shippingCharge: (session.shipping_charge / 100),
        codCharge: 0,
        discount: (session.discount / 100),
        coupon: session.coupon || '',
        total: ((session.amount + session.shipping_charge) / 100),
        delhiveryResponse: JSON.stringify(delhiveryResp || {})
      });
    } catch (err) {
      console.error('Failed to send prepaid paid order to App Script', err);
    }

    // Mark order as finalized
    session.finalized = true;

  } catch (err) {
    console.error("Failed finalizePaidOrder:", err);
    // Mark as finalized even if there was an error
    session.finalized = true;
  }
}

// ---------------- Delhivery helpers ----------------
async function getDelhiveryCharges({ origin_pin = DELHIVERY_ORIGIN_PIN, dest_pin, cgm = 5000, pt = 'Pre-paid' }) {
  // Validate inputs
  if (!dest_pin) {
    throw new Error('Destination pincode is required');
  }

  if (!DELHIVERY_TOKEN) {
    throw new Error('DELHIVERY_TOKEN not configured');
  }

  try {
    const params = {
      md: 'S',
      ss: 'Delivered',
      d_pin: dest_pin,
      o_pin: origin_pin,
      cgm,
      pt
    };
    const res = await axios.get(DELHIVERY_CHARGES_URL, {
      headers: { Authorization: `Token ${DELHIVERY_TOKEN}`, 'Content-Type': 'application/json' },
      params,
      timeout: 15000 // 15 second timeout
    });
    return res.data;
  } catch (err) {
    console.error('❌ Delhivery charges error:', err.response?.data || err.message || err);
    // Don't throw - return null and let caller handle it
    return null;
  }
}

async function createDelhiveryShipment({ shipment, pickup_location = { name: "Delhivery Uttarkashi", add: "", city: "", pin: DELHIVERY_ORIGIN_PIN, phone: "" } }) {
  // Validate inputs
  if (!shipment) {
    throw new Error('Shipment data is required');
  }

  if (!DELHIVERY_TOKEN) {
    throw new Error('DELHIVERY_TOKEN not configured');
  }

  // Validate required shipment fields
  const requiredFields = ['name', 'add', 'pin', 'phone', 'order', 'payment_mode'];
  const missingFields = requiredFields.filter(field => !shipment[field]);
  if (missingFields.length > 0) {
    throw new Error(`Missing required shipment fields: ${missingFields.join(', ')}`);
  }

  try {
    const payload = { shipments: [shipment], pickup_location };
    const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
    const res = await axios.post(DELHIVERY_CREATE_URL, bodyStr, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 20000 // 20 second timeout
    });
    return res.data;
  } catch (err) {
    console.error('❌ Delhivery create shipment error:', err.response?.data || err.message || err);
    // Re-throw so caller can handle appropriately
    throw new Error(`Failed to create Delhivery shipment: ${err.message}`);
  }
}

// ---------------- Webhook & message handlers (main) ----------------

// Webhook verification (Meta webhook)
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming WhatsApp messages
app.post('/', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || !req.body.entry) {
      console.warn('⚠️ Invalid webhook payload received');
      return res.sendStatus(200);
    }

    // Verify webhook signature (if APP_SECRET is configured)
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);

    if (signature && !verifyWhatsAppSignature(rawBody, signature)) {
      console.error('❌ Invalid webhook signature - possible unauthorized request');
      return res.sendStatus(403);
    }

    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const metadata = req.body.entry?.[0]?.changes?.[0]?.value?.metadata;
    const phoneIdFromMessage = metadata?.phone_number_id;

    if (phoneIdFromMessage !== phoneNumberId) {
      console.log(`Ignoring message sent to different number: ${phoneIdFromMessage}`);
      return res.sendStatus(200);
    }

    if (!msg) return res.sendStatus(200);

  // Deduplication check - prevent processing the same message multiple times (FIREBASE)
  const messageId = msg.id;
  const messageType = msg.type;

  console.log(`📨 Webhook received - Type: ${messageType}, ID: ${messageId || 'NO_ID'}, From: ${msg.from}`);

  // Check if message already processed (using Firebase for reliability)
  if (messageId) {
    const alreadyProcessed = await isMessageProcessed(messageId);
    if (alreadyProcessed) {
      console.log(`🔄 Duplicate message detected in Firebase (ID: ${messageId}), skipping processing`);
      return res.sendStatus(200);
    }
  }

  const fromRaw = msg.from;
  const from = normalizePhone(fromRaw);

  // Validate phone number
  if (!from || from.length < 10) {
    console.warn(`⚠️ Invalid phone number received: ${fromRaw}`);
    return res.sendStatus(200);
  }

  // Mark message as processed IMMEDIATELY in Firebase to prevent race conditions
  if (messageId) {
    await markMessageAsProcessed(messageId);
    console.log(`✓ Message marked as processed in Firebase: ${messageId}`);
  } else {
    console.warn(`⚠️ Message has no ID - cannot deduplicate! Type: ${messageType}, From: ${from}`);
  }

  if (!phoneToOrderIds[from]) phoneToOrderIds[from] = [];

  let session = null;
  let msgBody = "";
  if (msg.type === "text") {
    // Sanitize user text input
    const rawText = msg.text?.body || "";
    msgBody = sanitizeInput(rawText).toLowerCase().trim();
  } else if (msg.type === "interactive") {
    if (msg.interactive.type === "button_reply") {
      const rawText = msg.interactive.button_reply.title || "";
      msgBody = sanitizeInput(rawText).toLowerCase().trim();
    } else if (msg.interactive.type === "list_reply") {
      const rawText = msg.interactive.list_reply.title || "";
      msgBody = sanitizeInput(rawText).toLowerCase().trim();
    }
  } else if (msg.type === "order") {
    msgBody = "order_received";
  } else if(msg.type === "button") {
    const rawText = msg.button?.text || "";
    msgBody = sanitizeInput(rawText).toLowerCase().trim();
  }

   // ---- Idle timer handling ----
  // reset idle timer only for active customers who haven’t completed data
if (!completedUsers.has(from)) {
  if (idleTimers[from]) clearTimeout(idleTimers[from]);
  idleTimers[from] = setTimeout(async () => {
    // only send reminder if user still hasn't shared info
    if (!completedUsers.has(from)) {
      await sendWhatsAppText(
        from,
        "Still thinking?\n\nNo rush… but our small-batch treasures don’t hang around for long ✨,\n\nJust share your name & email so we can send you exclusive Himalayan food tips, & recipes."
      );
      remindedUsers.add(from);
      console.log(`⏰ Reminder sent to ${from}`);
    }
  }, 3 * 60 * 60 * 1000);
}




  // Flow submission handler (nfm_reply)
  if (msg?.interactive?.nfm_reply) {
    let customerData;
    try {
      customerData = JSON.parse(msg.interactive.nfm_reply.response_json);
    } catch (e) {
      customerData = msg.interactive.nfm_reply.response_json;
    }
    if (customerData?.flow_token === 'test_101') {
      console.log('Ignoring meta test flow payload');
      return res.sendStatus(200);
    }

    // ========================================
    // CRITICAL: Atomic Order Lock (Firebase Transaction)
    // Prevents duplicate orders from simultaneous webhooks
    // ========================================
    const orderResult = await acquireOrderLock(from, async () => {
      // This callback only runs if we successfully acquired the lock
      // If another webhook is processing, this won't execute

      const uid = new ShortUniqueId({ length: 5, dictionary: 'number' });
      const orderId = `OUO-${uid.randomUUID()}`;
      session = {
        orderId,
        phone: from,
        customer: customerData,
        step: 4,
        productItems: (orderSessions[from]?.productItems) || [],
        amount: (orderSessions[from]?.amount) || 0,
        createdAt: Date.now(), // For memory cleanup
        timestamp: new Date().toISOString(), // For logging
        finalized: false,
        processing: false
      };
      orderSessions[orderId] = session;
      if (!phoneToOrderIds[from]) phoneToOrderIds[from] = [];
      phoneToOrderIds[from].push(orderId);

      // Save session to Firebase for persistence
      await saveOrderSession(orderId, session);

      console.log(`📦 Order created - ID: ${orderId}, Customer: ${from}`);
      await sendWhatsAppText(from, `Thanks! We've received your delivery details. (OrderId: ${orderId})`);

      session.amount = session.amount || 0; // paise
      const paymentMode = (customerData.payment_mode || '').toLowerCase();
      console.log(`💰 Payment mode selected: ${paymentMode.toUpperCase()} for order ${orderId}`);

      if (paymentMode === 'cod' || paymentMode === 'cash on delivery' || paymentMode === 'cash-on-delivery') {
      session.cod_error = true;
            const codChargePaise = 150 * 100;
            let shippingChargePaise = 0;
            const product_data = session.productItems;
            let total_wgt = 0
            for(let i=0;i<product_data.length;i++){
                total_wgt+=getProductWeight[product_data[i].product_retailer_id]*product_data[i].quantity
            }

            // Calculate bulk discount (20% off if weight >= 3000 grams)
            let discountPaise = 0;
            let bulkDiscountApplied = false;
            if (total_wgt >= 3000) {
              discountPaise = Math.round(session.amount * 0.20);
              session.amount = session.amount - discountPaise;
              bulkDiscountApplied = true;
            }

            // Apply coupon discount
            let couponDiscountPaise = 0;
            const couponData = validateCoupon(customerData.coupon);
            if (couponData) {
              couponDiscountPaise = Math.round(session.amount * couponData.discount);
              session.amount = session.amount - couponDiscountPaise;
              session.coupon = couponData.code;
              session.couponDiscount = couponDiscountPaise;
            }

            // Total discount combines bulk + coupon
            session.discount = discountPaise + couponDiscountPaise;

            let final_product_name = "";
            for(let i=0;i<product_data.length;i++){
                final_product_name+=getProductName[product_data[i].product_retailer_id]+"("+product_data[i].quantity+")"+"\n";
            }
            if (bulkDiscountApplied && discountPaise > 0) {
              final_product_name += "Bulk Discount (20% OFF): -₹" + (discountPaise / 100).toFixed(2) + "\n";
            }
            if (couponData && couponDiscountPaise > 0) {
              final_product_name += `Coupon ${couponData.code} (${couponData.description}): -₹` + (couponDiscountPaise / 100).toFixed(2) + "\n";
            }
            final_product_name+="+ COD charge 150 + shipping charge"
            try {
              const chargesResp = await getDelhiveryCharges({
                origin_pin: DELHIVERY_ORIGIN_PIN,
                dest_pin: customerData.pincode || customerData.pin || '',
                cgm: total_wgt,
                pt: 'COD'
              });
              if (chargesResp) {
                
                const match = chargesResp[0].total_amount;
                console.log("----------> ", typeof match);
                
                if (match) {
                  // assume value in rupees if decimal or integer -> convert to paise
                  shippingChargePaise = Math.round(match * 100);
                } else {
                    session.cod_error = false;
                    console.warn('Could not reliably parse Delhivery charges response, defaulting shipping to 0. Response:', chargesResp);
                }
              }
            } catch (err) {
              session.cod_error = false;
              console.warn('Failed to get Delhivery charges, continuing with shippingChargePaise=0', err.message || err);
            }

            // Set shipping charge to zero if order value is greater than 1000 rupees
            if (session.amount > 1000 * 100) {
              shippingChargePaise = 0;
            }

            session.amount = (session.amount || 0) + codChargePaise + shippingChargePaise;
            session.payment_mode = 'COD';
            session.shipping_charge = shippingChargePaise;

            // Build shipment object for Delhivery create.json
            const shipment = {
              name: customerData.name || 'Customer',
              add: `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
              pin: customerData.pincode || customerData.pin || '',
              city: "",
              state: "",
              country: 'India',
              phone: customerData.phone || from,
              order: `Order_${session.orderId || Date.now()}`,
              payment_mode: "COD",
              return_pin: "",
              return_city: "",
              return_phone: "",
              return_add: "",
              return_state: "",
              return_country: "",
              products_desc: final_product_name,
              hsn_code: "",
              cod_amount: String(Math.round(session.amount / 100)), // rupees
              order_date: null,
              total_amount: String(Math.round(session.amount / 100)), // rupees
              seller_add: "",
              seller_name: "",
              seller_inv: "",
              quantity: "",
              waybill: "",
              shipment_width: "",
              shipment_height: "",
              weight: total_wgt, // optional
              shipping_mode: "Surface",
              address_type: ""
            };
      
            let delhiveryResp = null;
            delhiveryResp = await createDelhiveryShipment({ shipment });
            console.log(`🚚 COD Shipment created for order ${session.orderId}, Amount: ₹${(session.amount/100).toFixed(2)}`);

            if(delhiveryResp.success && session.cod_error){
              // Send order to App Script (triggers emails and sheet storage)
            try {
              await sendOrderToAppScript({
                orderId: session.orderId || '',
                timestamp: new Date().toISOString(),
                name: customerData.name || '',
                email: customerData.email || '',
                phone: customerData.phone || from,
                address: `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
                pincode: customerData.pincode || '',
                city: customerData.city || '',
                state: customerData.state || '',
                productItems: session.productItems || [],
                paymentMode: 'COD',
                paymentStatus: 'Pending',
                paymentId: '',
                subtotal: ((session.amount - codChargePaise - session.shipping_charge) / 100),
                shippingCharge: (session.shipping_charge / 100),
                codCharge: (codChargePaise / 100),
                discount: (session.discount / 100),
                coupon: session.coupon || '',
                total: (session.amount / 100),
                delhiveryResponse: JSON.stringify(delhiveryResp || {})
              });
            } catch (err) {
              console.error('Failed to send COD order to App Script', err);
            }

            // Mark order as finalized to prevent duplicate processing
            session.finalized = true;

            let codConfirmMsg = `✅ Your COD order is placed.`;
            if (bulkDiscountApplied || couponDiscountPaise > 0) {
              codConfirmMsg += ` 🎉 Discounts applied!`;
              if (bulkDiscountApplied) {
                codConfirmMsg += ` Bulk Discount (20% OFF)`;
              }
              if (couponDiscountPaise > 0) {
                codConfirmMsg += bulkDiscountApplied ? ` + Coupon ${couponData.code} (${couponData.description})` : ` Coupon ${couponData.code} (${couponData.description})`;
              }
              codConfirmMsg += `!`;
            }
            codConfirmMsg += ` Total: ₹${(session.amount/100).toFixed(2)}. We'll notify you when it's shipped.`;
            await sendWhatsAppText(from, codConfirmMsg);
            console.log(`✅ COD order completed - Order: ${session.orderId}`);
            }
            else{
              // Mark as finalized even if failed
              session.finalized = true;
              await sendWhatsAppText(from, `✅ Data you enter in flow is incorrect, Make sure you enter vaid data`);
              console.log(`❌ COD order failed - Invalid data for order ${session.orderId}`);
            }

            return true; // Success
      } else {
      session.payment_mode = 'Prepaid';
      console.log(`💳 Prepaid order initiated - Order: ${session.orderId}, Amount: ₹${(session.amount/100).toFixed(2)}`);

      try {
        const customerPayload = {
          phone: customerData.phone || from,
          email: customerData.email,
          name: customerData.name
        };

        // send order_details message which triggers the Review & Pay UI in WhatsApp
        await sendWhatsAppOrderDetails(from, session);

        // optionally also send a textual confirmation
        await sendWhatsAppText(from, `💳 Please tap *Review and Pay* inside the order card above to complete payment. OrderId: ${session.orderId}`);

        // NOTE: We do NOT send to App Script here (no emails/sheet storage until payment is confirmed)
        // Data will be sent to App Script only after payment confirmation in finalizePaidOrder()

      } catch (err) {
        console.error('Failed to send order_details message', err.response?.data || err.message || err);
        await sendWhatsAppText(from, `⚠️ Could not initiate payment. Please try again later.`);
      }

      return true; // Success
      }
    }); // End acquireOrderLock callback

    // Check if lock was acquired and order was processed
    if (!orderResult) {
      console.log(`⚠️ Duplicate order blocked for ${from} - lock not acquired`);
      return res.sendStatus(200); // Return success to WhatsApp to prevent retries
    }

    return res.sendStatus(200);
  } // end flow handler

  // normal message handlers (unchanged)
   let replyText = '';
  let useInteractiveMessage = false;
  let buttons = [];
  let isButtonReply = false;
  try {
    


    if (msg.interactive && msg.interactive.button_reply) {
    msgBody = msg.interactive.button_reply.title.toLowerCase().trim();
    isButtonReply = true;
  } else if (msg.text && msg.text.body) {
    msgBody = msg.text.body.toLowerCase().trim();
  }

  console.log(`📩 Message from ${from}: "${msgBody}"`);

  const intentResponse = findIntentBasedResponse(msgBody);
  

  if (msgBody === 'main menu') {
      await sendWhatsAppList(from);
      
  }
  else if(msgBody === 'Main Menu') {
      await sendWhatsAppList(from);
      
  }
  else if (intentResponse) {
    replyText = intentResponse.answer;
    if (intentResponse.intents && intentResponse.intents.length > 0) {
      useInteractiveMessage = true;
      buttons = intentResponse.intents.map(intent => ({
        id: intent.toLowerCase().replace(/\s+/g, '_'),
        title: intent
      }));
    }
  }
  
else if (/\b\d{14}\b/.test(msgBody)) {
  const awbMatch = msgBody.match(/\b\d{14}\b/);

  if (awbMatch) {
    const awb = awbMatch[0];
    console.log(`📦 Detected AWB: ${awb} from ${from}`);

    await sendWhatsAppTrackingCTA(from, awb);
  }
}

    else if (msgBody === 'hi' || msgBody === 'hello' || msgBody === 'hey') {
    // ];
    await sendWhatsAppList(from);
    
  }else if (/why people love us/i.test(msgBody) || /back 2 y ppl <3 us/i.test(msgBody) || /Why People Love Us/i.test(msgBody)) {
      await sendWhyPeopleLoveUs(from);
      
  } else if (/recipes/i.test(msgBody)) {
      await sendrecipes(from);
      
  }



  else if (/where we’re from/i.test(msgBody)) {
      await sendwherewe(from);
    
  }
  else if (/why it matters/i.test(msgBody)) {
      await sendmatters(from);
    
  }
  else if (/trace your products/i.test(msgBody)) {
      await sendtraceprod(from);
    
  }
  else if (/how it works/i.test(msgBody)) {
      await sendhowitworks(from);
    
  }
  else if (/explore/i.test(msgBody) || /back2 shop & explore/i.test(msgBody)) {
      await sendshopandexplore(from);
    
  }
  else if (/customer reviews/i.test(msgBody)) {
      await sendcustreview(from);
    
  }
  else if (/track your order/i.test(msgBody)) {
      sendWhatsAppText(from, 'Please type your 14 digit AWB in chat')
  }

  else if (/farmer impact/i.test(msgBody)) {
      await sendfarmerimpact(from);
    
  }
  
  else if (/sourcing story/i.test(msgBody) || /back2 sourcing story/i.test(msgBody)) {
      await sendWhatsAppList_ss(from);
      
  }
  else if (/nutrition info/i.test(msgBody) || /back 2 nutri info/i.test(msgBody)) {
      await sendWhatsAppList_ni(from);
      
  }
  else if (/view products/i.test(msgBody)) {
      await sendWhatsAppCatalog(from);
      
  } else if (/have a query/i.test(msgBody)) {
    useInteractiveMessage = true;
      await sendWhatsAppTemplate(from);
      
  }
  // PRIORITY 3: Handle other common responses
  else if (msgBody.includes('how are you')) {
    replyText = `We're flourishing like the alpine blooms at Gangotri! 😊 How can we assist you today?`;
  } 
  else if (msgBody === 'fine') {
    replyText = `Glad to hear you're doing fine! At 2,300 m, our small-holder farmers nurture each seed with care. Would you like to learn about our traceability or geo-seed mapping?`;
  } 
  else if (msgBody.includes('thank you') || msgBody.includes('thanks')) {
    replyText = `You're most welcome! Supporting Gangotri valley farmers means the world to us. Let us know if you'd like to know more about our ethical sourcing.`;
  } 
  else if (['awesome', 'amazing', 'great'].some(word => msgBody.includes(word))) {
    replyText = `That's wonderful to hear! Just like our wild tempering spice—harvested ethically at altitude—your enthusiasm warms our hearts. 😊`;
  }
   else if (msg.type === "order" || msgBody === "order_received") {
      const phoneKeySession = orderSessions[from] || {};
      phoneKeySession.catalogId = msg.order?.catalog_id;
      phoneKeySession.productItems = msg.order?.product_items || [];

      let totalAmount = 0;
      for (const item of phoneKeySession.productItems) {
        const priceRupees = parseFloat(item.item_price) || 0;
        const qty = parseInt(item.quantity, 10) || 1;
        totalAmount += priceRupees * 100 * qty;
      }
      phoneKeySession.amount = totalAmount; // in paise
      orderSessions[from] = phoneKeySession;

      console.log(`🛒 Cart received from ${from} - Items: ${phoneKeySession.productItems.length}, Total: ₹${(totalAmount/100).toFixed(2)}`);

      // Send Flow for delivery info
      await sendWhatsAppFlow(from, FLOW_ID);
      await sendWhatsAppText(from, "Please tap the button above and provide your delivery details.");
    } else if (remindedUsers.has(from) && !completedUsers.has(from)) {
  const emailMatch = msgBody.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const words = msgBody.split(/\s+/);

  if (emailMatch && words.length >= 2) {
    const email = emailMatch[0];
    let name = msgBody.split(email)[0].trim();

    // Clean connectors and extra symbols
    name = name.replace(/\b(and|&|,)\b/gi, '').trim();

    // Capitalize first letter of each word (optional, makes it look nice)
    name = name
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    remindedUsers.delete(from);
    completedUsers.add(from); // ✅ mark as done

    // Note: Customer contact collection (non-order) removed - can be handled separately if needed

    await sendWhatsAppText(from, `✅ Thanks ${name}! We've saved your details.`);
    console.log(`💾 Contact info received from ${from}: ${name}, ${email}`);
  }
}
    
    
    
    
    
    else {
      replyText = `At OrangUtan Organics, we stand against mislabelling and broken traceability. We empower local small‐holders, guarantee genuine Himalayan origin, and protect seeds via geo‐mapping. Say "Hi"`;
    }
  } catch (err) {
    console.error("Handler error:", err.response?.data || err);
  }
  try {
    if (replyText && replyText.trim()) {
      if (useInteractiveMessage && buttons.length > 0) {
        await sendWhatsAppInteractiveMessage(from, replyText, buttons);
        console.log(`📤 Interactive message sent to ${from} with ${buttons.length} buttons`);
      } else {
        await sendWhatsAppText(from, replyText);
      }
    }
  } catch (err) {
    console.error('❌ Error sending message:', err.response?.data || err.message);
  }

  res.sendStatus(200);
  } catch (err) {
    console.error('❌ CRITICAL: Unhandled error in main webhook handler:', err);
    console.error('Stack:', err.stack);
    // Always return 200 to WhatsApp to prevent retries
    res.sendStatus(200);
  }
});

// ---------------- Delhivery Webhook Endpoint ----------------
app.post('/delhivery-webhook', async (req, res) => {
  try {
    const webhookData = req.body;
    console.log('Delhivery webhook received:', JSON.stringify(webhookData, null, 2));

    // Extract data from webhook payload
    const awb = webhookData.waybill || webhookData.awb || webhookData.tracking_id;
    const status = (webhookData.status || webhookData.Status || '').toLowerCase();
    const customerPhone = webhookData.consignee_phone || webhookData.phone;
    const customerName = webhookData.consignee_name || webhookData.name || 'Customer';

    if (!awb) {
      console.warn('Delhivery webhook: Missing AWB/waybill');
      return res.status(400).json({ error: 'Missing AWB/waybill' });
    }

    if (!customerPhone) {
      console.warn('Delhivery webhook: Missing customer phone number');
      return res.status(400).json({ error: 'Missing customer phone' });
    }

    const normalizedPhone = normalizePhone(customerPhone);

    // Map Delhivery statuses to customer-friendly messages
    let messageText = '';
    let shouldSendUpdate = false;

    if (status.includes('manifest') || status.includes('pending')) {
      messageText = `Hello ${customerName}! 📦\n\nYour order has been manifested and is being prepared for shipment.\n\nYou can track your order using the link below:`;
      shouldSendUpdate = true;
    } else if (status.includes('in transit') || status.includes('intransit') || status.includes('in_transit')) {
      messageText = `Hello ${customerName}! 🚚\n\nGood news! Your order is now in transit and on its way to you.\n\nTrack your shipment here:`;
      shouldSendUpdate = true;
    } else if (status.includes('out for delivery') || status.includes('out_for_delivery') || status.includes('dispatched')) {
      messageText = `Hello ${customerName}! 🛵\n\nExciting news! Your order is out for delivery and will reach you soon today.\n\nTrack your delivery here:`;
      shouldSendUpdate = true;
    } else if (status.includes('delivered')) {
      messageText = `Hello ${customerName}! ✅\n\nYour order has been successfully delivered!\n\nThank you for choosing OrangUtan Organics. We hope you enjoy your Himalayan products! 🌱\n\nView delivery details:`;
      shouldSendUpdate = true;
    } else {
      console.log(`Delhivery webhook: Unhandled status "${status}" for AWB ${awb}`);
    }

    // Send WhatsApp message with tracking link
    if (shouldSendUpdate) {
      // First send the text message
      await sendWhatsAppText(normalizedPhone, messageText);

      // Then send the tracking CTA button
      await sendWhatsAppTrackingCTA(normalizedPhone, awb);

      console.log(`✅ Sent Delhivery status update to ${normalizedPhone} for AWB ${awb} (Status: ${status})`);
    }

    res.status(200).json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    console.error('Delhivery webhook error:', error.response?.data || error.message || error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------- A generic payments webhook endpoint (you must configure your BSP/payment gateway to POST here) ----------------
app.post('/payments-webhook', async (req, res) => {
  try {
    // Validate request body
    if (!req.body) {
      console.warn('⚠️ Invalid payment webhook payload received');
      return res.sendStatus(200);
    }

    const body = req.body;
    const event = body.event;

  const payment = req.body.payload.payment?.entity;
  const payment_link = req.body.payload.payment_link?.entity;

  // Get payment ID for idempotency check
  const paymentId = payment?.id || payment_link?.id || null;

  // IDEMPOTENCY CHECK: Prevent duplicate processing (FIREBASE)
  if (paymentId) {
    const alreadyProcessed = await isPaymentProcessed(paymentId);
    if (alreadyProcessed) {
      console.log(`⚠️ Payment webhook already processed in Firebase for payment ID: ${paymentId}. Skipping duplicate.`);
      return res.sendStatus(200); // Return success to stop Razorpay retries
    }
  }

  // Get reference ID (order ID)
  const referenceId = payment_link?.reference_id || payment?.reference_id || payment?.notes?.orderId || null;

  // Log webhook for debugging (only in development or first few times)
  if (process.env.NODE_ENV === 'development' || !referenceId) {
    console.log(`🔍 Full payment webhook payload:`, JSON.stringify(body, null, 2));
  }

  const status = event?.toLowerCase() || '';

  if (!referenceId) {
    console.warn('⚠️ Payments webhook: Could not find reference ID in payload');
  }

  console.log(`💳 Payment webhook - Reference ID: ${referenceId}, Status: ${status}, Payment ID: ${paymentId}`);

  let session = null;
  if (referenceId && orderSessions[referenceId]) {
    session = orderSessions[referenceId];
  } else {
    // fallback: attempt to find session by phone in webhook payload
    let phone = "";
    if (payment) {
      phone = normalizePhone(payment.contact);
    }
    if (!phone && payment_link?.customer?.contact) phone = normalizePhone(payment_link.customer.contact);
    if (phone && phoneToOrderIds[phone] && phoneToOrderIds[phone].length) {
      const lastOrderId = phoneToOrderIds[phone][phoneToOrderIds[phone].length - 1];
      session = orderSessions[lastOrderId];
      console.warn("Fallback session found via phone mapping. orderId:", lastOrderId);
    }
  }
  if (!session) {
    console.warn('⚠️ Payments webhook: no session for reference id', referenceId);
    return res.sendStatus(200);
  }

  // RACE CONDITION PROTECTION: Check if session is already finalized or being processed
  if (session.finalized || session.payment_status === 'completed' || session.processing) {
    console.log(`⚠️ Order ${session.orderId} already finalized or processing. Skipping duplicate webhook.`);
    return res.sendStatus(200); // Return success to stop retries
  }

  if (status.includes('paid')) {
    console.log(`✅ Payment successful - Order: ${session.orderId}`);

    // CRITICAL: Mark as processing IMMEDIATELY to prevent race conditions
    session.processing = true;
    session.processingStartedAt = Date.now();

    try {
      await finalizePaidOrder(session, body);

      // Mark payment as processed to prevent duplicate processing (FIREBASE)
      if (paymentId) {
        await markPaymentAsProcessed(paymentId);
        console.log(`✅ Payment ID ${paymentId} marked as processed in Firebase at ${new Date().toISOString()}`);
      }

      // Mark session as completed
      session.payment_status = 'completed';
      session.finalized = true;
      session.finalizedAt = Date.now();
      session.processing = false; // Clear processing flag
    } catch (err) {
      console.error('❌ Error finalizing paid order:', err);
      session.processing = false; // Clear processing flag even on error
      session.processingError = err.message;
      // Don't rethrow - we want to return 200 to prevent retries
    }
  } else if (status.includes('failed') || status.includes('cancel') || status.includes('expired')) {
    session.payment_status = 'failed';
    console.log(`❌ Payment ${status} - Order: ${session.orderId}`);
    await sendWhatsAppText(session.phone, "⚠️ Your payment failed or expired. Please try placing the order again.");

    // Mark payment as processed even for failed payments to prevent retries (FIREBASE)
    if (paymentId) {
      await markPaymentAsProcessed(paymentId);
    }
  }

  res.sendStatus(200);
  } catch (err) {
    console.error('❌ CRITICAL: Unhandled error in payments webhook handler:', err);
    console.error('Stack:', err.stack);
    // Always return 200 to prevent retries
    res.sendStatus(200);
  }
});


// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================

// 404 handler - Route not found
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});

// Global error handler - catches all errors
app.use((err, _req, res, _next) => {
  console.error('❌ Global error handler caught an error:');
  console.error('Error:', err.name, err.message);
  console.error('Stack:', err.stack);

  // Don't expose internal errors to client
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';

  res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? 'Internal server error' : message,
    ...(process.env.NODE_ENV === 'development' && { error: err.message, stack: err.stack })
  });
});

// ---------------- Start ----------------
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));