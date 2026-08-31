# Browser Copilot

Chat with a headless Claude Code session that can **see your Chrome tabs and fill things in for you**. Pick a tab in the UI, then just talk: *"fill in this form — my name is Sam Rivera, sam@example.com"*.

## How it works

```
┌─────────────┐   WebSocket   ┌──────────────┐  Agent SDK   ┌──────────────────┐
│  Chat UI    │ ────────────► │  server.js   │ ───────────► │ headless Claude  │
│ (browser)   │ ◄──────────── │  (Node)      │ ◄─────────── │ Code session     │
└─────────────┘               └──────┬───────┘   MCP tools  └──────────────────┘
                                     │ Chrome DevTools Protocol (port 9222)
                                     ▼
                              your Chrome tabs
```

- The **UI** (http://localhost:4321) has a sidebar of chats, a tab selector, and a chat pane. Each chat is pinned to its own browser tab and runs its own Claude session — add more chats with **＋ New chat** to work several tabs **in parallel** (a spinner in the sidebar shows which chats are busy).
- Each chat runs a persistent **headless Claude Code session** via the Claude Agent SDK — it keeps context across messages like a normal chat.
- Claude gets **browser tools only** (`read_page`, `fill_field`, `click_element`, `press_key`, `screenshot`, `navigate`, `list_tabs`, `switch_tab`); the default file/bash tools are disabled.
- Filling uses native value setters + `input`/`change` events, so React/Vue/Angular forms register it.

## Setup

Requirements: Node 18+, Google Chrome, and either a logged-in Claude Code install or `ANTHROPIC_API_KEY` in your environment.

```bash
cd browser-copilot
npm install
npm start          # → http://localhost:4321
```

## Connecting Chrome

Claude talks to Chrome over the DevTools port (9222). Chrome 136+ doesn't allow that on your default profile, so Browser Copilot uses a **separate Chrome profile** (`~/.browser-copilot-chrome`):

- Click **Launch Chrome** in the UI (appears when no Chrome is connected). It starts **invisibly — no window anywhere**. Use the **Tab** view (top bar) to see the pages live and click/type in them, and its **＋ New tab** button to open tabs; the viewer is the only place these tabs exist. Log in to sites through the viewer as needed; the profile remembers logins between runs.
- If a picky site fights the windowless browser (extra captchas, fussy logins), launch a visible one yourself instead — everything else works the same:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.browser-copilot-chrome"
```

Then pick the tab in the dropdown and chat.

## Behavior & safety

- Claude fills fields freely but is instructed **not to click Submit / Send / Buy / etc. unless you explicitly ask**.
- It only uses information you gave it or that's visible on the page — if something's missing it asks instead of inventing.
- The Claude session runs with `bypassPermissions`, but the only tools it has are the browser tools above — no shell, no file access.
- **Stop** interrupts the current turn; **New chat** starts a fresh session (clears Claude's memory).
- Per-turn API cost shows under the composer after each response.

## Speed & model

Built for minimal model round-trips: every message carries a fresh page snapshot (so Claude usually acts without a `read_page` call), multi-field fills happen in one `fill_many` call, and fill results double as verification. A typical "fill this form" turn is one tool call, ~5–8 seconds.

Default model is Sonnet (measured fastest for this workload). Override per run with `COPILOT_MODEL=opus npm start` (or `haiku`, or a full model id).

## Limitations

- Fields inside cross-origin iframes (some payment widgets) aren't reachable.
- If a page reloads mid-task, Claude re-reads it (element ids reset) — it knows to do this.
- One chat = one browser; the tab selector lists tabs of the DevTools-enabled Chrome only.
