// server-whatsapp-payments.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { google } from 'googleapis';
import ShortUniqueId from 'short-unique-id';
import { extractTextFromPDF } from './pdf_reader.js'
import { askGemini } from './gemini.js'
// import { parseIntentBasedQA } from "./components/IntentQA.js"

const app = express();

// capture raw body for webhook signature verification if needed
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));



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
  SHEET_ID,

  // Optional: provider/BSP-based payment lookup (set this if your BSP provides a REST lookup)
  PAYMENTS_LOOKUP_BASE_URL,
  PAYMENTS_LOOKUP_API_KEY
} = process.env;


let pdfText = '';
let intentBasedQA = new Map(); // Store Q&A with intents separately

(async () => {
  try {
    pdfText = await extractTextFromPDF('./modified_questions.pdf');
    console.log('PDF content loaded.');
    
    // Parse intent-based Q&A from PDF
    parseIntentBasedQA(pdfText);
    console.log('Intent-based Q&A parsed:', intentBasedQA.size);
  } catch (err) {
    console.error('Failed to load PDF:', err);
  }
})();

function parseIntentBasedQA() {
  intentBasedQA.clear();

  intentBasedQA.set('buy now', {
    answer: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347`,
    intents: ['View Products', "Customer Reviews"]
  });






  intentBasedQA.set('why people love us', {
    answer: `We're glad you're curious!💚\nHere’s why our community loves Orang Utan Organics 👇\nPick what you’d like to explore:`,
    intents: ['Nutrition info', 'Farmer Impact', 'Main Menu']
  });

  intentBasedQA.set('back 2 y ppl <3 us', {
    answer: `We're glad you're curious!!💚\nHere’s why our community loves Orang Utan Organics 👇\nPick what you’d like to explore:`,
    intents: ['Nutrition info', 'Farmer Impact', 'Main Menu']
  });

  // intentBasedQA.set('nutrition info', {
  //   answer: `Our products are:\n• 100% Himalayan grown & natural\n• NABL Lab-Tested for purity & nutrients\n• Rich in Iron, Fiber, and Antioxidants 🌾\nHere is Nutrition Info Table: https://orangutanorganics.net/nutrition`,
  //   intents: ["Recipes", 'Sourcing Story', 'View Products', "back 2 y ppl <3 us"]
  // });

  // intentBasedQA.set('back 2 nutri info', {
  //   answer: `Our products are:\n• 100% Himalayan grown & natural\n• NABL Lab-Tested for purity & nutrients\n• Rich in Iron, Fiber, and Antioxidants 🌾\nHere is Nutrition Info Table: https://orangutanorganics.net/nutrition`,
  //   intents: ["Recipes", 'Sourcing Story', 'View Products', "back 2 y ppl <3 us"]
  // });

  intentBasedQA.set('recipes', {
    answer: `Explore farm-fresh, nutritious recipes from our chef community:\n🥄 Red Rajma Curry with Tempering Spice\n🥄 Soyabean Stir-Fry\n🥄 Ghee-roasted Red Rice\nGet one sent to you now? View Recipe: https://orangutanorganics.net/recipes`,
    intents: ['View Products', 'back 2 nutri info']
  });

  intentBasedQA.set('farmer impact', {
    answer: `We directly reinvest in:\n• Soil conservation 🌍\n• Enhancing livelihoods via our farmers consortium 📘\n• Organic certifications for villages 🧾\nSee our Farmer’s Impact : https://orangutanorganics.net/farmerimpact`,
    intents: ['View Products', 'back 2 y ppl <3 us']
  });

  // intentBasedQA.set('sourcing story', {
  //   answer: `Every purchase helps a real Himalayan farmer.\n✅ Small landholder support\n✅ Gangotri Valley & high altitude-based collective\n✅ Traceable from farm to pack\nWant to see how your food travels from seed to shelf? Track Origin: https://orangutanorganics.net/`,
  //   intents: ['Where we’re from', 'Why It Matters', 'Trace Your Products', "Main Menu"]
  // });

  // intentBasedQA.set('back2 sourcing story', {
  //   answer: `Every purchase helps a real Himalayan farmer.\n✅ Small landholder support\n✅ Gangotri Valley & high altitude-based collective\n✅ Traceable from farm to pack\nWant to see how your food travels from seed to shelf? Track Origin: https://orangutanorganics.net/`,
  //   intents: ['Where we’re from', 'Why It Matters', 'Trace Your Products', "Main Menu"]
  // });

  intentBasedQA.set('where we’re from', {
    answer: `We’re rooted in Village Bhangeli, 2300m above sea level, in the Gangotri Valley 🏞\n🌱 Certified Organic Base\n📍 46 km from Uttarkashi, Uttarakhand\n💚 Home to just 40 small landholder families we support\nWould you like to see what life looks like up here? View Gallery: https://www.instagram.com/orangutan.organics/`,
    intents: ['View Products', 'Back2 Sourcing Story']
  });

  intentBasedQA.set('why it matters', {
    answer: `We protect:\n• Native seeds & biodiversity\n• Water sources & soil health\n• Farmer dignity & livelihoods\nBuying from us = standing up for the planet & Himalayan farmers. Learn about our latest impact project? See Report: https://orangutanorganics.net/whyitmatters`,
    intents: ['View Products', 'Back2 Sourcing Story']
  });

  intentBasedQA.set('trace your products', {
    answer: `Every product is traceable🔁 From seed-to-shelf, you’ll know:\n• The exact farm\n• The harvest date\n• The batch testing results\nWant to trace your future order?\nSee how it works: https://orangutanorganics.net/traceability`,
    intents: ['How It Works', 'View Products', 'Back2 Sourcing Story']
  });

  intentBasedQA.set('how it works', {
    answer: `We are tracing our products from our Himalayan farm to your plate with just a QR code, launching soon. We’ll notify you when it’s live!`,
    intents: ['View Products', 'Back2 Sourcing Story']
  });

  intentBasedQA.set('shop & explore', {
    answer: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347`,
    intents: ['Buy Products', "Customer Reviews", "Main Menu"]
  });

  intentBasedQA.set('back2 shop & explore', {
    answer: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347`,
    intents: ['Buy Products', "Customer Reviews", "Main Menu"]
  });

  intentBasedQA.set('buy products', {
    answer: `Amazing choice! Here are our most loved products:\n1. Himalayan White Rajma – ₹347 / ₹691\n2. Himalayan Red Rajma – ₹347 / ₹691\n3. Badri Cow Ghee – from ₹450 Onwards.\n4. Himalayan Black Soyabean – ₹347 / ₹691\n5. Himalayan Red Rice & Herbs – from ₹347`,
    intents: ['View Products', "Back2 Shop & Explore"]
  });

  intentBasedQA.set('customer reviews', {
    answer: `Don’t just take our word for it 💬\nHere’s what conscious buyers like you are saying 👇\nWebsite and amazon review: https://orangutanorganics.net/reviews \nInstagram love: https://www.instagram.com/p/DOIOa4rkv5C/`,
    intents: ['View Products', 'Back2 Shop & Explore']
  });

  intentBasedQA.set('track your order', {
    answer: `Please type your 14 digit AWB in chat`,
  });

  // intentBasedQA.set('have a query', {
  //   answer: `Please type your 14 digit AWB in chat`,
  //   intents: ['View Products', "Customer Reviews"]
  // });









  

  

  

  

  

  

  intentBasedQA.set('our story', {
    answer: `We’re not just a brand — we’re Forest People. Here’s what sets us apart.`,
    intents: ['Where We’re From', 'Why It Matters', 'Trace Your Products']
  });

  

  

  

  

  

  intentBasedQA.set('buy later', {
    answer: `Still thinking? No rush… but our small-batch treasures don’t hang around for long ✨, ust share your name & email so we can send you exclusive Himalayan food tips, recipes & offers 🌱✨`,
  });
}


// export default { parseIntentBasedQA };


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
const completedUsers = new Set(); 
const resolvedUsers = new Set(); 

// --- Helpers ---
function normalizePhone(phone) { return (phone || '').replace(/\D/g, ""); }

async function sendWhatsAppText(to, text) {
  try {
    await axios.post(GRAPH_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  } catch (err) {
    console.error('sendWhatsAppText error', err.response?.data || err.message || err);
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
          text: "Namaste from OrangUtan Organics 🌱",
        },
        body: {
          text: "Perched at 2,300 mtr in the Gangotri Valley, we are here to share the true taste of the Himalayas. How can we brighten your day?",
        },
        action: {
          button: "Options",
          sections: [
            {
              rows: [
                { id: "priority_express", title: "Why People Love Us" },
                { id: "priority_mail", title: "Sourcing Story" },
                { id: "fgh", title: "Shop & Explore" },
                { id: "er", title: "Track Your Order" },
                { id: "cv", title: "Have A Query" },
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
          text: "Every purchase helps a real Himalayan farmer.\n✅ Small landholder support\n✅ Gangotri Valley & high altitude-based collective\n✅ Traceable from farm to pack\nWant to see how your food travels from seed to shelf? Track Origin: https://orangutanorganics.net/traceability",
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
          text: "Our products are:\n• 100% Himalayan grown & natural\n• NABL Lab-Tested for purity & nutrients\n• Rich in Iron, Fiber, and Antioxidants 🌾\nHere is Nutrition Info Table: https://orangutanorganics.net/nutrition",
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

// async function sendWhatsAppCatalog(to) {
//   try {
//     await axios.post(GRAPH_URL,
//       {
//         messaging_product: "whatsapp",
//         to,
//         type: "interactive",
//         interactive: {
//           type: "product_list",
//           header: { type: "text", text: "Featured Products 🌟" },
//           body: { text: "Browse our catalog and pick your favorites 🌱" },
//           footer: { text: "OrangUtan Organics" },
//           action: {
//             catalog_id: "1262132998945503",
//             sections: [
//               {
//                 title: "Our Products",
//                 product_items: [
//                   { product_retailer_id: "43mypu8dye" },
//                   { product_retailer_id: "l722c63kq9" },
//                   { product_retailer_id: "kkii6r9uvh" },
//                   { product_retailer_id: "m519x5gv9s" },
//                   { product_retailer_id: "294l11gpcm" },
//                   { product_retailer_id: "ezg1lu6edm" },
//                   { product_retailer_id: "tzz72lpzz2" },
//                   { product_retailer_id: "esltl7pftq" },
//                   { product_retailer_id: "obdqyehm1w" }
//                 ]
//               }
//             ]
//           }
//         }
//       },
//       { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
//     );
//   } catch (err) {
//     console.error('sendWhatsAppCatalog error', err.response?.data || err.message || err);
//   }
// }



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
                  { product_retailer_id: "obdqyehm1w" }
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

// --- Google Sheets (keep as before) ---
let sheetsClient = null;
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    // Note: this sample uses keyFile; if you prefer passing the key via env - change accordingly
    keyFile: "cred.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function appendToSheet(rowValues) {
  const sheets = getSheetsClient();
  if (!sheets || !SHEET_ID) return null;
  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] }
    });
    return res.data;
  } catch (err) {
    console.error('appendToSheet error', err.response?.data || err.message || err);
    throw err;
  }
}

async function appendCustomerToSheet(rowValues) {
  const sheets = getSheetsClient();
  if (!sheets || !SHEET_ID) return null;
  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet2!A1',   // 👈 write to Sheet2
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] }
    });
    return res.data;
  } catch (err) {
    console.error('appendCustomerToSheet error', err.response?.data || err.message || err);
    throw err;
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
    "obdqyehm1w":"Himalayan Red Rice"};

