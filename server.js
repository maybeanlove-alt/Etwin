require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from current directory
app.use(express.static(__dirname));

// Serve chat.html as the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
});

// Validate GROQ_API_KEY
if (!process.env.GROQ_API_KEY) {
    console.error('ERROR: GROQ_API_KEY environment variable is required');
    console.error('Please set GROQ_API_KEY before starting the server');
    process.exit(1);
}

// Initialize Groq SDK
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// Initialize Gemini SDK
let gemini;
if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here') {
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// Timeout wrapper function
function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        )
    ]);
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, language } = req.body;
        
        console.log('Received request with language:', language || 'auto');
        
        console.log('Received request with messages:', messages);
        
        if (!messages || !Array.isArray(messages)) {
            console.error('Invalid messages format:', messages);
            return res.status(400).json({ error: 'Messages array is required' });
        }

        // Validate messages format
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg.role || !msg.content) {
                console.error(`Invalid message at index ${i}:`, msg);
                return res.status(400).json({ error: `Message at index ${i} is missing role or content` });
            }
        }

        // Check API key
        if (!process.env.GROQ_API_KEY) {
            console.error('ERROR: GROQ_API_KEY is undefined');
            return res.status(500).json({ error: 'GROQ_API_KEY is not configured' });
        }
        console.log('GROQ_API_KEY is configured (length:', process.env.GROQ_API_KEY.length, ')');

        // Add system prompt to the beginning of messages array
        const systemPrompt = 'You are a biology assistant. Always respond in the SAME language as the user\'s LAST message. If the user writes in English → respond in English. If the user writes in Turkish → respond in Turkish. Never translate unless asked. Never mix languages. Always match the user\'s language exactly. If the user is not directly asking about biology, give short answers. Do not force connections to biology unnecessarily. Only provide details if the topic is relevant to biology.';
        
        const messagesWithSystem = [
            { role: 'system', content: systemPrompt },
            ...messages
        ];
        
        console.log('System prompt being sent:', systemPrompt);
        console.log('Messages array with system:', JSON.stringify(messagesWithSystem, null, 2));

        console.log('Sending to Groq API with model: llama-3.3-70b-versatile');
        console.log('Messages count:', messagesWithSystem.length);

        let response;
        try {
            // Send messages array to Groq API with 5 second timeout
            const chatCompletion = await withTimeout(
                groq.chat.completions.create({
                    messages: messagesWithSystem,
                    model: 'llama-3.3-70b-versatile',
                    temperature: 0.3,
                    max_tokens: 1024,
                }),
                5000
            );
            response = chatCompletion.choices[0]?.message?.content || 'No response generated';
            console.log('Groq API response received successfully');
        } catch (groqError) {
            console.log('Groq API failed or timed out, using Gemini fallback');
            console.log('Groq error:', groqError.message);
            
            // Fallback to Gemini
            if (!gemini) {
                console.error('Gemini not configured, cannot fallback');
                return res.status(500).json({ error: 'Both Groq and Gemini are unavailable' });
            }

            try {
                // Convert messages to Gemini format (join content with newlines)
                const geminiPrompt = messages.map(m => m.content).join('\n');
                
                const geminiModel = gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const geminiResult = await geminiModel.generateContent(geminiPrompt);
                response = geminiResult.response.text();
                
                console.log('Gemini API response received successfully');
            } catch (geminiError) {
                console.error('Gemini API also failed:', geminiError.message);
                return res.status(500).json({ error: 'Both Groq and Gemini APIs failed' });
            }
        }
        
        res.json({ response });
    } catch (error) {
        console.error('Error in /api/chat:');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        
        if (error.response) {
            console.error('Groq API response error:', error.response.data);
            console.error('Groq API status:', error.response.status);
        }
        
        // Return appropriate HTTP status codes
        const apiStatus = error.response?.status;
        
        if (apiStatus === 429) {
            return res.status(429).json({ error: 'Rate limit exceeded', status: 429 });
        }
        
        if (apiStatus === 400) {
            return res.status(400).json({ error: 'Invalid request', status: 400 });
        }
        
        if (apiStatus === 503) {
            return res.status(503).json({ error: 'Service temporarily unavailable', status: 503 });
        }
        
        if (error.message === 'Timeout') {
            return res.status(503).json({ error: 'Request timed out', status: 503 });
        }
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Invalid request body', status: 400 });
        }
        
        return res.status(500).json({ error: 'Internal server error', status: 500 });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
