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
- Claude gets **browser tools** (`read_page`, `fill_field`, `click_element`, `press_key`, `screenshot`, `navigate`, `list_tabs`, `switch_tab`), **pixel tools** for pages that are just a picture — a browser-based remote desktop (Guacamole, noVNC), a virtual lab, a game, a PDF or drawing canvas — where it looks with `screenshot` and acts by coordinate with `click_at`, `move_mouse`, `drag`, `scroll_at`, `type_text` (real keystrokes) and `press_key` (combos like `ctrl+alt+Delete`), pausing with `wait` while the remote screen redraws; `screenshot` with `save: true` also drops a full-resolution PNG on your Desktop (ask for "a screenshot of this tab" and it will). Plus **file tools**: `read_file` opens a file you attach with the paperclip — including Word (.docx), PowerPoint (.pptx) and Excel (.xlsx), which the built-in Read tool cannot; `save_document` / `list_documents` / `read_document` make and manage files in `~/Documents/Browser Copilot` (the **Documents** view shows them), and a `.docx` name writes a real Word file. To **edit** an uploaded Word file it uses `edit_docx`, which changes the original file's own XML by numbered paragraph — fonts, lists, tables and existing pictures all survive — and can drop pictures in (`insert_image`). `capture_image` grabs a picture of the selected tab (optionally cropped to a region, or the whole scrollable page) into `images/` for use in documents. `make_pdf` turns HTML + CSS that Claude writes into a real PDF via a separate hidden headless browser (own port and throwaway profile, scripts off — never the copilot's Opera); that is also how it copies an uploaded PDF's layout with screenshots added. The HTML is kept in `sources/` so a PDF can be changed and remade. Finished files come back in the chat as a card with Preview / Open. PDFs and images are read with **Read**. `npm run check:docs:live` runs both flows end to end on a throwaway rig (~$1). **Memory:** a chat that comes back after a restart or the 3-hour idle reaper RESUMES its saved Claude Code session (id kept in the chat file), so files read and tool results are still there; the text replay is only the fallback. `remember` / `recall` / `forget` keep project notes in `~/.browser-copilot-memory.json` (`COPILOT_MEMORY`), shared by every chat and put in each session's prompt along with the other recent chats and their attached files; `search_chats` searches every transcript. Sessions run with `settingSources: []` so no CLAUDE.md or personal hooks load. `npm run check:memory:live` (~15c haiku) proves it across a restart and a new chat. Bash/Write/Edit and everything else stay disabled.
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

## Checks

- `npm run check:pixel` — 28 checks of the pixel tools against a throwaway headless browser on its own port and profile, with a canvas page that records every event it receives and a temp Desktop. Never touches the real browser on 9222.
- `npm run check:pixel:live` — one real Claude turn (Haiku, about 15 cents) through a throwaway copilot server on that rig: a fake remote-desktop login screen, "click the Username box, type student42, save a screenshot called lab proof". Proves the tools register with the SDK and the loop look → click → type → look works.

## Limitations

- Fields inside cross-origin iframes (some payment widgets) aren't reachable.
- If a page reloads mid-task, Claude re-reads it (element ids reset) — it knows to do this.
- One chat = one browser; the tab selector lists tabs of the DevTools-enabled Chrome only.
