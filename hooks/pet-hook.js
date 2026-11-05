#!/usr/bin/env node
// Claude Code hook -> Claude Pet bridge.
// Reads the hook payload from stdin and forwards it to the pet's local server.
// It must never print anything (some hooks inject stdout into Claude's context)
// and must never fail or block Claude Code: every path exits 0, fast.
const http = require('http');

const PORT = Number(process.env.CLAUDE_PET_PORT) || 47321;
setTimeout(() => process.exit(0), 1500).unref();

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', send);
process.stdin.on('error', () => process.exit(0));

function send() {
  if (!data.trim()) process.exit(0);
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/event',
      method: 'POST',
      timeout: 800,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-claude-pet': '1',
      },
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.end(data);
}
