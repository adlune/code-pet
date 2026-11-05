#!/usr/bin/env node
// Plays a scripted sequence of fake Claude Code hook events at the running pet.
// Usage: npm run demo
const http = require('http');
const PORT = Number(process.env.CLAUDE_PET_PORT) || 47321;

function post(ev) {
  const body = JSON.stringify(ev);
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/event', method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-pet': '1', 'content-length': Buffer.byteLength(body) } },
      (res) => (res.resume(), res.on('end', resolve))
    );
    req.on('error', (e) => {
      console.error(`Pet not reachable on port ${PORT} (${e.code}). Is it running? (npm start)`);
      process.exit(1);
    });
    req.end(body);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = { session_id: 'demo-a', cwd: 'C:/code/my-app' };
const B = { session_id: 'demo-b', cwd: 'C:/code/api-server' };
const ev = (s, hook_event_name, extra = {}) => post({ ...s, hook_event_name, ...extra });

(async () => {
  const steps = [
    ['session start', () => ev(A, 'SessionStart', { source: 'startup' }), 3000],
    ['prompt', () => ev(A, 'UserPromptSubmit', { prompt: 'add a login page' }), 3000],
    ['read', () => ev(A, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'C:/code/my-app/src/App.tsx' } }), 2500],
    ['edit', () => ev(A, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:/code/my-app/src/Login.tsx' } }), 2500],
    ['second session', () => ev(B, 'UserPromptSubmit', { prompt: 'fix the flaky test' }), 2500],
    ['bash', () => ev(B, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the test suite' } }), 3000],
    ['permission', () => ev(A, 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }), 6000],
    ['approved', () => ev(A, 'PostToolUse', { tool_name: 'Bash' }), 1500],
    ['B done', () => ev(B, 'Stop', { last_assistant_message: 'Fixed the flaky test: the retry helper was racing the mock clock. All **42 tests** pass now.' }), 4000],
    ['A asks', () => ev(A, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Should the login page use OAuth or email + password?' }] } }), 6000],
    ['A answered', () => ev(A, 'PostToolUse', { tool_name: 'AskUserQuestion' }), 1500],
    ['A done', () => ev(A, 'Stop', { last_assistant_message: 'Added `Login.tsx` with OAuth sign-in and wired it into the router. Run `npm run dev` to try it.' }), 4000],
    ['end B', () => ev(B, 'SessionEnd', { reason: 'exit' }), 2000],
    ['end A', () => ev(A, 'SessionEnd', { reason: 'exit' }), 0],
  ];
  for (const [label, fn, delay] of steps) {
    console.log(`→ ${label}`);
    await fn();
    await wait(delay);
  }
  console.log('demo finished');
})();
