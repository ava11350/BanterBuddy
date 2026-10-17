const { spawn } = require('child_process');
const server = spawn('npm', ['run', 'dev'], { env: process.env });
server.stdout.on('data', d => process.stdout.write(d));
server.stderr.on('data', d => process.stderr.write(d));
server.on('exit', () => console.log('exited'));
setTimeout(() => {
  server.kill();
}, 5000);
