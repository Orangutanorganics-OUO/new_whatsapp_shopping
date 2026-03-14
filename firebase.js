// firebase.js - Firebase Realtime Database initialization and helpers
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, get, remove, runTransaction } from 'firebase/database';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

console.log('✅ Firebase initialized successfully');

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Sanitize key for Firebase (remove invalid characters)
 * Firebase paths cannot contain: . $ # [ ] /
 * @param {string} key - Original key
 * @returns {string} - Sanitized key
 */
function sanitizeFirebaseKey(key) {
  if (!key) return key;
  // Replace invalid characters with underscores
  return key.replace(/[.#$[\]\/]/g, '_');
}

/**
 * Check if a message has been processed (deduplication)
 * @param {string} messageId - WhatsApp message ID
 * @returns {Promise<boolean>} - true if already processed
 */
export async function isMessageProcessed(messageId) {
  if (!messageId) return false;

  const sanitizedId = sanitizeFirebaseKey(messageId);
  const messageRef = ref(db, `processedMessages/${sanitizedId}`);
  const snapshot = await get(messageRef);
  return snapshot.exists();
}

/**
 * Mark a message as processed
 * @param {string} messageId - WhatsApp message ID
 * @returns {Promise<void>}
 */
export async function markMessageAsProcessed(messageId) {
  if (!messageId) return;

  const sanitizedId = sanitizeFirebaseKey(messageId);
  const messageRef = ref(db, `processedMessages/${sanitizedId}`);
  await set(messageRef, {
    timestamp: Date.now(),
    processedAt: new Date().toISOString(),
    originalId: messageId // Store original for debugging
  });
}

/**
 * Check if a payment has been processed (deduplication)
 * @param {string} paymentId - Razorpay payment ID
 * @returns {Promise<boolean>} - true if already processed
 */
export async function isPaymentProcessed(paymentId) {
  if (!paymentId) return false;

  const sanitizedId = sanitizeFirebaseKey(paymentId);
  const paymentRef = ref(db, `processedPayments/${sanitizedId}`);
  const snapshot = await get(paymentRef);
  return snapshot.exists();
}

/**
 * Mark a payment as processed
 * @param {string} paymentId - Razorpay payment ID
 * @returns {Promise<void>}
 */
export async function markPaymentAsProcessed(paymentId) {
  if (!paymentId) return;

  const sanitizedId = sanitizeFirebaseKey(paymentId);
  const paymentRef = ref(db, `processedPayments/${sanitizedId}`);
  await set(paymentRef, {
    timestamp: Date.now(),
    processedAt: new Date().toISOString(),
    originalId: paymentId // Store original for debugging
  });
}

/**
 * Atomic transaction to acquire order processing lock
 * Prevents duplicate orders from simultaneous webhooks
 * @param {string} phone - User's phone number
 * @param {Function} callback - Function to execute if lock acquired
 * @returns {Promise<any>} - Result from callback or null if lock failed
 */
export async function acquireOrderLock(phone, callback) {
  const sanitizedPhone = sanitizeFirebaseKey(phone);
  const lockRef = ref(db, `orderLocks/${sanitizedPhone}`);

  try {
    const result = await runTransaction(lockRef, (currentLock) => {
      // If lock exists and is recent (within 2 minutes), abort
      if (currentLock && currentLock.timestamp) {
        const lockAge = Date.now() - currentLock.timestamp;
        if (lockAge < 2 * 60 * 1000) { // 2 minutes
          console.log(`🔒 Order lock active for ${phone} (age: ${lockAge}ms)`);
          return; // Abort transaction
        }
      }

      // Acquire lock
      return {
        timestamp: Date.now(),
        acquiredAt: new Date().toISOString()
      };
    });

    if (!result.committed) {
      console.log(`⚠️ Failed to acquire order lock for ${phone} - duplicate request blocked`);
      return null;
    }

    console.log(`✅ Order lock acquired for ${phone}`);

    // Execute callback with lock held
    const callbackResult = await callback();

    // Release lock after successful execution
    await remove(lockRef);
    console.log(`🔓 Order lock released for ${phone}`);

    return callbackResult;

  } catch (error) {
    console.error('❌ Error in order lock transaction:', error);
    // Release lock on error
    try {
      await remove(lockRef);
    } catch (e) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Save order session to Firebase
 * @param {string} orderId - Order ID
 * @param {object} sessionData - Session data
 * @returns {Promise<void>}
 */
export async function saveOrderSession(orderId, sessionData) {
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const sessionRef = ref(db, `orderSessions/${sanitizedId}`);
  await set(sessionRef, {
    ...sessionData,
    savedAt: Date.now(),
    originalOrderId: orderId // Store original for reference
  });
}

/**
 * Get order session from Firebase
 * @param {string} orderId - Order ID
 * @returns {Promise<object|null>} - Session data or null
 */
export async function getOrderSession(orderId) {
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const sessionRef = ref(db, `orderSessions/${sanitizedId}`);
  const snapshot = await get(sessionRef);
  return snapshot.exists() ? snapshot.val() : null;
}

/**
 * Delete order session from Firebase
 * @param {string} orderId - Order ID
 * @returns {Promise<void>}
 */
export async function deleteOrderSession(orderId) {
  const sanitizedId = sanitizeFirebaseKey(orderId);
  const sessionRef = ref(db, `orderSessions/${sanitizedId}`);
  await remove(sessionRef);
}

/**
 * Cleanup old data from Firebase (runs periodically)
 * Removes processed messages and payments older than 10 minutes
 * Removes stale order locks older than 5 minutes
 * @returns {Promise<void>}
 */
export async function cleanupOldData() {
  const now = Date.now();
  const messageExpiry = 10 * 60 * 1000; // 10 minutes
  const lockExpiry = 5 * 60 * 1000; // 5 minutes

  try {
    // Cleanup old processed messages
    const messagesRef = ref(db, 'processedMessages');
    const messagesSnapshot = await get(messagesRef);
    if (messagesSnapshot.exists()) {
      const messages = messagesSnapshot.val();
      for (const [sanitizedMessageId, data] of Object.entries(messages)) {
        if (data.timestamp && now - data.timestamp > messageExpiry) {
          await remove(ref(db, `processedMessages/${sanitizedMessageId}`));
        }
      }
    }

    // Cleanup old processed payments
    const paymentsRef = ref(db, 'processedPayments');
    const paymentsSnapshot = await get(paymentsRef);
    if (paymentsSnapshot.exists()) {
      const payments = paymentsSnapshot.val();
      for (const [sanitizedPaymentId, data] of Object.entries(payments)) {
        if (data.timestamp && now - data.timestamp > messageExpiry) {
          await remove(ref(db, `processedPayments/${sanitizedPaymentId}`));
        }
      }
    }

    // Cleanup stale order locks
    const locksRef = ref(db, 'orderLocks');
    const locksSnapshot = await get(locksRef);
    if (locksSnapshot.exists()) {
      const locks = locksSnapshot.val();
      for (const [sanitizedPhone, data] of Object.entries(locks)) {
        if (data.timestamp && now - data.timestamp > lockExpiry) {
          await remove(ref(db, `orderLocks/${sanitizedPhone}`));
        }
      }
    }

    console.log('🧹 Firebase cleanup completed');
  } catch (error) {
    console.error('❌ Firebase cleanup error:', error);
  }
}

export { db };
