const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

if (!content.includes('dotenv/config')) {
  content = 'import "dotenv/config";\n' + content;
}
fs.writeFileSync('server.ts', content);
