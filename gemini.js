// gemini.js
import axios from 'axios';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Validate API key on load
if (!GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY not configured. AI responses will be disabled.');
}

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

/**
 * Ask Gemini AI a question with context
 * @param {string} question - The user's question
 * @param {string} contextText - Context for the AI
 * @returns {Promise<string>} - The AI's response
 */
export async function askGemini(question, contextText = '') {
  // Validate inputs
  if (!question || typeof question !== 'string' || question.trim() === '') {
    console.warn('⚠️ Invalid question provided to askGemini');
    return "I didn't quite understand that. Could you please rephrase your question?";
  }

  if (!GEMINI_API_KEY) {
    console.error('❌ Cannot call Gemini: API key not configured');
    return "I'm currently unable to answer that question. Please contact our support team for assistance.";
  }

  try {
    const response = await axios.post(
      GEMINI_ENDPOINT,
      {
        contents: [
          {
            parts: [
              {
                text: `You are a customer care bot specialized in organic products. You provide helpful, accurate, and friendly responses to customer inquiries about organic products, services, policies, and related information. Always be professional, courteous, informative and little humorous (make sure customer have great engagement).

Context:
${contextText || 'No additional context provided.'}

Question:
${question.trim()}
`,
              },
            ],
          },
        ],
      },
      {
        timeout: 15000, // 15 second timeout
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    // Safely extract answer with multiple fallbacks
    const answer =
      response?.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      response?.data?.candidates?.[0]?.text ||
      'No answer found.';

    if (!answer || answer === 'No answer found.') {
      console.warn('⚠️ Gemini returned empty response');
      return "I'm not sure how to answer that. Could you try asking differently?";
    }

    return answer;
  } catch (error) {
    // Detailed error logging
    if (error.response) {
      // API returned an error response
      console.error('❌ Gemini API error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
      });
    } else if (error.request) {
      // Request made but no response received
      console.error('❌ Gemini request timeout or network error:', error.message);
    } else {
      // Other errors
      console.error('❌ Gemini error:', error.message);
    }

    // Return user-friendly error message
    return "I'm having trouble connecting to my knowledge base right now. Please try again in a moment or contact our support team.";
  }
}
