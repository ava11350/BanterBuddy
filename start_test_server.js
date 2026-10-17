const { spawn } = require('child_process');
const server = spawn('npm', ['run', 'dev'], { stdio: 'inherit', env: process.env });
server.on('exit', () => console.log('exited'));
setTimeout(() => {
  server.kill();
}, 5000);
