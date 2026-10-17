const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace('import "dotenv/config";\n', '');
content = content.replace(
  'res.json({ status: "ok", key: process.env.GEMINI_API_KEY, appUrl: process.env.APP_URL });',
  'res.json({ status: "ok" });'
);
fs.writeFileSync('server.ts', content);
