// gemini.js
const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

async function askGemini(question, contextText) {
  try {
    const response = await axios.post(GEMINI_ENDPOINT, {
      contents: [
        {
          parts: [
            {
              text: `You are a customer care bot specialized in organic products. You provide helpful, accurate, and friendly responses to customer inquiries about organic products, services, policies, and related information. Always be professional, courteous, informative and little humorous (make sure customer have great engagement).

Context:
${contextText}

Question:
${question}
`,
            },
          ],
        },
      ],
    });

    const answer =
      response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No answer found.";
    return answer;
  } catch (error) {
    console.error("Gemini API error:", error.response?.data || error.message);
    return "Error getting answer from Gemini.";
  }
}

module.exports = { askGemini };
