// The optional local AI assistant's side of the pet window: answers in the speech bubble, its
// Allow/Deny questions, and the Copy / Undo buttons. The prompt bar itself is ask.html.
// It plugs into pet.js through `extras`; while the assistant is off, none of these events arrive.
(() => {
  const bubbleActions = document.createElement('div');
  bubbleActions.id = 'bubble-actions';
  bubbleEl.append(bubbleActions);

  let askId = 0;
  let askLabel = '';
  let askThinking = false; // waiting for the model's first words
  let confirmReq = null; // an Allow/Deny question, waiting for your click
  let answer = null; // the last finished answer { text, error, label, undo, paths, copy, until }

  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the bubble's own click close it
      onClick();
    });
    return b;
  }
  const div = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  };
  function copyButton(label, text) {
    const b = button(label, label === 'Copy' ? 'copy-inline' : 'deny', () => {
      api.copyText(text);
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = label), 1200);
    });
    return b;
  }

  // Answers stay up until clicked, unless main said they're trivial ("Opened Spotify." closes by
  // itself). Only "Claude needs you" or an Allow/Deny question can cover them, and they come back
  // after. `status` lines ("Searching…") show what the model is doing meanwhile.
  function showAnswer(text, streaming, error = false, label = askLabel, opts = {}) {
    if (bubble && bubble.kind === 'waiting' && Date.now() < bubble.until) return;
    if (bubble && bubble.kind === 'confirm') return;
    bubble = { kind: 'answer', text, prio: streaming ? 3 : 2.5, until: !streaming && opts.until ? opts.until : Infinity };
    bubbleProject.textContent = label;
    bubbleProject.style.display = '';
    renderText(bubbleText, text, streaming ? [] : opts.paths);
    bubbleActions.replaceChildren();
    if (opts.copy && !streaming && !error) bubbleActions.append(copyButton('Copy text', text));
    if (opts.undo && !streaming) {
      bubbleActions.append(
        button('Undo edit', 'deny', async () => {
          const r = await api.undoEdit(opts.undo);
          answer = { text: r.message, error: !r.ok, label, until: Date.now() + 4000 };
          showAnswer(r.message, false, !r.ok, label, answer);
        }),
      );
    }
    bubbleEl.className = `ui answer${error ? ' error' : ''}${opts.status ? ' status' : ''}`;
    fitUi(bubbleEl);
    bubbleText.scrollTop = bubbleText.scrollHeight;
    if (panelOpen) closePanel();
    reportBubble();
  }
  function restoreAnswer() {
    if (answer && answer.until && Date.now() > answer.until) answer = null;
    if (answer && !bubble && !panelOpen) showAnswer(answer.text, false, answer.error, answer.label, answer);
  }

  // The answer's text, with every path a tool found shown as code plus a small Copy button.
  // Everything goes in as text nodes: nothing the model writes is ever parsed as HTML.
  function renderText(el, text, paths = []) {
    el.replaceChildren();
    const list = (paths || []).flatMap((p) => [p, p.replace(/\\$/, '')]).filter(Boolean);
    let i = 0;
    while (i < text.length) {
      let best = null;
      let at = Infinity;
      for (const p of list) {
        const j = text.indexOf(p, i);
        if (j >= 0 && (j < at || (j === at && p.length > best.length))) (at = j), (best = p);
      }
      if (!best) {
        el.append(text.slice(i));
        break;
      }
      if (at > i) el.append(text.slice(i, at));
      const span = document.createElement('span');
      span.className = 'path';
      span.textContent = best;
      el.append(span, copyButton('Copy', best));
      i = at + best.length;
    }
  }

  // tells main where the bubble's top is, so the prompt bar can sit just above it
  let lastRect = '';
  function reportBubble() {
    requestAnimationFrame(() => {
      const visible = !!bubble && !bubbleEl.classList.contains('hidden');
      const top = visible ? Math.round(bubbleEl.getBoundingClientRect().top) : null;
      const key = visible + ':' + top;
      if (key === lastRect) return;
      lastRect = key;
      api.bubbleRect({ visible, top });
    });
  }

  // "Open Spotify?" [Deny] [Open]: the model's actions wait for this
  function showConfirm(req) {
    confirmReq = req;
    askThinking = false;
    waveUntil = Date.now() + 1200;
    bubble = { kind: 'confirm', prio: 4, until: Infinity };
    bubbleProject.textContent = req.label;
    bubbleProject.style.display = '';
    bubbleText.replaceChildren(div('c-title', req.title), div('c-target', req.target));
    if (req.diff) {
      const d = div('c-diff');
      for (const l of req.diff.del) d.append(div('del', `- ${l}`));
      for (const l of req.diff.add) d.append(div('add', `+ ${l}`));
      bubbleText.append(d);
    }
    if (req.warn) bubbleText.append(div('c-warn', req.warn));
    const reply = (allow) => {
      if (confirmReq !== req) return;
      confirmReq = null;
      api.confirmReply(req.cid, allow);
      bubble = null;
      if (allow) (askThinking = true), showAnswer('…', true);
      else hideBubble();
    };
    bubbleActions.replaceChildren(button('Deny', 'deny', () => reply(false)), button(req.allowLabel || 'Allow', 'allow', () => reply(true)));
    bubbleEl.className = 'ui answer confirm';
    fitUi(bubbleEl);
    if (panelOpen) closePanel();
    reportBubble();
  }

  // ---------- hooks into pet.js ----------
  Object.assign(extras, {
    mood: () => (confirmReq ? 'alert' : askThinking ? 'thinking' : null),
    bubbleShown() {
      bubbleActions.replaceChildren();
      reportBubble();
    },
    bubbleHidden(was) {
      reportBubble();
      // an answer covered by "Claude needs you" comes back once that's gone (deferred so the
      // session panel, which hides the bubble just before opening, can claim the spot first)
      if (was && was.kind !== 'answer' && answer) setTimeout(restoreAnswer, 0);
    },
    bubbleExpired(b) {
      if (b.kind === 'answer') answer = null; // a closing answer is gone for good
    },
    bubbleClick(b) {
      if (b && b.kind === 'confirm') return false; // only its buttons answer it
      // answers can be selected and scrolled; a plain click (no selection) closes them for good
      if (b && b.kind === 'answer') {
        if (String(window.getSelection())) return false;
        answer = null;
      }
      return true;
    },
    panelClosed: () => restoreAnswer(), // a kept answer comes back when the session list closes
  });
  // hovering an answer that would close by itself keeps it: you're reading it
  bubbleEl.addEventListener('mouseenter', () => {
    if (bubble && bubble.kind === 'answer' && bubble.until !== Infinity) {
      bubble.until = Infinity;
      if (answer) answer.until = null;
    }
  });

  // ---------- events from main ----------
  api.onAskConfirm(showConfirm);
  api.onAskConfirmClose(({ cid, allow }) => {
    // answered with Enter/Esc in the prompt bar, timed out, or replaced by a new question
    if (!confirmReq || confirmReq.cid !== cid) return;
    confirmReq = null;
    if (!bubble || bubble.kind !== 'confirm') return;
    bubble = null;
    if (allow) (askThinking = true), showAnswer('…', true);
    else hideBubble();
  });
  api.onAskNotice(({ message, ok }) => {
    answer = { text: message, error: !ok, label: askLabel || 'pet', until: Date.now() + 4000 };
    showAnswer(message, false, !ok, answer.label, answer);
  });
  api.onAskOpen(() => {
    // the input pops up right where the bubble goes: clear the way (a new question replaces the
    // old answer, and denies a question still waiting for Allow/Deny), wake up and wave
    if (confirmReq) api.confirmReply(confirmReq.cid, false), (confirmReq = null);
    answer = null;
    bubble = null;
    hideBubble();
    if (panelOpen) closePanel();
    lastEventAt = Date.now();
    waveUntil = Date.now() + 1200;
  });
  api.onAskStart(({ id, label }) => {
    askId = id;
    askLabel = label;
    askThinking = true;
    lastEventAt = Date.now();
    showAnswer('…', true);
  });
  api.onAskStream(({ id, text, status }) => {
    if (id !== askId) return;
    if (!status) askThinking = false; // status lines keep the thinking face; real words end it
    showAnswer(text, true, false, askLabel, { status });
  });
  api.onAskEnd(({ id, text, error, undo, paths, copy, autoClose }) => {
    if (id !== askId) return;
    askThinking = false;
    lastEventAt = Date.now();
    if (confirmReq) confirmReq = null;
    if (bubble && bubble.kind === 'confirm') bubble = null;
    answer = { text: error || text, error: !!error, label: askLabel, undo, paths, copy, until: autoClose ? Date.now() + autoClose : null };
    showAnswer(answer.text, false, answer.error, askLabel, answer);
    if (!error) happyUntil = Date.now() + 1200;
  });
})();
