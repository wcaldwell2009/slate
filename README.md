# Slate

A simple, private school tracker that runs on your own computer. It pulls your
work from Canvas, cleans it up, and lays out what to do today, this week, your
projects, tests, grades, and Canvas emails.

Everything stays on your machine — your schoolwork, your drafts, your notes and
your Canvas token never leave it. There is no website and no account.

**Slate never writes your assignments for you.** It organizes and paces the
work; you do the work. It can hand a finished piece in to Canvas, but only when
you press Send yourself — nothing is ever submitted automatically.

## Installing it
Double-click **`Install Slate.bat`** once. It puts a **Slate** icon on your
Desktop. From then on, that icon is the app — double-click it and Slate opens in
its own window. Quit it with the **Quit Slate** button at the bottom of the
sidebar.

Run `Install Slate.bat` again any time to update to the newest version. It only
ever replaces the app itself — your assignments, drafts, notes, study history and
Canvas settings live in a separate folder and are never touched.

The installed app lives in `%LOCALAPPDATA%\Slate` (app in `app\`, your stuff in
`data\`) and runs on http://localhost:4174.

## Connecting Canvas
Slate starts **empty**. Nothing appears until you connect Canvas.

1. In Canvas: Account → Settings → "New Access Token" → copy the token.
2. In Slate, open the **API** tab in the sidebar.
3. Paste your Canvas address (e.g. `https://yourschool.instructure.com`) and the
   token, then Save.

Slate checks the token with Canvas before saving it, then syncs straight away.
The token is stored with your data, not in the app folder, so updating Slate
never disconnects you. Only the last four characters are ever shown back to you.

**Slate re-checks Canvas every hour while it's open**, so new work turns up on
its own. **Sync now** at the bottom of the sidebar forces it.

## The pages
- **Today** — what's due today, plus anything you didn't finish yesterday, and a
  2-hour plan for the day. Unfinished / Finished switcher, and a sort by due date
  or grade impact. A quiet day pulls a little work forward.
- **Week** — the next 7 days. Click a day to see everything on it.
- **Projects** — big work. Slideshow projects get a slide builder that exports a
  real PowerPoint; essays get a writing editor with an outline, a live page
  count, and a "Get unstuck" coach that tells you what a section needs to do
  without ever writing it for you.
- **Tests & Quizzes** — study timer, flashcards and notes, with a 1–4 week or
  All time-frame picker. Drop a notes file on a test and Slate turns it into
  flashcards.
- **Classes** — grade per class, the Formative and Summative halves, your GPA,
  and a Notes tab where you can photograph your handwritten notes and have them
  typed up and turned into flashcards.
- **Email** — Canvas messages, cleaned up, with full text and attachments.
- **API** — connect Canvas (above), plus an optional GPTZero key.
- **Admin** — accounts. Sign-in stays off until there's a second account and you
  have a password of your own, so adding someone can't lock you out.

## Working on an assignment
Open any assignment for a plain-English **Instructions** checklist — Slate reads
the description *and* any file the teacher attached, and rewrites it as short
steps. Attached files are listed on the page and open in whatever program your
computer uses for them.

Typed work gets a real editor with a Canvas-style toolbar. It autosaves, keeps a
version history as you write, and tells you roughly how many pages it'll be in
Word. When you're done, **hand it in**: you get a preview of the exact document
or slide deck, then either **Save to my Desktop** or **Submit to Canvas**.
Written work comes out as proper MLA — Times New Roman 12, double spaced, with
your heading filled in.

## Working on Slate itself
`Start Slate.bat` (or `npm start`) runs the **workshop copy** straight out of
this folder on http://localhost:4173, with its own separate data. It's for trying
changes out — it has no Quit button and it can't touch the installed app or its
data. Nothing you do there reaches the real Slate until `npm run push` builds a
new version and installs it.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm start` | Run the workshop copy on port 4173 |
| `npm test` | Smoke tests (~5s) |
| `npm run drive` | Full sweep — every page, button and endpoint (~90s) |
| `npm run shots` | Screenshots every screen in a real browser into `dist/shots` |
| `npm run push` | Build a new version and install it over the Desktop app |
| `npm run clear` | Wipe Canvas-derived data (leaves accounts and your token) |

The code is backed up privately at **github.com/wcaldwell2009/slate**. Your data
folder, database and `.env` are excluded and never get uploaded.

## Requirements
Node 22 or newer — Slate uses Node's built-in SQLite and HTTP, and has **zero
npm dependencies**. Nothing to install, nothing to compile.

The AI bits (simplified instructions, flashcards from notes, the writing coach,
reading PDF attachments) use Claude Code in a hidden window, so they need Claude
Code installed and signed in. Without it, Slate falls back to built-in rules and
everything still works. `SLATE_NO_AI=1` turns them off entirely.

The app runs on macOS and Linux too, but the Desktop icon, the installer and the
app-style window are Windows-only — elsewhere you'd run `npm start` and open
http://localhost:4173 in a browser.
