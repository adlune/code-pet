// Helpers that turn raw Claude Code hook payloads into short, human text.
const fs = require('fs');
const path = require('path');

const oneLine = (s, n = 48) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const base = (p) => (p ? path.basename(String(p)) : 'a file');
const host = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return oneLine(u, 30);
  }
};

function describeTool(name, input = {}) {
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `✎ editing ${base(input.file_path)}`;
    case 'Write':
      return `✎ writing ${base(input.file_path)}`;
    case 'NotebookEdit':
      return `✎ editing ${base(input.notebook_path)}`;
    case 'Read':
      return `reading ${base(input.file_path)}`;
    case 'Bash':
    case 'PowerShell':
      return input.description ? `› ${oneLine(input.description)}` : `› ${oneLine(input.command, 40)}`;
    case 'Grep':
      return `searching for "${oneLine(input.pattern, 28)}"`;
    case 'Glob':
      return `looking for ${oneLine(input.pattern, 30)}`;
    case 'WebFetch':
      return `browsing ${host(input.url)}`;
    case 'WebSearch':
      return `searching the web: ${oneLine(input.query, 36)}`;
    case 'Task':
    case 'Agent':
      return `delegating: ${oneLine(input.description || 'a subtask', 36)}`;
    case 'TodoWrite':
      return 'updating the plan';
    default:
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return `using ${(parts[2] || parts[1] || 'a tool').replace(/_/g, ' ')}`;
      }
      return `using ${name || 'a tool'}`;
  }
}

// Make Claude's final message bubble-sized: strip markdown, keep the first sentence or two.
function summarize(text, n = 150) {
  if (!text) return '';
  let t = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[#>*-]+\s*/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return stop > 60 ? cut.slice(0, stop + 1) : cut.slice(0, n - 1).trimEnd() + '…';
}

const isRealUserPrompt = (o) => {
  if (o.type !== 'user' || o.isSidechain || !o.message) return false;
  const c = o.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((x) => x.type === 'text') && !c.some((x) => x.type === 'tool_result');
};

// Last assistant text of the current turn, read from the tail of the transcript JSONL.
async function lastAssistantText(transcriptPath) {
  const st = await fs.promises.stat(transcriptPath);
  const size = Math.min(st.size, 1024 * 1024);
  const fh = await fs.promises.open(transcriptPath, 'r');
  const buf = Buffer.alloc(size);
  try {
    await fh.read(buf, 0, size, st.size - size);
  } finally {
    await fh.close();
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type === 'assistant' && !o.isSidechain && o.message && Array.isArray(o.message.content)) {
      const t = o.message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      if (t) return t;
    }
    if (isRealUserPrompt(o)) break; // don't reach back into the previous turn
  }
  return '';
}

module.exports = { describeTool, summarize, lastAssistantText };
