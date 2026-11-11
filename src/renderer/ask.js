// The little "ask the pet" input. It lives in its own small window (the pet's window never takes
// keyboard focus); main shows it above the pet. After you send a question it stays open (above the
// answer bubble) until the answer is in, so the keyboard keeps working:
//   typing   – Enter sends, Esc closes
//   busy     – Esc cancels the question
//   confirm  – Enter = Allow (Open / Run / Save edit), Esc = Deny
// Clicking anywhere else closes it; the mouse buttons in the bubble keep working either way.
const api = window.pet;
const form = document.getElementById('ask');
const input = document.getElementById('ask-input');
const chip = document.getElementById('ask-model');
const hint = document.getElementById('ask-hint');
let open = false;
let mode = 'typing';

function setMode(m, allowLabel) {
  mode = m;
  input.readOnly = m !== 'typing';
  form.classList.toggle('busy', m !== 'typing');
  form.classList.toggle('confirming', m === 'confirm');
  hint.textContent = m === 'busy' ? 'Esc cancel' : m === 'confirm' ? `Enter ${allowLabel || 'Allow'} · Esc Deny` : '';
}

api.onAskOpen(({ label }) => {
  chip.textContent = label;
  input.value = '';
  setMode('typing');
  form.className = 'ui';
  open = true;
  input.focus();
});
api.onAskMode(({ mode: m, allowLabel }) => open && setMode(m, allowLabel));

function close() {
  if (!open) return;
  open = false;
  form.className = 'ui hidden';
  api.askClose();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (mode !== 'typing') return;
  const q = input.value.trim();
  if (!q) return close();
  setMode('busy');
  api.askSubmit(q);
});
input.addEventListener('keydown', (e) => {
  if (mode === 'confirm') {
    if (e.key === 'Enter') e.preventDefault(), api.confirmKey(true);
    else if (e.key === 'Escape') api.confirmKey(false);
  } else if (mode === 'busy') {
    if (e.key === 'Escape') api.askCancel();
    if (e.key === 'Enter') e.preventDefault();
  } else if (e.key === 'Escape') close();
});
window.addEventListener('focus', () => open && input.focus());
window.addEventListener('blur', close); // clicked or switched away