const getProductWeight =
  { "43mypu8dye":120 ,
    "l722c63kq9":295 ,
    "kkii6r9uvh":495 ,
    "m519x5gv9s":500 ,
    "294l11gpcm":1000 ,
    "ezg1lu6edm":500 ,
    "tzz72lpzz2":1000 ,
    "esltl7pftq":100 ,
    "obdqyehm1w":1000};

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

    session.shipping_charge = shippingChargePaise;


    const totalAmountValue = prod_cost+shippingChargePaise
  




  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "order_details",
      header: { type: "text", text: `Order ${session.orderId}` },
      body: { text: "Please review your order and complete the payment. NOTE: shipment cost is included" },
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
          order: {
            status: "pending",
            items,
            subtotal: { value: prod_cost, offset: 100 },
            tax: { value: 0, offset: 100 },
            shipping: { value: Math.round((session.shipping_charge || 0)), offset: 100 }
          }
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
    await sendWhatsAppText(phone, "✅ Payment successful! Your order is confirmed.");

    // compute shipping using Delhivery (same logic you used before)
    let shippingChargePaise = 0;
    const product_data = session.productItems || [];

    let total_wgt = 0;
    for (let i = 0; i < product_data.length; i++) {
      const id = product_data[i].product_retailer_id;
      const q = parseInt(product_data[i].quantity, 10) || 1;
      total_wgt += ((getProductWeight[id] || 0) * q);
    }

    // Build final product description
    let final_product_name = "";
    for (let i = 0; i < product_data.length; i++) {
      final_product_name += (getProductName[product_data[i].product_retailer_id] || 'Item') + "(" + (product_data[i].quantity || 1) + ")" + "\n";
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

    // Append final row to sheet marking paid and shipment info
    try {
      const row = [
        new Date().toISOString(),
        session.customer?.name || '',
        session.customer?.phone || phone,
        session.customer?.email || '',
        `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
        session.customer?.pincode || '',
        JSON.stringify(session.productItems || []),
        'Prepaid',
        'Paid',
        (session.amount / 100).toFixed(2),
        (session.shipping_charge / 100).toFixed(2),
        '0.00',
        JSON.stringify(delhiveryResp || {}),
        session.orderId || ''
      ];
      await appendToSheet(row);
    } catch (err) {
      console.error('Failed to append prepaid paid order to sheet', err);
    }

  } catch (err) {
    console.error("Failed finalizePaidOrder:", err);
  }
}

// ---------------- Delhivery helpers (unchanged) ----------------
async function getDelhiveryCharges({ origin_pin = DELHIVERY_ORIGIN_PIN, dest_pin, cgm = 5000, pt = 'Pre-paid' }) {
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
      params
    });
    return res.data;
  } catch (err) {
    console.error('Delhivery charges error', err.response?.data || err.message || err);
    throw err;
  }
}

async function createDelhiveryShipment({ shipment, pickup_location = { name: "Delhivery Uttarkashi", add: "", city: "", pin: DELHIVERY_ORIGIN_PIN, phone: "" } }) {
  try {
    const payload = { shipments: [shipment], pickup_location };
    const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
    const res = await axios.post(DELHIVERY_CREATE_URL, bodyStr, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    return res.data;
  } catch (err) {
    console.error('Delhivery create error', err.response?.data || err.message || err);
    throw err;
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
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  console.log("message rec : ------------------------------------>", msg);
  
  if (!msg) return res.sendStatus(200);

  const fromRaw = msg.from;
  const from = normalizePhone(fromRaw);
  if (!phoneToOrderIds[from]) phoneToOrderIds[from] = [];

  let session = null;
  let msgBody = "";
  if (msg.type === "text") {
    msgBody = msg.text?.body?.trim() || "";
  } else if (msg.type === "interactive") {
    if (msg.interactive.type === "button_reply") {
      msgBody = msg.interactive.button_reply.title?.trim() || "";
    } else if (msg.interactive.type === "list_reply") {
      msgBody = msg.interactive.list_reply.title?.trim() || "";
    }
  } else if (msg.type === "order") {
    msgBody = "order_received";
  } else if(msg.type === "button") {
    msgBody = msg.button?.text.toLowerCase().trim() || "";
    // console.log("---------------->", msgBody);
    
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
        "Still thinking? No rush… but our small-batch treasures don’t hang around for long ✨, just share your name & email so we can send you exclusive Himalayan food tips, & recipes."
      );
      remindedUsers.add(from);
      console.log(`⏰ Reminder sent to ${from}`);
    }
  }, 30 * 60 * 1000);
}


// if (!resolvedUsers.has(from)) {
//   // Clear any existing timer for this user
//   if (idleTimers[from]) clearTimeout(idleTimers[from]);

//   // Set new 45-minute timer
//   idleTimers[from] = setTimeout(async () => {
//     // Only send if user still hasn’t resolved query
//     if (!resolvedUsers.has(from)) {
//       try {
//         await axios.post(
//           GRAPH_URL,
//           {
//             messaging_product: "whatsapp",
//             to: from,
//             type: "interactive",
//             interactive: {
//               type: "button",
//               body: {
//                 text: "Have we resolved your query?"
//               },
//               action: {
//                 buttons: [
//                   {
//                     type: "reply",
//                     reply: {
//                       id: "resolved_yes",
//                       title: "✅ Yes"
//                     }
//                   },
//                   {
//                     type: "reply",
//                     reply: {
//                       id: "resolved_no",
//                       title: "❌ No"
//                     }
//                   }
//                 ]
//               }
//             }
//           },
//           {
//             headers: {
//               Authorization: `Bearer ${ACCESS_TOKEN}`,
//               "Content-Type": "application/json"
//             }
//           }
//         );

//         console.log(`⏰ 45-min follow-up sent to ${from}`);
//       } catch (err) {
//         console.error(
//           "sendFollowUp error",
//           err.response?.data || err.message || err
//         );
//       }
//     }
//   }, 12 * 1000); // 45 minutes
// }

  // ---- If user replies with name + email after reminder ----
// ---- If user replies with name + email after reminder ----




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

    
    const uid = new ShortUniqueId({ length: 5, dictionary: 'number' });
    const orderId = `OUO-${uid.randomUUID()}`;
    session = {
      orderId,
      phone: from,
      customer: customerData,
      step: 4,
      productItems: (orderSessions[from]?.productItems) || [],
      amount: (orderSessions[from]?.amount) || 0
    };
    orderSessions[orderId] = session;
    phoneToOrderIds[from].push(orderId);

    await sendWhatsAppText(from, `Thanks! We've received your delivery details. (OrderId: ${orderId})`);

    session.amount = session.amount || 0; // paise
    const paymentMode = (customerData.payment_mode || '').toLowerCase();
    console.log("paymentMode:", paymentMode);

    if (paymentMode === 'cod' || paymentMode === 'cash on delivery' || paymentMode === 'cash-on-delivery') {
      session.cod_error = true;
            const codChargePaise = 150 * 100;
            let shippingChargePaise = 0;
            const product_data = session.productItems;
            let total_wgt = 0
            for(let i=0;i<product_data.length;i++){
                total_wgt+=getProductWeight[product_data[i].product_retailer_id]*product_data[i].quantity
            }
      
            let final_product_name = "";
            for(let i=0;i<product_data.length;i++){
                final_product_name+=getProductName[product_data[i].product_retailer_id]+"("+product_data[i].quantity+")"+"\n";  
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
            // console.log("ship_cost=",shippingChargePai
            
            session.amount = (session.amount || 0) + codChargePaise + shippingChargePaise;
            session.payment_mode = 'COD';
            session.shipping_charge = shippingChargePaise;
            // session.cod_amount = codChargePaise;
      
            // Build shipment object for Delhivery create.json
            // console.log("insideeeee******** ",final_product_name);
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
            if(delhiveryResp.success && session.cod_error){
              // Append to Google Sheet
            try {
              const row = [
                new Date().toISOString(),
                customerData.name || '',
                customerData.phone || from,
                customerData.email || '',
                `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
                customerData.pincode || '',
                JSON.stringify(session.productItems || []),
                'COD',
                'Pending', // payment status for COD
                (session.amount / 100).toFixed(2), // amount in rupees
                (session.shipping_charge / 100).toFixed(2),
                (codChargePaise / 100).toFixed(2),
                JSON.stringify(delhiveryResp || {})
              ];
              await appendToSheet(row);
            } catch (err) {
              console.error('Failed to append COD order to sheet', err);
            }
      
            await sendWhatsAppText(from, `✅ Your COD order is placed. Total: ₹${(session.amount/100).toFixed(2)}. We'll notify you when it's shipped.`);
            }
            else{
              await sendWhatsAppText(from, `✅ Data you enter in flow is incorrect, Make sure you enter vaid data`);
            }
            console.log("cod donee");
            
            return res.sendStatus(200);
    } else {
      session.payment_mode = 'Prepaid';
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

        // Append preliminary row to sheet (awaiting payment)
        try {
          const row = [
            new Date().toISOString(),
            customerData.name || '',
            customerData.phone || from,
            customerData.email || '',
            `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
            customerData.pincode || '',
            JSON.stringify(session.productItems || []),
            'Prepaid',
            'Awaiting Payment',
            (session.amount / 100).toFixed(2),
            '', // shipping charge unknown yet
            '', // cod amount
            `whatsapp_payment_config:${PAYMENT_CONFIGURATION_NAME}`,
            session.orderId
          ];
          await appendToSheet(row);
        } catch (err) {
          console.error('Failed to append awaiting payment row to sheet', err);
        }

      } catch (err) {
        console.error('Failed to send order_details message', err.response?.data || err.message || err);
        await sendWhatsAppText(from, `⚠️ Could not initiate payment. Please try again later.`);
      }

      return res.sendStatus(200);
    }
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

  console.log("message received : ", msgBody);
  // console.log("message received : ", msgBody);
  
   

  const intentResponse = findIntentBasedResponse(msgBody);
  

  if (msgBody === 'main menu') {
      await sendWhatsAppList(from);
      
  } 
//   else if (msg.interactive.button_reply.id === "resolved_yes") {
//   resolvedUsers.add(from);
//   await sendWhatsAppText(from, "yes pressed");
// }

// else if (msg.interactive.button_reply.id === "resolved_no") {
//   await sendWhatsAppText(from, "no pressed");
// }
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
    // replyText = `Namaste from OrangUtan Organics 🌱\nPerched at 2,300 mtr in the Gangotri Valley, we're here to share the true taste of the Himalayas. How can we brighten your day?`;
    // useInteractiveMessage = true;
    // buttons = [
    //   { id: 'view_products', title: 'Buy now' },
    //   { id: 'why_people_love_us', title: 'Why people love us' },
    //   { id: 'customer_reviews', title: 'Our story' }
    // ];
    await sendWhatsAppList(from);
    
  }else if (/sourcing story/i.test(msgBody) || /back2 sourcing story/i.test(msgBody)) {
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

    await appendCustomerToSheet([
      new Date().toISOString(),
      name,
      email,
      from
    ]);

    await sendWhatsAppText(from, `✅ Thanks ${name}! We've saved your details.`);
    console.log(`💾 Saved contact for ${from}: ${name}, ${email}`);
  }
}
    
    
    
    
    
    else {
      try {
      // Create a focused prompt that emphasizes intent-based responses
      const focusedPrompt = `
As OrangUtan Organics representative, answer this question warmly and briefly (max 50 words).
If the question is about traceability, origin, sourcing, or "how it works" - suggest they ask about "Trace Your Products".

Question: "${msgBody}"
      `;
      
      const answer = await askGemini(focusedPrompt, pdfText);
      replyText = answer || `At OrangUtan Organics, we stand against mislabelling and broken traceability. We empower local small‐holders, guarantee genuine Himalayan origin, and protect seeds via geo‐mapping. Feel free to ask about any of these!`;
    } catch (err) {
      console.error('AI response error:', err);
      replyText = `Oops—something went awry! If you need assistance or want to learn about our farmers, traceability, or seed protection, just let me know.`;
    }
    }
  } catch (err) {
    console.error("Handler error:", err.response?.data || err);
  }
  try {
    if (useInteractiveMessage && buttons.length > 0) {
      await sendWhatsAppInteractiveMessage(from, replyText, buttons);
      console.log(`Sent interactive message to ${from} with ${buttons.length} buttons:`, buttons.map(b => b.title));
    } else {
      await sendWhatsAppText(from, replyText);
      console.log(`Replied to ${from}: "${replyText.substring(0, 100)}..."`);
    }
  } catch (err) {
    console.error('Error sending message:', err.response?.data || err.message);
  }

  res.sendStatus(200);
});

