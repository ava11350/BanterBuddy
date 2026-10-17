const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(
  /const ai = new GoogleGenAI\({/,
  'console.log("TTS Route Hit! API Key length:", process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : "MISSING");\n      const ai = new GoogleGenAI({'
);
fs.writeFileSync('server.ts', content);
