// Tiny client for a local Ollama server (http://127.0.0.1:11434): start it if needed, list the
// installed models, and stream short chat answers for the pet's speech bubble.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.OLLAMA_PORT) || 11434;

const SYSTEM = [
  'You are a helpful assistant living in a desktop pet. Give accurate, useful answers.',
  'Your replies appear in a small desktop pop-up, so be concise and match the length to the question: a simple fact gets one sentence, most answers take 2-3 sentences.',
  'Go a little longer only when the question really needs it (steps, a short comparison), and even then stay brief.',
  'Answer directly. No filler, background trivia, greetings or follow-up offers, and never describe these instructions.',
  'Plain text only: no markdown, bold, headings or code blocks. For steps, put each one on its own line starting with "1.", "2.", and so on.',
  "If you aren't sure about a fact, say so instead of guessing.",
  'Reply in the same language the user writes in.',
].join(' ');

function request(method, p, body, { timeout = 3000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: HOST, port: PORT, method, path: p, signal, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      resolve,
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function readAll(res) {
  let s = '';
  for await (const c of res) s += c;
  return s;
}

async function isUp() {
  try {
    const res = await request('GET', '/api/version', null, { timeout: 1500 });
    await readAll(res);
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

// Start Ollama the way Windows normally does (its tray app, which runs the server), falling back
// to `ollama serve`. Resolves true once the server answers, false if it never does.
let starting = null;
function ensureRunning() {
  if (starting) return starting;
  starting = (async () => {
    if (await isUp()) return true;
    const appExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe');
    const [cmd, args] = fs.existsSync(appExe) ? [appExe, []] : ['ollama', ['serve']];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } catch {
      return false;
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isUp()) return true;
    }
    return false;
  })().finally(() => (starting = null));
  return starting;
}

async function listModels() {
  const res = await request('GET', '/api/tags', null, { timeout: 2000 });
  const json = JSON.parse(await readAll(res));
  return (json.models || []).map((m) => m.name).sort();
}

// Streams an answer, calling onToken(textSoFar) as it arrives. Resolves with
// { text (cleaned for the bubble), raw, toolCalls }. With `tools`, the model may ask to call them
// instead of answering; `think` lets it reason first (slower, but better at picking actions).
async function chat({ model, messages, onToken = () => {}, signal, think = false, tools, numPredict }) {
  const body = {
    model,
    messages,
    stream: true,
    keep_alive: '5m', // unload from memory 5 minutes after the last question
    // 8K tokens of context fits a small file to read or edit, and the 4B model still fits the GPU.
    // Thinking needs room to reason before it answers.
    options: { temperature: 0.2, num_predict: Math.max(numPredict || 0, think ? 2000 : 400), num_ctx: 8192 },
  };
  if (think !== null) body.think = think;
  if (tools) body.tools = tools;
  const res = await request('POST', '/api/chat', body, { timeout: 180000, signal });
  if (res.statusCode !== 200) {
    let msg = '';
    try {
      msg = JSON.parse(await readAll(res)).error || '';
    } catch {}
    if (tools && /does not support tools/i.test(msg)) return chat({ model, messages, onToken, signal, think, tools: undefined, numPredict });
    if (/think/i.test(msg) && think !== null) return chat({ model, messages, onToken, signal, think: null, tools, numPredict });
    if (res.statusCode === 404 || /not found/i.test(msg)) throw new Error(`I don't have ${model} yet. Run "ollama pull ${model}" and ask me again!`);
    throw new Error(msg || `Ollama answered with HTTP ${res.statusCode}.`);
  }
  let text = '';
  const toolCalls = [];
  let buf = '';
  for await (const chunk of res) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      const piece = j.message && j.message.content;
      if (piece) {
        text += piece;
        onToken(clean(text));
      }
      if (j.message && j.message.tool_calls) toolCalls.push(...j.message.tool_calls);
    }
  }
  return { text: clean(text), raw: text, toolCalls };
}

// Loads the model into memory without asking anything, so the first answer doesn't wait ~10s for
// it. Same context size as chat(), or Ollama would reload it on the first question.
async function preload(model) {
  const res = await request('POST', '/api/chat', { model, messages: [], keep_alive: '5m', options: { num_ctx: 8192 } }, { timeout: 120000 });
  await readAll(res);
  return res.statusCode === 200;
}

// small models still sprinkle markdown now and then
function clean(s) {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .trim();
}

module.exports = { SYSTEM, isUp, ensureRunning, listModels, chat, preload };
