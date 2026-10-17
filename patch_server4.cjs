const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(
  'return res.status(500).json({ error: e.message || "TTS failed", keyString: process.env.GEMINI_API_KEY });',
  'return res.status(500).json({ error: e.message || "TTS failed" });'
);
fs.writeFileSync('server.ts', content);
