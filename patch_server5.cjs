const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(
  'app.get("/api/health", (req, res) => {',
  'app.get("/api/health", (req, res) => {\n    res.json({ status: "ok", key: process.env.GEMINI_API_KEY });'
);
content = content.replace('    res.json({ status: "ok" });\n', '');
fs.writeFileSync('server.ts', content);
