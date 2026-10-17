const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(
  'res.json({ status: "ok", key: process.env.GEMINI_API_KEY });',
  'res.json({ status: "ok", key: process.env.GEMINI_API_KEY, appUrl: process.env.APP_URL });'
);
fs.writeFileSync('server.ts', content);
