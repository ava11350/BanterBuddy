const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(/gemini-3.6-flash/g, "gemini-3.1-flash-tts-preview");
fs.writeFileSync('server.ts', content);
