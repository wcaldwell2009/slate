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
- Claude gets **browser tools** (`read_page`, `fill_field`, `click_element`, `press_key`, `screenshot`, `navigate`, `list_tabs`, `switch_tab`), **document tools** (`save_document` / `list_documents` / `read_document`, sandboxed to `~/Documents/Browser Copilot` — the **Documents** view shows what it makes), and **Read** for files you attach with the paperclip (text, images, PDFs). Bash/Write/Edit and everything else stay disabled.
- Filling uses native value setters + `input`/`change` events, so React/Vue/Angular forms register it.

## Setup

Requirements: Node 18+, Google Chrome, and either a logged-in Claude Code install or `ANTHROPIC_API_KEY` in your environment.

```bash
cd browser-copilot
npm install
npm start          # → http://localhost:4321
```

## Putting it on another computer

Clone it where Slate looks for it — a "Browser Copilot" folder on the Desktop — then install:

```bash
git clone https://github.com/wcaldwell2009/browser-copilot "$HOME/Desktop/Browser Copilot/browser-copilot"
cd "$HOME/Desktop/Browser Copilot/browser-copilot"
npm install
```

Slate's Copilot tab takes it from there (its Start button launches the server). Needs Node 18+, Opera (or Chrome/Edge — it finds whichever is installed, on Windows and Mac both), and a logged-in Claude Code. On a fresh machine the copilot's browser profile starts empty; log into sites once in its window and they're remembered.

## Connecting Chrome

Claude talks to the browser over the DevTools port (9222). The copilot drives **Opera** when it's installed (Chrome as fallback). One engine rule to know: Chromium 136+ refuses the debugging port on a browser's **default profile**, so no tool can attach to your everyday browser window — the copilot uses a dedicated profile instead (`~/.browser-copilot-opera`, seeded once with a copy of the real Opera profile: same logins, bookmarks and saved session).

- Click **Launch Opera** in the UI (appears when nothing is connected). A real, visible Opera window opens with your stuff in it — browse there when using the tool, or drive it from the **Tab** view (live, clickable) without ever looking at the window. **＋ New tab** in the viewer opens tabs too.
- Launching that profile by hand works the same:

```bash
"$HOME/Applications/Opera.app/Contents/MacOS/Opera" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.browser-copilot-opera"
```

Then pick the tab in the dropdown and chat.

## Behavior & safety

- Claude fills fields freely but is instructed **not to click Submit / Send / Buy / etc. unless you explicitly ask**.
- It only uses information you gave it or that's visible on the page — if something's missing it asks instead of inventing.
- The Claude session runs with `bypassPermissions`, but the only tools it has are the browser tools above — no shell, no file access.
- **Stop** interrupts the current turn; **New chat** starts a fresh session. Conversations are saved to disk (`~/.browser-copilot-chats`) and come back — with Claude's memory — after page reloads and server restarts. Each chat also remembers which browser tab it was pinned to, and the app reopens on the chat and view you left. Closing a chat with ✕ is what deletes it.

## Speed & model

Built for minimal model round-trips: every message carries a fresh page snapshot (so Claude usually acts without a `read_page` call), multi-field fills happen in one `fill_many` call, and fill results double as verification. A typical "fill this form" turn is one tool call, ~5–8 seconds.

Default model is Sonnet (measured fastest for this workload). The picker in the header switches between Sonnet, Opus and Haiku — the choice is saved and applies to chats started after the change. `COPILOT_MODEL` still works as the fallback default.

## Limitations

- Fields inside cross-origin iframes (some payment widgets) aren't reachable.
- If a page reloads mid-task, Claude re-reads it (element ids reset) — it knows to do this.
- One chat = one browser; the tab selector lists tabs of the DevTools-enabled Chrome only.
