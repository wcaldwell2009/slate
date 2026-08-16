# Slate

A simple, private school tracker that runs on your own computer. It pulls your
work from Canvas, cleans it up, and lays out what to do today, this week, your
projects, tests, grades, and Canvas emails.

Everything stays on your machine. Nothing is uploaded anywhere. Slate never
submits anything to Canvas — it only reads.

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

## Working on Slate itself
`Start Slate.bat` runs the **workshop copy** straight out of this folder on
http://localhost:4173, with its own sample data. It's for trying changes out —
it has no Quit button and it can't touch the installed app or its data. Nothing
you do there reaches the real Slate until `npm run push` builds a new version and
installs it.

## Right now: sample data
School hasn't started, so Slate is loaded with **realistic sample classes,
assignments, projects, tests, and grades** so you can try every page. The top
bar says "Sample data".

## Connecting your real Canvas (later)
1. In Canvas: Account → Settings → "New Access Token" → copy the token.
2. In this folder, copy `.env.example` to `.env` and fill in:
   - `CANVAS_BASE_URL` — e.g. `https://yourschool.instructure.com`
   - `CANVAS_API_TOKEN` — the token you copied
3. Restart Slate and click **Sync now**. It'll pull your real classes.

Optional: put an `ANTHROPIC_API_KEY` in `.env` and Slate will use Claude to
categorize and summarize assignments more smartly. Without it, Slate uses
built-in rules — both work.

## Daily automatic sync (optional)
Once real Canvas is connected, right-click **`setup-daily-sync.ps1`** → "Run with
PowerShell" to have Slate quietly pull new work every morning.

## The pages
- **Today** — what's due today. Mark things done, or open one for its steps and a
  focus timer. Sort by due date or by grade impact.
- **Week** — everything across the next 7 days.
- **Projects** — big work, auto-paced into daily chunks around your other work.
- **Tests** — study progress, a study timer, and auto-made flashcards.
- **Classes** — grades per class and your overall GPA.
- **Email** — Canvas notifications, cleaned up.
