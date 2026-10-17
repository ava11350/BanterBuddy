const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');
const startIndex = content.indexOf('app.post("/api/tts"');
const endIndex = content.indexOf('// Vite middleware for development');
if (startIndex !== -1 && endIndex !== -1) {
  content = content.substring(0, startIndex) + content.substring(endIndex);
  fs.writeFileSync('server.ts', content);
}
