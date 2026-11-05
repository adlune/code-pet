#!/usr/bin/env node
// Adds (or with --uninstall removes) the Claude Pet hooks in ~/.claude/settings.json.
// Idempotent; backs up the settings file before writing; leaves other hooks untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const uninstall = process.argv.includes('--uninstall');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const hookScript = path.resolve(__dirname, '..', 'hooks', 'pet-hook.js').replace(/\\/g, '/');
const nodeBin = process.execPath.replace(/\\/g, '/');
const command = `"${nodeBin}" "${hookScript}"`;
const MARKER = 'pet-hook.js';

// event -> matcher (null = event has no matcher)
const EVENTS = {
  SessionStart: null,
  SessionEnd: null,
  UserPromptSubmit: null,
  PreToolUse: '*',
  PostToolUse: '*',
  Notification: null,
  Stop: null,
};

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8');
  settings = raw.trim() ? JSON.parse(raw) : {};
  const backup = `${settingsPath}.claude-pet-backup`;
  if (!fs.existsSync(backup)) {
    fs.writeFileSync(backup, raw); // keep the pristine pre-pet copy; never overwrite it
    console.log(`Backed up settings to ${backup}`);
  }
} else {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
}

const isOurs = (group) => (group.hooks || []).some((h) => String(h.command || '').includes(MARKER));
settings.hooks = settings.hooks || {};

// Always strip old entries first so re-running updates paths.
for (const event of Object.keys(settings.hooks)) {
  settings.hooks[event] = (settings.hooks[event] || []).filter((g) => !isOurs(g));
  if (!settings.hooks[event].length) delete settings.hooks[event];
}

if (!uninstall) {
  for (const [event, matcher] of Object.entries(EVENTS)) {
    // async: runs in the background, so Claude Code never waits on the pet.
    const group = { hooks: [{ type: 'command', command, async: true }] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[event] = settings.hooks[event] || []).push(group);
  }
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(
  uninstall
    ? 'Removed Claude Pet hooks.'
    : `Installed Claude Pet hooks for: ${Object.keys(EVENTS).join(', ')}\n  ${command}\nNew Claude Code sessions will talk to the pet.`
);
