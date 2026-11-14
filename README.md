<p align="center"><img src="attachments/cat.gif" alt="the black cat typing on its laptop, then hopping happily" width="250"></p>

# code-pet

A simple desktop pet built using Electron. It notifies when the session stops, needs approval, background tasks, active sessions, etc. Built for Claude Code.

## Setup

```bash
npm install
npm run install-hooks
```

## Run from shortcut

```bash
npm run shortcut
```

to remove: `npm run shortcut -- --remove`.

## Local AI assistant (optional, Windows)

It uses an [Ollama](https://ollama.com) local model.

```bash
ollama pull [model] (e. g. qwen3.5:4b)
```

and turn on **Local AI assistant** in the tray menu. Press **Ctrl+Alt+P** to give a prompt.

This local AI is designed to answer general questions, help you find your files and directories, open apps, use your clipboard, look at your screen (when you ask) and give you feedback and do light edits in text files. Everything's local, so nothing goes online.

Safety rules:

- Every open, launch and edit asks **Allow / Deny**. 
- Edits show a difference, are backed up, and can be undone.
- Files are only read or edited in Documents, Desktop, Downloads, Pictures, Music and Videos. It doesn't touch sensitive paths or files.
- It doesn't run scripts, shortcuts or installers, and can't delete, move or rename files.
- If it wants to act on something you never named after reading a file, your clipboard or your screen, it warns that it may contain planted instructions.

**npm run eval** runs a model benchmark on 30 tasks (finding, opening, editing, clipboard, prompt injection, etc.) with simulated files and apps. qwen3.5:4b passes 30/30 on my PC.

## Uninstall

```bash
npm run uninstall-hooks
```

removes only the pet's hooks.

## About

Made by Adrian Lara ([contact@adrianlara.dev](mailto:contact@adrianlara.dev)). Released under the [MIT License](LICENSE).