// ---------------- A generic payments webhook endpoint (you must configure your BSP/payment gateway to POST here) ----------------
app.post('/payments-webhook', async (req, res) => {
  const body = req.body;
  const event = body.event;

  const payment = req.body.payload.payment?.entity;
  const payment_link = req.body.payload.payment_link?.entity;
  // console.log("-----payment-------->", payment);
  // console.log("-----pay_contact------>",payment.contact);
  
  

  // fallback: use order_id directly (not ideal if you rely only on reference_id)
  const referenceId = payment_link?.reference_id || payment?.reference_id || payment?.notes?.orderId || null;

  const status = event?.toLowerCase() || '';

  if (!referenceId) {
    console.warn('payments-webhook: could not find reference id in provider payload', body);
    // return res.sendStatus(400);
  }

  console.log('payments-webhook receive:', referenceId, status);

  // const session = orderSessions[referenceId] || null;


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
    console.warn('payments-webhook: no session for reference id', referenceId);
    return res.sendStatus(200);
  }

  if (status.includes('paid')) {
    try {
      await finalizePaidOrder(session, body);
    } catch (err) {
      console.error('finalizePaidOrder error', err);
    }
  } else if (status.includes('failed') || status.includes('cancel') || status.includes('expired')) {
    session.payment_status = 'failed';
    await sendWhatsAppText(session.phone, "⚠️ Your payment failed or expired. Please try placing the order again.");
  }

  res.sendStatus(200);
});


// ---------------- Start ----------------
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));
