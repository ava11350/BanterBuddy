const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(
  'return res.status(500).json({ error: e.message || "TTS failed" });',
  'return res.status(500).json({ error: e.message || "TTS failed", keyLength: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : "MISSING" });'
);
fs.writeFileSync('server.ts', content);
