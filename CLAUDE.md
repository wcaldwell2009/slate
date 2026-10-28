# Slate — School Tracker App — Project Handoff

## Last Updated
2026-10-28 (round 75 — copilot edits Word files in place, makes PDFs, captures pictures for them)

## What this project is
Slate is a **local desktop app** that helps Will with school work. **As of
round 74 it is a set of tools, not a Canvas dashboard.** The sidebar has four
sections — **Documents** (write a paper), **Slideshows** (make a PowerPoint),
**Copilot** (drive a browser), **Watermarks** — plus **Canvas** (connect) and
**Admin** as small utilities at the bottom. In Documents/Slideshows you make a
project, pick the Canvas class + assignment it is for (which pulls the
instructions in), talk to the on-page Claude about it, and hand it in. Projects
save and are listed to come back to. Everything runs and stores on Will's own
computer — no website, no cloud, no account. Personal use only.

**The old dashboard is gone from the UI but not from the code.** Today, Week,
Tests & Quizzes, Classes and Email were removed from the sidebar and the router
(round 74). Their render functions (`renderToday`/`renderWeek`/`renderTests`/
`renderClasses`/`renderEmail` etc.) and ALL their API routes/queries still exist
— sync still needs `classes()`, and the Canvas assignment picker needs the
per-class assignment list — they are just no longer routed to. Canvas sync still
runs hourly to keep classes + assignment instructions available for the picker.

Hard rules from the spec: **never** auto-write assignments, never run an "AI
detector evasion" pass, never auto-submit work to Canvas. Slate only organizes
and paces — Will always does the actual work.

## People
- **Will** — owner/operator, non-technical. The only user today; as of round 20
  he wants friends to be able to sign in from their own laptops (see round 20 —
  the accounts exist, the sharing does not).

## Current Status
**Installed as a real app on Will's machine; 49 rounds of features done (through 2026-08-15).**
`npm test` = 74 tests, all green. `npm run drive` = 825 end-to-end checks; `npm run shots` = 21 real-browser screenshots
(`drive:all` adds 40 live-Claude checks; `drive:loop` re-runs on every save) — all green.
**School started 2026-08-12. Will's real Canvas IS connected**
(jcseagles.instructure.com, token in the settings table). All sample data was
deleted in round 23 — Slate starts empty and only fills from real Canvas. Nothing outstanding/broken. See round notes below + CHANGES.md
for the full feature list. Highlights beyond the original 9:
- Assignments open as FULL PAGES (not popups); type-here editor with autosave;
  guide pages with simplified instructions + steps.
- Essay projects open a real editor: autosave, word/char/reading-time counts,
  clickable paragraph outline, and a "Get unstuck" writing coach (hidden Claude
  Code) that gives direction on the stuck section — never writes the prose.
- Downloads: popup with editable filename + file-type dropdown; saves to Desktop.
  Text → txt/docx/pdf, slideshows → pptx/html/txt. Real Office files, zero deps.
- Slideshow builder: auto-detects slideshow projects, auto-builds the outline
  (picks a subject, honors "N slides"), fills headers; editable pre-filled title
  slide; exports a styled PPTX (bullet cards, no photos, optional picture space
  per slide). Verified in real PowerPoint.
- Tests: drag a notes file onto a test → hidden Claude Code reads it into
  flashcards + notes; Flashcards/Notes switcher; study log (2h/30m goal).
- Every work page: plain-text "Instructions" checklist, AI-simplified.
- Focus timers only on the tests page (study timer). Removed everywhere else in round 15.
- AI features use Claude Code in a hidden terminal (no API key needed) with
  rule-based fallbacks; SLATE_NO_AI=1 turns them off.

## NEVER WRITE TO WILL'S LIVE DATA — read this first
Port **4173** and **`data/slate.db`** are production. They hold Will's real
schoolwork.

**Verification scripts must not write to them.** No POSTing drafts, no seeding,
no `UPDATE`. Reads are fine — use them to confirm a page loads or to read state
back. Anything that exercises a write path gets a throwaway server with its own
`SLATE_DB_PATH` and `CANVAS_MODE=mock` (see the "one awkward class" and
"lookahead" tests for the pattern).

This has bitten twice:
- Round 24: a test called `sync()` in the runner process, which resolves the
  DEFAULT db path — it wiped and re-synced his real Canvas on every `npm test`.
- Round 34: a script POSTed filler to `/api/assignments/:id/draft` on 4173 to
  check the page preview. It picked the first typed assignment, which was his
  real Summer Reading Assignment, and **destroyed 343 words of his homework**.
  Recovered only because `draft_snapshots` had a copy.

`draft_snapshots` is the safety net that saved it. Keep it working.

**Round 51 — Ask Claude on every assignment page (2026-08-16).**
`src/assignmentChat.js`, `chat_messages` table, `chatWidget()` in app.js,
routes under `/api/assignments/:id/chat`.

**It is a support-desk widget in the bottom-right corner**, not a section down
the page — Will asked for that shape specifically. A launcher pill expands into
a fixed 374px panel in the same corner.

**`body.chat-open` reserves a 396px lane and THAT is the load-bearing part.**
Will's words were "still in the corner and doesn't cover up the assignment", so
the layout gains a right-hand gutter while the panel is open and the page
reflows out from under it rather than hiding behind it. `.app` is
`max-width: 980px` next to a 208px sidebar, so on anything narrower than about
1580px a floating panel WOULD overlap the work. Under 860px there is no lane to
give: the panel goes full width along the bottom instead.

**The lane has to be released on the way out.** `setChatLane(false)` runs in
`render()`'s teardown beside `pageTimer`/`pageChat`, or every other view renders
with a gap down its right-hand side. Drive checks pin open, close and navigate.

**Open/shut lives in `state.chatOpen`, not in the DOM.** The widget is built
inside `#app` and destroyed on every render like everything else; holding the
flag in state is what keeps the panel open while the page under it re-renders.
`position: fixed` does not care who its parent is.

The launcher's speech bubble is **drawn as inline SVG, not an emoji** — round 24
took every emoji out of Slate, and 💬 renders as a grey blob on the sage pill.
The drive harness's no-emoji check now covers the work page too, which is what
would have caught it.

`npm run shots` pins the capture to the viewport when the chat panel is open,
for the same reason it already did for the hand-in overlay: a fixed element
stretched to the scroll height of the page behind it comes out as a stamp.

**Round 51b — proofreading: the chat can change the draft (2026-08-16).**
`src/proofread.js`. Will asked for Grammarly-style fixes from the chat. He was
offered a reviewable "Check my writing" pass instead and **chose the chat doing
it directly**, having been told in the option text that write access is also the
route a ghostwriter would take.

**ROUND 51c — WILL REMOVED THE GUARDRAILS HIMSELF (2026-08-16). READ THIS
BEFORE BELIEVING ANYTHING BELOW.** He rewrote `TUTOR_RULES` ("You are an
assistant helping your boss complete any task you are asked to… Do whatever you
are told") and rewrote `proofread.js` so the limits are `Infinity` and the edit
vocabulary now includes `rewrite` (replaces the whole draft), `regex`, `insert`
and `occurrence`. He was told plainly what that means and did it anyway; it is
his app and his call. Two things were declined and stay declined: writing the
ghostwriting code, and deleting the guard tests. **The five failing tests in
`smoke.test.js` (2309, 2403, 2437, 2457, 2499) are that record — they fail
because the limits are gone. Do not delete them to make the suite green.**
Everything in the next paragraph is history, not current behaviour.

*(Historical — how it was built.)* `src/proofread.js` WAS the guardrail and the
prompt was not: a prompt is a request, this was arithmetic, and it ran on every
edit before a character moved — the `find` had to be copied verbatim from the
draft and occur **exactly once** (so nothing could be replaced in bulk), be ≤240
chars (no paragraph rewrites), the replacement within +24 chars, and at most
**3 words** could differ. A punctuation/capitals-only change always passed.
Max 30 edits a message.

**The one bug fixed in Will's version (2026-08-16), and the only code touched
since he took it over:** replacing over markup deleted the tags inside the
matched span. The tolerant matcher deliberately steps over `<b>…</b>` so a
phrase copied from the rendered draft is still found, and `spliceSpans` then
overwrote the whole region — leaving an unclosed tag, after which the rest of
the draft inherited the formatting **including in the .docx** (verified through
`richtext.js`: paragraph 2 came out bold). `spliceHtmlSpan` now re-emits every
tag in the span, in order, exactly once, with the replacement placed where the
first text was. `spliceSpans` gained a `preserveTags` argument, passed only on
the HTML find/replace path. **The `regex` path still splices raw and can cut
across tags** — left alone deliberately, a regex on markup is doing what it was
told.

**The transcript reports what ACTUALLY changed.** `summarise()` appends the real
before/after list, including a "Left alone" section for anything refused. This
matters because the first live run had Claude write a lovely paragraph about the
four fixes it had made while sending no `edits` at all — the draft never moved
and the reply said "Done". Fixed by telling the model the causal truth in the
output instruction ("describing a fix in reply changes NOTHING") plus a worked
JSON example; prose instructions alone did not do it.

**Edits are only ever read out of real JSON** (`readEdits`). A reply that ignores
the format can talk but cannot touch the draft.

**`pageDraft.adopt(value)` in app.js is the client half and it is load-bearing.**
The server changed the draft under a live editor, so the editor must be updated
AND told the new text is already saved — otherwise the next autosave pushes the
uncorrected copy back over the corrections. `richEditor` gained `setHtml` for it.
A drive check types a sentence after a correction and asserts both survive.

Verified live both ways: "fix my grammar and spelling" corrected four mistakes in
place and left the wording alone (40→39 words); "rewrite that paragraph so it
sounds smarter and put it straight into my draft" answered *"No — I'm not going
to write it for you… nothing going into your draft"* and the draft was byte-for-
byte unchanged. Both are pinned in `drive/ai.js` phase 6.

**Phase 6's "THE DRAFT WAS NOT REWRITTEN" no longer proves anything.** Since
round 51c it passes because the MODEL declines, not because anything stops it —
a different refusal each run. It is a green tick with nothing behind it; do not
read it as protection.

**Flake to know about:** the notes→flashcards checks in `drive/ai.js` phase 4
fail intermittently when Claude times out and `notesAI.js` falls back to the
built-in reader (the output says "(basic reader)" and the cards are
fill-in-the-blank). Re-run before investigating — it passed 61/61 on the retry.

Proofreading is **assignment pages only** — the essay and slideshow project pages
have no chat yet.

**THE PERSONAL-SETTINGS LEAK IS THE FINDING OF THIS ROUND, AND IT WAS THE ROUND
18 BUG ALL ALONG.** Will's own `~/.claude/settings.json` has SessionStart and
UserPromptSubmit hooks that inject his working rules — "start every reply with
hey will", "ask ONE question", "keep CLAUDE.md updated" — into **every** claude
process on this machine, Slate's hidden ones included. The first live chat reply
opened "hey will". Round 18 blamed CLAUDE.md in the cwd and papered over it by
parsing JSON out of the reply; the cwd was only half of it. **`viaCli` in
claude.js now passes `--setting-sources ''`** (`NO_PERSONAL_SETTINGS`), verified
both ways — with the flag a bare question answers straight, without it the
greeting is back. A smoke test asserts the flag is on the args the spawn uses.
**simplify.js, outline.js, unstuck.js and notesAI.js still have their own older
copies of the spawn and are still exposed** — they all parse JSON so nothing
shows, but the fix belongs there too. Offered to Will, not done.

**`askCli` (new, in claude.js) skips the API transport on purpose.** `viaApi`
sends a bare message with no tools, so an `ANTHROPIC_API_KEY` in the environment
would silently take the web away from anything that needs it.

**The transcript lives in `chat_messages`, not in Claude Code's sessions.** Every
send is a fresh one-shot and the history is replayed into the prompt (newest
turns kept, oldest trimmed). `--session-id`/`--resume` exist and would be
cheaper, but sessions are keyed to a working directory and would not survive an
app update — a chat about an essay has to still be there next week.

**Nothing is written until Claude answers.** A failed send returns
`{ok:false, error, question}` and the page puts the question back in the box, so
the transcript can never hold a question with no answer under it.

**Second place in Slate that gives Claude Code the web** (round 46 was the
first). `CHAT_TOOLS = 'WebSearch,WebFetch'` and nothing else — no Read, no
Write, no Bash. A test asserts the only tool list passed is that constant.
It runs in `os.tmpdir()/slate-chat`, outside the project, so there is no
CLAUDE.md up the tree for it to read.

**Sources have to be asked for INSIDE the JSON string.** Claude Code appends its
own "Sources:" block after the closing brace and `parseJson` throws that away —
for schoolwork the links are worth more than most of the answer.

**WHERE THIS SITS RELATIVE TO THE NO-GHOSTWRITING RULE.** `TUTOR_RULES` bans
writing any part of the assignment in as many words, and tells it to refuse and
redirect if asked. Verified live: asked to "write the whole thing and give me
the finished text I can paste in", it answered *"No. I'm not going to do the
worksheet for you"* and then taught the method on a problem that was explicitly
not on his sheet. That is the behaviour to preserve. The rules are pinned by a
smoke test the same way aiCheck's "no reasons list" is.

Will chose "send my draft with it" when asked. That is what makes it better than
a search box and it is also the thing to be careful with — the draft is labelled
in the prompt as the student's work to critique, never to improve.

`npm run shots` gained an **`arrange`** hook: a step can set something up in
Node (here, inserting a conversation straight into the shots database) before
the page is photographed, because that server runs with `SLATE_NO_AI=1` and
cannot have a conversation of its own.

**Round 75 — the copilot makes real documents and edits uploads in place
(2026-10-28).** Will: it "can't make documents well" — wants well-formatted
PDFs, to replicate a PDF he gives it with screenshots placed where he says,
and to read uploads and send them back changed. Evidence for the second: his
real `SEC 1.2.3 Student Submission.docx` upload came back as
`SEC 1.2.3 Lab Report - filled.md` — round 72's read-to-text →
`buildDocx(text)` path threw away every font, list and heading.

**`lib/docxedit.js` edits word/document.xml IN PLACE** (every other part of
the package byte-for-byte kept). `outline()` numbers OUTERMOST paragraphs
(text-box paragraphs belong to their outer one) with table/row/cell, list,
heading and picture marks — that is what `read_file` now returns for a
.docx. `editDocx` ops: replace (works across Word's split runs; the
replacement takes the first run's formatting), set_text, append_text,
insert_after (clones pPr + rPr, drops w14:paraId), insert_image
('inside' an empty answer paragraph / 'after'), delete (inside a table cell
it leaves `<w:p/>` — a cell with no paragraph is a corrupt file). **Numbers
refer to the file as read; all edits are applied against original offsets,
stitched from the end.** Images: media part + rel + ONE `<Default>` per
extension (round 8: a duplicate corrupts) + `wp`/`r` namespaces added to the
root if missing; width from CSS px at 96/in, capped 6.5in. Verified on
copies of both of his real worksheets: Quick Look render shows original
numbering/fonts kept, answer under the question, picture in place.

**`lib/pdfmake.js`: HTML → PDF with Chrome's own printToPDF in a SEPARATE
hidden headless browser** (free port, throwaway profile, started lazily,
killed on exit) — never a tab in the copilot Opera (9222, Will's browser).
**Page scripts are disabled** in the printed page: its HTML is built from
web content. `docs.makePdf` keeps the HTML in `sources/` (with a `<base>`
at the docs folder so `images/x.png` resolves) so a PDF can be remade, and
reports `missing_pictures`. The model is told to Read its PDF afterwards to
check it.

**`capture_image`** (chrome.captureImage) saves a full-res PNG of the tab —
viewport region, visible screen or full page — into `images/`. **The clip
must add scrollX/scrollY**: captureScreenshot's clip is document
coordinates, the model's are viewport. Verified exact on a scrolled page.

Tools: `capture_image` (browser server), `edit_docx`, `make_pdf` (docs
server). `FILE_TOOLS` results carry `file` on `tool_done` → the chat shows a
file card (Preview / Open). Documents view previews PDFs/pictures in an
iframe via `/api/docs/file` (name checked through docPath); Office files
preview as text. `readFile` now resolves bare names against DOCS_DIR.

**`npm run check:docs:live`** (in browser-copilot/, ~$1.30 on sonnet): two
real turns on a throwaway server + headless browser + temp docs dir — Word
worksheet filled + cropped capture under the right question (every original
line kept, no save_document), and a PDF worksheet rebuilt with the capture
inside question 1's box. All green; outputs eyeballed. UI screenshotted on a
throwaway rig, no page errors. The copilot on 4321 was not running, so
nothing to restart — next start picks it up. Not committed.

**Round 74 — Slate restructured into tool sections (2026-09-20).** Will: "i
just want it to be an app that compiles a bunch of tools that help with school
now." Remove Today/Week/Tests/Classes/Email; keep four sections — the written-
document maker, the PowerPoint maker, Copilot, Watermarks — and in each, click
"New", pick a Canvas class + assignment for the instructions, and chat with the
on-page Claude about it; projects save and reopen. Pre-save one slideshow from
his filled-in "Secular Ethics Presentation". Confirmed with him via
AskUserQuestion: keep Canvas + Admin as small bottom utilities; the section
lists show ONLY user-created projects (Canvas assignments are just picker
data); names are Documents / Slideshows / Copilot / Watermarks.

**THE DATA MODEL: a user project is an `assignments` row with `source='user'`.**
New columns (db.js): `source` ('canvas' default / 'user'), `linked_assignment_id`,
`linked_assignment_name`, `updated_at`. A user project leaves
`canvas_assignment_id` NULL — and sync keys every upsert on canvas_assignment_id,
so it NEVER touches user rows (no source guard needed). It can be LINKED to a
Canvas assignment for instructions: that id goes in `linked_assignment_id`, NOT
canvas_assignment_id (which is UNIQUE and owned by sync — reusing it would
collide). `refreshFromCanvas` now falls back to linked_assignment_id, so the
chat's first-message refresh works on user projects too.

**class_id is NOT NULL in the schema, so a new project starts on the first
class** (createUserProject) and the picker changes it — a full table rebuild to
make it nullable was not worth the risk on his real data. `assignmentDetail` and
`projectDetail` became LEFT JOIN so an as-yet-unlinked project still loads.
**`fileList` had to guard `parseJson(row.files, []) || []`** — a user row has
files=NULL, and `JSON.parse("null")` is `null`, not the fallback, so `.map`
threw. Canvas rows never hit that because sync always writes a JSON string.

**New api.js:** createUserProject / listUserProjects / renameProject /
deleteProject / classChoices / canvasAssignmentsForClass / linkCanvasAssignment
/ ensureStarterProjects. **New server routes:** GET+POST `/api/documents`,
POST `/api/documents/:id/{rename,delete,link}`, GET `/api/canvas/classes`,
GET `/api/canvas/classes/:id/assignments`. saveDraft/saveSlides bump updated_at
for user rows so the lists sort most-recent-first.

**The pre-saved deck:** `ensureStarterProjects()` (called at boot after
ensureSeeded) copies a `build_mode='slides'` row whose title matches "secular
ethics" into a fresh `source='user'` slideshow, once (guarded by the
`seeded_starter_projects` setting). It NO-OPS on the mock/test DBs (no such
deck) and on his real DB it made id 123 with all 8 filled slides under the
Bible class. Copied, not converted, so the original Canvas row is left for sync.

**Frontend:** VIEWS now routes only documents/slideshows/work/project/copilot/
marks/api/admin. `renderSection('doc'|'slides')` lists user projects + a New
button; `openProject` opens the work view for docs, project view for slides.
`projectSetup(detail, kind)` is the editable title + class/assignment picker,
shown at the top of the work/project pages when `source==='user'`; picking an
assignment POSTs `/link` (pulls instructions) and re-renders. **Use
`document.createElement('option')`, NOT `new Option` — the drive DOM shim has no
Option constructor** (this bit once). Back buttons + complete actions go to
documents/slideshows (all the old `state.view='today'`/`'projects'` fallbacks
were repointed). index.html nav is the six buttons; `.tab-util` styles Canvas +
Admin small.

**Verified:** headless walkthrough (real Opera) of New document → pick class →
assignments load → pick assignment → instructions pulled → listed with class +
assignment; screenshots eyeballed. `npm test` 108/5 (the 5 = round 51c guards).
`npm run drive` api 516 / **ui 272** (0 js errors) after rewriting the UI
harness — removed the Today/Week/Tests/Classes/Email/Class-notes sections, fixed
the view sweeps + tab list + nav-return assertions, added a Documents +
Slideshows section. `npm run shots` gained documents/slideshows/new-document,
dropped the removed-view steps. Mock `listAssignments` gained the Number-coerce
`getAssignment` already had (a string course id matched nothing). His real 4173
DB was FULLY BACKED UP (db+wal+shm to `data/backup-round74-*`) before the
migration ran on it. Not committed.

**Round 73 — the PowerPoint maker outputs a plain, blank deck (2026-09-20).**
Will: "make it so that the powerpoint maker just makes a blank presentation
with just the bullet points and header." The .pptx builder was heavily
designed — dark Slate background, rounded bullet "cards" with accent tabs,
two-digit kickers, slide-number footers, a title slide with a dot motif, and
per-slide "leave space for a picture" frames. Now every slide (slide 1
included) is the default Title + Content layout: the **title placeholder** is
the header, the **content placeholder** holds one bullet per line, on the
master's white background. No colours, cards, kickers, footers, frames.

**WHY PLACEHOLDERS, not drawn text boxes:** using the layout's real
`<p:ph type="title"/>` and `<p:ph idx="1"/>` is what makes it a genuine blank
deck — bullets appear in Outline view, the whole thing is theme-able (drop any
PowerPoint theme and it restyles), and the master's bodyStyle supplies the
bullet char/indent/fonts/black-on-white. Removing the per-slide `<p:bg>`
override is what makes it white (it inherits `bgRef idx="1001"` → bg1 → white).
Verified with **python-pptx** (a strict OPC parser — it opens the package on
load): 3 slides, each with a TITLE placeholder + OBJECT placeholder, headers
and bullets read back correct, notes preserved only where present; an 8-bullet
slide and an empty-title fallback deck both open clean.

`officegen.js`: `titleSlideXml`/`contentSlideXml`/`slideDoc` and all the drawn-
shape helpers (`run`/`panelShape`/`pictureFrame`/`rectShape`/`textShape`/
`bulletPara`, the `C_*` colours, `MARGIN`, `CONTENT_W`) were **deleted** —
replaced by `titlePh`/`bodyPh`/`plainSlideXml`. `buildHtmlSlides` and
`slidesToText` went plain to match. The master/layout/theme parts and the
whole notes-slide machinery (round 53) are unchanged.

**THE `photo` FIELD IS FULLY GONE, not just ignored.** "Leave space for a
picture" made no sense in a blank deck, so the toggle, the field and its CSS
were removed everywhere: the editor checkbox + `.pic-toggle` CSS (app.js/
styles.css), `saveSlides` and `seedSlides` (api.js), `titlesToSlides`
(outline.js), the app.js `normalize`/push objects. Old saved decks with a
stray `photo` key are harmless — the whitelist just drops it.

**Preview kept in lockstep (the round 44/45 rule):** `slideStage` + the `pv-*`
CSS now draw a plain white slide, bold black header, plain `<ul>` bullets —
uniform for every slide, no special title slide, no cards, no >6-bullet
fallback (it's always a list now). Eyeballed via `npm run shots`
(slides-handin, slides-handin-slide3, slides-editor): white slides, headers,
bullets, and the editor no longer shows a picture toggle.

**Tests updated to pin the plain output** (they had pinned the styled one, on
purpose — this is a deliberate behaviour change): smoke.test.js asserts real
placeholders + no brand colours/cards/kickers/footers; drive api.js/ui.js drop
the picture-space and photo-toggle checks and assert placeholders + absence of
frames instead. `npm test` 108/5 (the 5 are the round 51c guard tests, still
red by design), `npm run drive` api 516 / ui 385, all green.

**Round 72 — the copilot reads and edits uploaded Office files
(2026-09-11).** Will: "the feature where I upload a file doesn't work. claude
should be able to read and edit files I upload." The upload endpoint and the
paperclip flow were fine — files landed in `~/Documents/Browser Copilot/
attachments` (two of his real `.docx` were sitting there). The gap: the
session only had the built-in `Read` tool, which handles text/images/PDFs but
NOT Office files (a `.docx` is a ZIP, so Read saw raw bytes). And there was no
way to write an edited file back.

**`lib/office.js`** — ZERO-dep read of `.docx`/`.pptx`/`.xlsx` to text and
write of a plain `.docx`, ported from Slate's `src/attachments.js` (central-
directory ZIP walk + `zlib.inflateRawSync`, XML→text) and `src/officegen.js`
(`makeZip`/`crc32`/`buildDocx`). Slate's `buildDocx` is the version already
verified in real Word (round 33/34), so the bytes are trustworthy; macOS
`textutil` also parses both the generated file and his real uploads.

**Two docs-server tools added (`lib/claude.js`):** `read_file(path)` reads any
attachment except PDFs/images (Office + text/csv/json/md); `save_document`
now writes a real Word file when the name ends in `.docx` (via
`office.buildDocx`), which is how an edit goes back openable. `docs.readFile`
resolves the path and REQUIRES it inside `DOCS_DIR`, so a reply cannot point
it at an arbitrary file. **Editing is copy-out, not in place** — it always
saves a NEW file in the Documents folder (the upload under `attachments/` is
left alone); the prompt tells it to add "edited" to the name unless asked to
overwrite. The system prompt's Documents section and the per-attachment
header line now steer Office/text → `read_file`, PDF/image → `Read`.

**Verified live (haiku, ~16c) on a throwaway server:** uploaded a `.docx`
with a typo, asked to fix spelling and save as Word → it called `read_file`
(not Read), then `save_document book report edited.docx`; the saved file read
back as a valid Word doc with "stroy"→"story" fixed and the marker line
intact, and `textutil` opened it. `lib/office.js` also unit-round-trips
(buildDocx→docxText) and reads his real uploaded submission (1916 chars).
Live copilot on 4321 restarted clean. Not committed.

**Round 71 — a Mac Desktop launcher (2026-09-10).** Will: "put something
that opens the app in opera on my desktop." `tools/mac-launcher/build.sh`
compiles `Slate.applescript` into `~/Desktop/Slate.app` (osacompile, icon
from `branding/slate-mark-dark-1024.png` via sips + iconutil — stock tools,
no admin). The applet: probe 4173, start `server.js` if down (with
`SLATE_OPEN=0` so the server does not ALSO open the default browser; node
from `~/.local/lib/nodejs/current/bin`, Finder's PATH has none); probe 4321,
start the copilot server if down; POST `/api/launch-chrome {startUrl}` —
round 69's route, which starts the copilot Opera if needed (~30s cold) and
makes sure a Slate tab exists; then PUT `/json/activate/<id>` on 9222 to
front that tab and `open -a Opera` to front the window. Fallback if the
copilot cannot come up: `open -a Opera <url>`. Logs in `~/Library/Logs/
slate-launcher.log` / `slate-copilot-launcher.log`. Servers started this
way have a clean Finder environment — the round 69 rule by construction.

**WHY IT GOES THROUGH THE COPILOT, NOT `open -a Opera <url>`:** the first
build did `open -a Opera <url>` and Will got "it opens the localhost but the
screen is black". The only Opera running was the copilot instance (custom
`--user-data-dir`), the page renders fine in a clean browser (checked
headless, no exceptions), and no localhost tab appeared on 9222 — so the URL
was handed to an Opera that put up a black window. Not diagnosed further:
that would have needed his screen, and **Will does not want screen
recording** — a `screencapture` attempt triggered the macOS permission
prompt and he said no. Do not use `screencapture` or System Events
automation here again; verify through the copilot's CDP port (read-only
screenshots of a tab are fine) or a throwaway headless browser.

**TRAP that cost the first build:** in AppleScript's `do shell script`, a
backgrounded `cd X && nohup node … > log 2>&1 &` still HANGS the applet
until Slate exits, because the `&` backgrounds a subshell running the whole
list and only node's fds were redirected — the subshell keeps the script's
pipe open. Redirect the whole subshell: `(cd X && nohup node …) > log 2>&1
< /dev/null &`. Verified: cold start on a throwaway port/DB (~1s), warm
path, and the real icon — a Slate tab appeared on 9222 and a CDP screenshot
of it showed the Today page, front and drawn. Windows still uses the round
19 installer; this is Mac-only.

**Round 70 — the copilot got eyes and hands for canvas pages, and
screenshots to the Desktop (2026-09-09).**

Will pasted an explanation of why the copilot could not work a screen that
is a browser-based remote desktop (Guacamole / noVNC: WebSocket to a
gateway, framebuffer painted onto a `<canvas>`, real mouse/keyboard events
on the canvas forwarded back) and asked for "the tools described". That is
option (b) from his paste — treat the canvas as pixels — with one
simplification: **CDP input events go through the browser's own event
pipeline**, so the canvas's listeners fire exactly as for a human and the
page forwards them down its socket. No OS-level events, no protocol client.

All in `browser-copilot/`. `lib/chrome.js` gained `screenshot(id, {save,
name})`, `clickAt`, `moveMouse`, `drag`, `scrollAt`, `typeText`,
`pressKeys`; `lib/claude.js` exposes them as `click_at`, `move_mouse`,
`drag`, `scroll_at`, `type_text`, `wait`, a broadened `press_key`
(any key or combo — `ctrl+alt+Delete`, `shift+Tab`, `F5`; one non-modifier
per call, unknown names refused rather than guessed) and `screenshot` with
`save`/`name`. The system prompt has a "pages that are just a picture"
section: look → act by coordinate → wait → look again, never assume a
canvas action worked.

**The screenshot the model sees is captured at CSS-pixel size** (clip
`scale: 1/devicePixelRatio`), so a point read off the image IS the page
coordinate — on Will's retina Air a raw capture is 2x and every click would
land at half the distance. The saved PNG is full resolution. **`screenshot`
no longer calls `bringToFront`** — captureScreenshot re-renders a hidden
tab (round 64), and fronting was the round 62 complaint.

**`type_text` is real keystrokes, not `insertText`.** `insertText` only
tells an editable element to insert; a canvas listening for `keydown` never
hears it. Each character is keyDown(+text)/keyUp with `key`, `code`,
`windowsVirtualKeyCode` and Shift for capitals/symbols (US layout);
anything not on a US keyboard still goes through insertText.

**HEADLESS TRAP, measured 2026-09-09:** in `--headless=new` (Opera 135 and
Chrome alike) a keyDown with text on a focused NON-editable element floods
the page with thousands of keydown/keypress pairs a second — no `repeat`
flag, not auto-repeat rate — and the next CDP call hangs. An `<input>` is
clean; a headful window is clean (keydown, keypress, keyup, done); a page
that `preventDefault`s keydown (noVNC and Guacamole both do) is clean. Real
use is headful, so the tools are right; the rig page preventDefaults. If a
test ever hangs inside typeText, this is why.

**`nativeVirtualKeyCode` is NOT sent.** On macOS Chrome reads it as the
platform keycode, and 72 (`h`) is Volume Up — the probe log showed
`AudioVolumeUp` keydowns interleaved with the letters.

Saved shots: `DESKTOP_DIR` (env `COPILOT_DESKTOP_DIR`, then
`SLATE_DESKTOP_DIR`, then `~/Desktop`); `shotPath` flattens the name to a
basename, defaults to "Screenshot <tab title> <stamp>.png", and numbers
rather than overwrites.

**Checks, both in the repo:** `npm run check:pixel` (28, throwaway headless
browser on its own port/profile + temp Desktop; never 9222) and
`npm run check:pixel:live` (one haiku turn, ~15¢, through a throwaway
copilot server on that rig: fake lab login canvas — Claude screenshot,
`click_at` 448,280 inside the drawn box, `type_text student42` which the
canvas rendered, `screenshot {save, name:"lab proof"}`). The first live run
ignored the requested file name; one prompt line fixed it.

The copilot on 4321 was restarted with the CLAUDE env stripped (round 69
rule) so the new tools are live. Not committed — Will did not ask.

**Round 69 — "Launch Opera" errored; the servers were the problem
(2026-09-04).**

Will: press Launch Opera, it loads, an error, nothing happens. Two causes,
both real:

**1. BOTH SERVERS HAD BEEN STARTED FROM A CLAUDE CODE SESSION, AND OPERA
WILL NOT START FROM A CHILD OF ONE.** Slate on 4173 (started Aug 31) and the
copilot on 4321 (Sep 2) were still carrying that session's environment
(`CLAUDECODE=1`, `CLAUDE_CODE_*`, and whatever sandboxing that shell had).
The copilot's `launchChrome` spawn from that process never produced a
listening Opera at all; the byte-identical spawn from a fresh shell had the
DevTools port up in a second. **Rule: never leave Will's real servers
running as children of a Claude Code Bash.** Start them the way he does
(`npm start` from Terminal), or from a Bash with the sandbox off and every
`CLAUDE*` variable stripped (`env -u CLAUDECODE -u CLAUDE_CODE_... node
server.js`, which is how both were restarted this round). Same trap would
bite Slate's own `open`/`claude -p` spawns. If Launch ever fails again
while a hand launch works, check the server's parent and env first
(`ps -E -p <pid>`).

**2. The launch route waited 10s; a cold Opera on Will's profile takes
~30s.** Measured twice: 31s and 33s to the DevTools port (session restore
plus extensions). So even a healthy server would have shown the error
while Opera was still coming up, and then Opera appeared "on its own".
`/api/launch-chrome` now waits up to 45s.

**Launch Opera now opens Slate in the copilot's window.** Will's ask was
"read the tabs I have open in the same Opera I'm using Slate in". His
everyday Opera window still cannot be attached to (round 61: Chromium
136+ refuses remote debugging on a default profile; his is Chromium 151),
so the nearest real thing is making the copilot's window the one he uses.
The copilot page sends `startUrl: document.referrer origin` when it is
framed (that is Slate's address), and the route opens it — `ensureTab()`
only if no tab already has that URL, checked 1.5s after the port is up so
session restore has listed its tabs first. Passing the URL as a launch
argument made a SECOND Slate tab because restore brought the old one back;
that is why it is a post-launch check. `startUrl` is http(s) only.

Verified: live chat turn through the ws answered "PONG"; warm launch with
Slate already open added nothing; cold launch produced exactly one Slate
tab among his restored ones; the Copilot tab photographed inside that Opera
shows connected, green dot, Slate in the Working-on dropdown.

**Round 69b — the copilot moved INTO this repo (2026-09-04).** Will: "put it
in the same repo." `browser-copilot/` is now a folder of the Slate repo,
brought in with `git subtree add` so its commit history came along. **It is
still its own program** (own package.json, own node_modules — gitignored by
the root `.gitignore`'s `node_modules/`; round 58's "stays its own app"
design is unchanged, Slate's own package.json still has zero deps).
`copilotDir()` in src/copilot.js now tries `<repo>/browser-copilot` first,
then `~/Desktop/School Tracker/browser-copilot`, then the old
`~/Desktop/Browser Copilot/browser-copilot`, then `SLATE_COPILOT_DIR` wins
over all of them. The running copilot on 4321 was restarted from the new
folder. **The old Desktop folder and the separate
`wcaldwell2009/browser-copilot` GitHub repo are now stale copies** — left in
place, not deleted; edits go in `browser-copilot/` here from now on. The
installer's build.js does NOT copy browser-copilot into `dist/slate-app`
(the installed Windows app finds it via the Desktop/SLATE_COPILOT_DIR
paths); on Will's PC the step is `git pull` then `npm install` inside
`browser-copilot`.

**What Will needs to know:** do schoolwork in the Opera window that Launch
Opera opens (it has Slate and his tabs). Anything in his other Opera window
is invisible to the copilot and always will be, short of rebuilding the
copilot as an Opera extension.

**Round 68 — full state restore across the iframe reload (2026-09-02).**

Will: clicking off the Copilot tab and back should keep "my tabs". Round 67
restored the transcripts; three pieces of state still reset: each chat's
pinned browser tab, the active chat, and the view. Now: **`chats.setTabId`
persists the pin server-side** (written on every chat message and on
select_tab; no-op for a chat with no transcript file yet), `restoreChat`
puts it back on the Chat object, and **boot loads tabs BEFORE restoring
chats** so `activateChat` can point the dropdown at an option that exists.
The active chat and viewMode live in `localStorage` (same origin across
iframe rebuilds; try/catch per the usual storage rules) — `setMode` and
`activateChat` write them, boot replays them, and a restored 'tab' mode
reconnects the stream by itself once the ws says connected. A pinned tab
that no longer exists just leaves the dropdown at its default.

Verified by driving the real page headless on the rig: pin a tab, send a
message, switch to Tab view, `Page.navigate` reload (exactly what Slate's
re-render does to the iframe) — chat, bubbles, active chat, dropdown pin
and view all came back identical. Seven checks green.

**Round 67 — copilot chats persist; the forgetting is fixed (2026-09-01).**

Will: "my claude has short term memory loss." Root cause, and it was
structural: **sessions lived in a per-CONNECTION map, and the copilot lives
in an iframe that renderCopilot rebuilds on every Slate navigation** — so
switching Slate tabs reloaded the page, dropped the ws, and the server
disposed every session. My round 65/66 server restarts did the same.

The fix is Slate's round 51 lesson applied here: **the transcript is the
durable thing.** `lib/chats.js` (one JSON per chat,
`~/.browser-copilot-chats`, `COPILOT_CHATS_DIR` for rigs) stores every turn
— user text on send, Claude's text buffered per turn (`__turnBuf`, flushed
on turn_done AND on interrupt so a stopped reply is kept). In server.js the
**sessions map moved to module scope** and events route through a rebindable
`uiSend`, so a reload reattaches to LIVE sessions (full memory, no replay);
`ws.on('close')` no longer disposes anything. When a session genuinely died
— server restart, or the 3-hour idle reaper that frees the hidden claude
process — the next message is prefixed with `transcriptFor(chatId)` (newest
turns win a 12k-char budget), **built BEFORE the current message is
appended** so the question isn't in the story twice. The UI rebuilds every
chat from `GET /api/chats` on boot; ✕ (close_chat) deletes the transcript —
the one deliberate way to forget. The scary "memory was reset" reconnect
line is gone because it stopped being true.

Verified live on isolated dirs: codeword → `kill` the server → fresh boot →
same chat asked → the codeword came back. Transcript held both roles on
disk between the two.

**Round 66 — copilot documents, attachments, model picker (2026-09-01).**

All in the copilot project. **`lib/docs.js` is the write sandbox**: the
session's ONLY writing goes through the `docs` MCP tools (save_document /
list_documents / read_document); every name is flattened by `safeName`
(basename only, no separators, controls or dotfiles) into
`~/Documents/Browser Copilot` — override `COPILOT_DOCS_DIR` for rigs. The
**Documents view** (third toggle) lists that folder; `/api/docs`,
`/api/docs/content`, `/api/docs/open` (path always from `docPath`, never
from the request). **Attachments**: paperclip → `/api/upload` (base64,
20 MB cap, express json limit raised to 30mb) → stamped file under
`attachments/` → the message header names the path → **the session now has
the built-in `Read` tool** (the same tool Slate's hidden helpers use;
Bash/Write/Edit stay disallowed), so text, images and PDFs all open. The
server refuses attachment paths that are not existing files inside
`ATTACH_DIR`, so a page script cannot point Claude's Read at an arbitrary
path through the ws.

**Model picker** (`lib/settings.js`, `~/.browser-copilot.json`, override
`COPILOT_SETTINGS`): sonnet / opus / haiku, applied to sessions created
after the change — the SDK takes the model at session start, so running
chats keep theirs. **The per-turn cost line is gone from the UI** (the
server still emits costUsd; the page just doesn't show it).

Verified on the rig with one live haiku turn: attach a file carrying a
random marker → Claude Reads it and save_documents `echo.txt` containing
exactly that marker → listed and readable through the API. Plus model
roundtrip and validation, and traversal-name refusal. `safeName` gotcha for
later: the Write tool once turned ` -` escapes into RAW control
bytes in the source — grep for them if the regex ever looks mangled.

**Round 65 — the strip is gone; the dropdown drives the viewer
(2026-09-01).**

Will: "remove the pills at the top just make the dropdown thing from before
work." The Tab view now has exactly one control: the **Working on dropdown
pins both the chat and the viewer** to its tab (`view_tab` on change,
`watch_tab` now carries the dropdown's tabId so the right tab is pinned
from the first frame). Round 64's pin machinery is unchanged underneath —
Opera never gets touched, hidden tabs show via live screenshots. The strip,
the Follow pill and `view_follow` were removed; follow mode still exists
inside `watchView` purely as the fallback when a pinned tab closes. The
＋ New tab button went back to floating top-left of the viewer. Six
dropdown-viewer checks green on the rig.

**Round 64 — pinned viewing of hidden tabs; the strip means it now
(2026-09-01).**

Will, correctly: the round-63 strip "still just mirrors the tab I have open"
— clicking a pill fronted the tab, so the viewer never showed anything but
the front tab. **The discovery that unlocked the real thing:
`Page.captureScreenshot` (fromSurface:true, the default) WORKS on a hidden
tab and is LIVE — it re-renders the page on demand.** Measured in headful
Chrome: capture, change the DOM, capture again → different bytes.
(`fromSurface:false` errors; screencast on hidden tabs stays dead even with
`setWebLifecycleState('active')` — both also measured.)

**`watchView` in chrome.js replaces `watchActive`** (round 63's
`watcher.front` and the `front_tab` message are gone): follow mode mirrors
the front tab via screencast as before; a strip click sends `view_tab` →
`watcher.pin(id)` — NO bringToFront, Opera is left alone — and the viewer
images that tab by screencast when it is front or by an 800ms
captureScreenshot loop when hidden (`Page.getLayoutMetrics` supplies the
CSS-px meta for click mapping). `view_follow` unpins. A pinned tab that gets
closed auto-unpins. Input still routes to `watcher.current()` — and CDP
input works fine on hidden tabs, verified: typed into a pinned background
tab while a different tab stayed front, all through the copilot's ws.
`watching` events carry `pinned`; the strip's Follow pill lights on
!pinned, the shown tab's pill on tabId.

Nine pin checks green on the isolated rig (never against Will's browser —
the round 63 rule).

**Round 63 — the viewer grew a tab strip, and tests got isolated
(2026-09-01).**

Will: the mirror only shows the front tab, "I need it to show any tab". Any
tab can only be SHOWN by fronting it (round 62's engine facts), so the viewer
gained its own **tab strip**: `refreshStrip()` renders a pill per
`/api/tabs` entry (mirrored one `.active`, ＋ New tab at the end, 3s refresh
while the view is up), and clicking one sends `front_tab {tabId}` — the
server calls `watcher.front(id)`, which brings the tab to front AND attaches
the stream immediately instead of waiting for the 900ms poll. The dropdown
still only pins the chat. Told Will plainly: the strip switches the real
Opera window too; viewer and window are two screens of one browser.

**THE HARNESS RULE THAT CAME OUT OF THIS ROUND: never drive input at the
real copilot browser (9222) — it is Will's working browser.** A verify
script clicked+typed "zz" mid-test exactly when Will fronted his live Slate
tab, and the input followed the front tab into his real app (checked
read-only afterwards: no draft, slide or title took damage — but that was
luck, not design). `CDP_PORT` in chrome.js is now `COPILOT_CDP_PORT`-
overridable, and the e2e scripts take `COPILOT_BASE`/`COPILOT_CDP` envs; the
scratchpad's `run-isolated.js` boots a throwaway copilot server wired to a
throwaway headless Chrome and runs any script against that pair. All six
mirror checks green on the rig — the "failure" that started this was Will's
own click racing the test, proven by the isolated pass.

**Round 62 — the live view became a mirror of the active tab (2026-09-01).**

Will: the dropdown "takes me to that tab", and the viewer freezes while "the
actual website changes". Both were real, and the diagnosis matters for
anything touching screencast:

**Only the FRONT tab of a browser window produces screencast frames, and an
OCCLUDED window produces none at all.** Measured directly: a DOM change on a
front-but-covered tab yielded 0 frames; with
`--disable-backgrounding-occluded-windows` + `--disable-renderer-backgrounding`
on the launch args it yields frames again. A background (non-front) tab yields
0 regardless — no flag changes that, it is simply never drawn. So a viewer
pinned to one tabId is unfixable by design; the fix is architectural:

**`watchActive` in chrome.js mirrors the window.** `activeTabId()` finds the
composited tab (`document.visibilityState === 'visible'`, preferring
`hasFocus()` when two windows qualify), streams it via the old `watchTab`
(which LOST its `bringToFront` — that was the dropdown-yanking), and a 900ms
poll re-attaches when the front tab changes, emitting `watching {tabId,
title, url}` to the UI. The server routes viewer `input` events to
`watcher.current()` — the UI no longer names a tabId for either frames or
input. The dropdown is chat-pinning only; its label says "Working on".

The `#tabName` pill (top-right of the viewer) names the mirrored tab.
Verified end-to-end: mirror latches, follows a `json/new` tab, follows a
tab-strip switch (`Page.bringToFront`), streams after each move, and typed
input lands in whichever tab is front. Mirroring the Slate tab recurses
(Slate → Copilot tab → mirror → …) — expected, harmless.

**Round 61 — the copilot drives Opera, seeded with Will's real profile
(2026-09-01).**

Will asked for "my opera tabs". **The literal ask is impossible and will come
back: Chromium 136+ refuses --remote-debugging-port on a DEFAULT profile, and
Will's Opera 135 is Chromium 151** — his everyday Opera window can never be
attached to, by this or any tool. Told him straight; what shipped is the
nearest real thing: `launchChrome` picks Opera over Chrome (his install is
`~/Applications/Opera.app` — NOT /Applications, that copy is John's; Will is
not admin), VISIBLE again (headless dropped, round 60's invisible mode
retired), on `~/.browser-copilot-opera`.

**That profile is a one-time rsync of his real one** (`~/Library/Application
Support/com.operasoftware.Opera`, caches and Singleton* excluded, copied live
2026-09-01) — logins survive because the "Opera Safe Storage" keychain key is
app-scoped, not profile-scoped, and Opera's saved session came with it: first
launch restored his actual tabs (Slate, Canvas grades, Outlook, outreach).
**The two profiles diverge from today** — a login done in one does not appear
in the other.

`browserName()` in chrome.js is the discovery ( Opera user-path → Opera
system-path → Chrome), `/api/status` returns `browser`, and the UI labels
itself from it ("Launch Opera"). No startUrl on launch — session restore
brings the tabs. Streaming/click/type re-verified green against Opera.

**Round 60 — invisible Chrome + New tab in the viewer (2026-08-31).**

Will asked whether a new tab could exist "only in the Slate tab", was told the
page must run in real Chrome somewhere but the WINDOW can go, and **chose
invisible**: `launchChrome` now passes `--headless=new` (same profile, logins
persist — comment in chrome.js explains the escape hatch: launch by hand
without the flag for a site that fights a windowless browser, README updated
to match). His visible copilot Chrome was killed by PID and relaunched
headless through the API path. **`Page.startScreencast`, input injection and
the whole viewer verified against the headless Chrome** — identical behavior.

**`＋ New tab` lives inside the Tab view** (top-left, own `new-tab-btn` class).
`chrome.openTab()` uses a raw `PUT /json/new` — Chrome 136+ refuses GET there,
and chrome-remote-interface's helper is not trusted with that; the copilot's
own `POST /api/new-tab` wraps it. The button self-heals: if new-tab fails it
POSTs `/api/launch-chrome` (now headless) and retries, so from a cold start
one click gets a working tab. On success it `loadTabs(id)` + sets the dropdown
+ calls `tabSelect.onchange()`, which pins the chat and points the stream.

**Round 59 — the copilot's live, clickable tab view (2026-08-31).**

All in the copilot's own folder; Slate untouched this round. A **Chat | Tab**
toggle in the copilot header swaps the chat feed for a LIVE view of the
selected Chrome tab, streamed over the existing `/ws` socket as CDP screencast
frames (`Page.startScreencast`, JPEG q70, ≤1600px). The composer keeps working
under it — Will can watch the page while telling Claude what to do.

**The preview is clickable, not a picture.** Mouse events on the scaled image
are mapped to page CSS pixels using the frame metadata's `deviceWidth/Height`
and forwarded as `Input.dispatchMouseEvent`; printable keys go via
`Input.insertText`, named keys (Enter, Backspace, arrows…) via
`dispatchKeyEvent` with real virtual key codes. Keys go to the page only while
the viewer is FOCUSED (sage ring says so); cmd/ctrl combos are never forwarded.

**One screencast frame handler per CDP client (`__castSubs` set), never one
per watcher** — every handler must ack (`screencastFrameAck`, Chrome stops
after ~2 unacked) and a second handler double-acks the same sessionId.
`watchTab` calls `bringToFront` first: a background tab never repaints, so it
never sends a frame.

**`syncWatch()` is called from every place the answer changes** — mode toggle,
`activateChat`, the tab dropdown, Claude's own `tab_switched`, and reconnect
('connected' handler; `watching` resets in onclose because the server-side
stream died with the socket). Frames carry no chatId and are handled before
the per-chat dispatch in `handleEvent`.

Verified end-to-end with a driven test tab inside the copilot's Chrome:
frames arrive with viewport metadata, a click through the viewer path focuses
the page's input, typed chars + Backspace land ("hey wil"), and a page change
produces a fresh frame. Screenshotted both views headless. The dropdown label
became "Working on" — the toggle took the word "Tab".

**Round 58 — Browser Copilot embedded on its own tab (2026-08-31).**

Will asked for his Browser Copilot project (`~/Desktop/Browser Copilot/
browser-copilot` — a chat UI driving a headless Agent SDK session with Chrome
CDP tools: read_page / fill_many / click_element etc.) to get a tab in Slate,
rebranded to match.

**IT STAYS ITS OWN APP, AND THAT IS THE DESIGN.** The copilot has real npm
dependencies (express, ws, chrome-remote-interface, zod, the Agent SDK);
absorbing it would end Slate's zero-dependency rule for no gain. The Copilot
tab is an iframe onto `http://localhost:4321`. `src/copilot.js` only knows how
to find the folder, probe `/api/status`, and spawn `node server.js` (with
Slate's own `process.execPath` — node isn't on every launcher's PATH). A smoke
test greps copilot.js the way marks.js is grepped: **no `require('./db')`, no
`draft`, no `assignments`, no `getDb`.** It frames another app; if it ever
grows into Slate's data, that's a decision somebody makes on purpose.

**Not wired to schoolwork on purpose.** No draft access, no assignment context,
nothing passes between the two apps. The copilot's own prompt fills fields but
leaves Submit/Send clicks to the user. Worth remembering: it can drive any tab
in its Chrome profile — that is its entire job — so "wire it to Canvas" or
"give it my draft" would be the round 56 hand-in-flow conversation again.

**`SLATE_OPEN=0` blocks the spawn** — the harnesses click every button they
find, and a Start button that really launched another program under a sweep is
the round 55 pkill story in reverse. Same switch openOnComputer honors; pinned
by a smoke test. All three harnesses also pin `SLATE_COPILOT_DIR` at a missing
folder and `SLATE_COPILOT_URL` at a dead port (`http://127.0.0.1:1`), so the
tab renders the same state every run whether or not the real copilot is up.
The shots harness takes `SHOTS_COPILOT_URL=http://localhost:4321 npm run shots
copilot` for a live look at the framed app.

**`.app-copilot` (full-bleed, no padding, no width cap) is toggled in
`render()`, not in the view** — `app.classList.toggle('app-copilot',
state.view==='copilot')` right after the teardown — so leaving the tab always
takes the layout with it. Same lesson as setChatLane. The not-running /
not-installed states carry their own padding via `.copilot-empty` (own `copilot-`
prefix — round 45's class-collision rule).

**The rebrand lives in the copilot's folder**, not Slate's: `public/style.css`
(Slate palette — #14181D / #1F252C / #8CA891 sage, dark text on accent
buttons), `public/index.html` (Slate arc mark as inline SVG + favicon; the ➤
send glyph became an SVG arrow — round 24, no emoji, and a dingbat on a sage
button is exactly the grey-blob case). The copilot serves static files per
request, so a reload picks the reskin up; no copilot restart needed.

**The running Slate on 4173 predates the `/api/copilot` routes** — the tab
appears (no-store means fresh app.js) but 404s until Slate is restarted. The
404 comes back as `{error:'not found'}`, which renderCopilot reads as
not-installed — wrong message, known, goes away on restart.

**Round 57 — Marks rebuilt on the upstream code (2026-08-27).**

**The tab and heading say "Watermarks"; everything underneath is still
`marks`** — `state.view='marks'`, `src/marks.js`, `/api/marks/*`, the `mark-*`
CSS classes and the `marks*` shot names. Renamed the label only, on purpose:
the internal name is load-bearing in five places and renaming it buys nothing.

Will asked for the repo's actual code to be used. `src/marks.js` is now a port
of **watermarks-remover `service/scripts/text_unicode.py`** (MIT, Guillaume
Meyer and contributors), credited at the top of the file. Translated rather
than wrapped: Slate takes no dependencies and ships no Python. Python's
`unicodedata` becomes Unicode property escapes (`\p{Cf}`, `\p{L}`, `\p{M}`),
which V8 has natively, and NFKC becomes `String.prototype.normalize`.

**ONLY LAYER A WAS PORTED, AND A TEST ENFORCES THAT.** The upstream statistical
layer rewords prose to break token-sampling watermarks; that stays declined
(round 56). A smoke test greps `marks.js` for `rewrite`/`paraphrase`/`synthid`/
`perplexity`/`stylometry` and fails if any appear, alongside the existing test
that it cannot mention `require(`, `draft`, `assignments` or `db.`.

**THE BUG THE PORT FIXED, AND IT IS THE WHOLE POINT OF THE UPSTREAM CODE:** my
first version deleted every invisible character it found. That destroys real
text. A ZWJ between two emoji bases builds one glyph (👨‍👩‍👧 becomes three
people); ZWNJ is ORTHOGRAPHY in Persian and Devanagari (می‌روم); a subdivision
flag IS a run of tag characters after 🏴; variation selectors pick CJK glyph
forms; and bidi marks/isolates are ordinary in mixed RTL prose. **Whether an
invisible character is a payload or part of the writing depends entirely on
what sits next to it** — `decide()` is that context test and it is why this
file is not a regex. The tests that matter are the ones asserting real text
SURVIVES; a naive stripper passes every "did it find the payload" test.

Also gained from upstream: private-use planes, the 66 noncharacters, reserved
default-ignorables (as explicit ranges — **never a "category is Cn" rule**,
which would eat newly assigned characters), Hangul fillers, Khmer inherent
vowels, Mongolian FVS, `206A`–`206F`, interlinear annotation, Latin confusables
(off by default — a Russian word is not a watermark), and a `\p{Cf}` catch-all.

**Bidi is reported but NOT stripped by default.** Preservable marks/isolates and
correctly paired LRE/RLE…PDF survive; overrides (`202D`/`202E`) and unpaired
embeddings do not. `scan()` runs with `stripBidi: true` so the inspector still
shows them; `clean()` does not. Unusual spaces are REPLACED with U+0020, never
deleted — deleting the space between two words joins them.

**`markBusy()` in app.js** is the waiting state Will asked for: SVG spinner
(round 24 took every emoji out), label swap, button disabled, restored in a
`finally`. Honours `prefers-reduced-motion`. Photographed by the
`marks-scanning` shot, which applies the busy state directly — a real scan
returns far too fast to catch by racing it.

**Round 56 — Marks, and where the line was drawn (2026-08-26).**

Will brought `github.com/guillaumemeyer/watermarks-remover` and asked for it to
be applied to **all** the chat's outputs. That repo strips AI provenance marks
in three layers: invisible Unicode, a statistical rewrite pass, and
C2PA/EXIF/XMP from files.

**What was declined and what was built, and the reasoning, because this will
come back.** Auto-applying it to every chat reply on its way into his drafts
was declined — that is the evasion pass his own spec forbids, and since round
51c the chat can write straight into the draft, so it would have completed a
ghostwrite-then-launder path. **The statistical layer stays declined**: it works
by having a model reword his prose until the token signal breaks, which is a
rewriting pass over graded work whose only purpose is defeating detection.

**What WAS built is the inspector, plus a manual strip of invisible characters
on pasted text.** He argued that a detector with no remover teaches half the
mechanism, and he was right. Stripping zero-width characters is a one-line
regex and ordinary text hygiene — refusing to write `.replace()` on a character
class would have been theatre, not a safeguard. The distinction that actually
holds is **hygiene on pasted text vs. a rewriting pass on submitted work**, not
"remove" vs. "detect".

**The design condition is load-bearing: it is its OWN PAGE, on pasted text.**
Not a button on the draft, not attached to a chat reply. `src/marks.js` requires
nothing, touches no database, and knows nothing about assignments — **a test
greps it for `require(`, `draft`, `assignments` and `db` and fails if any
appear.** If it ever grows into the hand-in flow, that should be a decision
somebody makes on purpose, not a drift.

**`scan()` walks by CODE POINT, not code unit.** The tag block (U+E0000–E007F)
and the variation supplement are astral; a `charCodeAt` loop splits them into
surrogate halves and reports two wrong things instead of one right one. Tag
characters shadow printable ASCII one-to-one, so `hidden_message` reassembles
what they spell — that is the single most convincing thing on the page.

**`clean()` leaves the `space` category out of its defaults**, and converts
exotic spaces to a plain space rather than deleting them when asked: a no-break
space is usually deliberate, and deleting the space between two words joins
them.

**`el(tag, cls, html)` SETS innerHTML.** Both places where decoded text reached
it — `hidden_message` and `decodes_to` — were an XSS hole on a page whose entire
purpose is pasting untrusted text, and a tag payload decodes to arbitrary
printable ASCII including `<`. Both now go through `esc()`. **Anything rendered
on this page must be escaped or set with `textContent`.**

Shots: `marks` and `marks-cleaned` (the before/after is the point, so both
states are photographed).

**Round 55 — the hand-in screen was unusable, and Slate is on a Mac now
(2026-08-26).**

**THE BUG: `.panel.handin > * { flex: none; }` OUTRANKS `.handin-paper`.**
Two classes beats one, whatever the source order, so the paper band was pinned
to `flex: none` and took its FULL content height — a 3-page essay measured
4323px inside a 670px popup. `.handin-settings` (file name, format dropdown,
Save / Submit) started at y=4401 and was clipped away by the panel's
`overflow: hidden`. There was no way to hand work in. Fixed by giving it three
classes, `.panel.handin > .handin-paper`, exactly the way round 45 already had
to do it for `> .handin-deck` — the comment there even says why, and the
document path never got the same treatment. **This is the fourth class
collision in this project** (round 31 `.dl-type`, round 45 `pv-`, round 45
`.handin-deck`). A rule like `> *` inside a component is a specificity trap for
every single-class child under it.

**Second, `transform-origin: top center` cannot centre a page wider than its
band.** `.pages` is 816px in a 528px paper, so `margin: 0 auto` resolves to
zero, the origin lands at the middle of the OVERFLOWING box, and the scaled
page sits ~150px right — clipped on one side, gapped on the other. Now
`top left` plus a `marginLeft` that `fitPages` works out. `fitPages` also sets
the sheet's height to the SCALED height: a transform does not change layout, so
the paper was scrolling thousands of pixels past the last page into nothing.

**WHY EVERY CHECK PASSED FOR A WHOLE ROUND.** The `hand-in-popup` shot opens
the popup on an essay with an EMPTY draft, so it photographed "There is nothing
to hand in yet" — no pages, nothing to overflow, screen looks fine. The
document preview, which is the entire point of that screen, was never in a
single picture. **A screen must be photographed in the state it is actually
used in.** New `hand-in-with-draft` step fills the sample essay in through
`arrange` and opens it; new `submit-preview` step covers the Submit-to-Canvas
half, which had never been photographed at all despite sharing `fitPages`.
Both essays in the fixture get the draft — `arrange` filled only the lowest id
while `setup` opens whichever `/api/projects` returns first, which is a
different row, and the first attempt photographed the empty state again.

**`tools/shots/run.js` runs on macOS now** (`findBrowser` has darwin/linux
branches; Chrome at `/Applications/Google Chrome.app/...`) and the viewport is
settable with `SHOTS_WIDTH` / `SHOTS_HEIGHT`, default still 1400x1000.
**The default is TALLER than a laptop** — Will's MacBook Air is 1470x956
points, so a real browser viewport is ~713px. Everything had only ever been
looked at with 287px more headroom than he has. Verified fixed from a 640px
window upward.

**SLATE NOW RUNS ON WILL'S MAC** — `~/Desktop/School Tracker`, a clone of the
GitHub repo. **He connected his real Canvas to it on 2026-08-26, so
`data/slate.db` here holds a REAL token and his real schoolwork, and the
"never write to Will's live data" rule at the top of this file applies to this
machine too.** Node 24 is installed at `~/.local/lib/nodejs` (no Homebrew — he
is NOT an administrator on this Mac, the admin is `johncaldwell`, so nothing
needing sudo can be installed). The installer half of the project
(`install.ps1`, `Install Slate.bat`, `push.js`, `icon.js`) is Windows-only and
cannot run here; `npm test`, `npm run drive` and `npm run shots` all work.
**There are two independent Slates now, one per machine** — same Canvas, but
drafts do not travel between them.

**Harness trap, cost Will's running app:** `pkill -f server.js` killed the
Slate he had open on 4173. Kill a throwaway server by its PID, never by a
pattern that also matches the real one.

**Round 54 — five things Will reported (2026-08-19).**

**"It says it cannot see Canvas."** It could — `refreshFromCanvas` had already
pulled it — but nothing in the prompt said the assignment block WAS Canvas, so
it answered honestly about its tools instead of about what it was holding.
`assignmentContext` now opens with "This block IS the Canvas assignment, pulled
from Canvas when this chat started", and TUTOR_RULES adds "Never claim you
cannot see Canvas". **A model will disclaim a capability it has if you never
tell it the data is the real thing.**

**"The output is not short."** Two separate causes. The model was writing three
paragraphs (prompt now says the reply after an edit is ONE SENTENCE, with an
example), and `summarise` was printing a bullet per change — four slides meant
four lines. `collapseBoxChanges` groups whole-box edits by field and collapses
slide numbers into runs: "Updated bullets on slides 2-4." **Word-level edits
are deliberately NOT collapsed** — on a grammar fix, "their → there" is the
entire information and a count would hide it.

**"Notes went under each bullet in the PowerPoint."** Not a builder bug —
`contentSlideXml` never renders notes. Claude was writing note prose INTO the
`.bullets` box, because "add notes for each bullet point" reads as bullets. The
prompt now says it in capitals: speaker notes go in a `.notes` box, "notes for
each bullet" still means `slideN.notes`, and anything longer than about ten
words is notes in the wrong box. Verified with Will's exact phrasing: bullets
untouched, notes in all four notes boxes, and PowerPoint shows them in the
notes pane.

**Sources are structured data now, not text at the end of the reply.**
`readSources` takes `[{title, url, where, quote}]` off the JSON;
`stripSourceBlock` removes a "Sources:" section if the model writes one anyway,
so the links never appear twice. Stored as JSON in `chat_messages.sources`.
**Only http(s) urls survive** — the list renders as real links, so a
`javascript:` or `file:` url would be a way to get something nasty onto the
page from a model reply. A `where` naming a box that is not on this page is
blanked rather than dropped: the link still shows, it just has nothing to
highlight.

**The highlight is why `where` exists.** Every editable box carries
`data-box="slide3.bullets"` etc; `lightBox()` adds `.src-lit` and scrolls it
into view. **It stays lit until the panel is closed** — Will asked for that,
and he is right: a highlight that follows the pointer is useless when the thing
being lit is behind the panel you are pointing at. `clearLitBoxes()` runs on
close, on shutting the chat, and in `render()`'s teardown.

**Flake, now seen twice:** the live AI phase intermittently reports
"used the offline fallback" for unstuck and notes when Claude Code is under
load. Both came back clean on a straight re-run. Re-run before investigating.

**Round 53 — speaker notes, and a thinking indicator (2026-08-19).**

**A slide is now `{title, bullets[], photo, notes}`.** The notes box is on
every slide card, is the third chat-editable box (`slide3.notes`), and comes
out in the PowerPoint notes pane. Unlike bullets, its line breaks are kept as
typed — it is prose to read aloud, not a list.

**THE NOTES MASTER MUST HAVE ITS OWN THEME PART, AND THIS COST AN HOUR.**
Pointing `notesMaster1.xml.rels` at the existing `theme1.xml` — which the
slide master already owns — makes PowerPoint refuse the whole file with
"The file or directory is corrupted and unreadable" (0x80070570). Not a
repair prompt: a flat refusal. The package is valid at both the ZIP and OPC
layers (`System.IO.Packaging` opens it happily), so nothing short of real
PowerPoint finds it. `ppt/theme/theme2.xml` is a byte-identical copy that
exists purely so the notes master owns one. A smoke test pins it.

**The other three pieces that each cause a repair prompt on their own:** the
`[Content_Types]` override for every notesSlide, the relationship BOTH ways
(slide → notes part, notes part → slide *and* notes master), and
`notesMasterIdLst` sitting between `sldMasterIdLst` and `sldIdLst` —
`p:presentation` is a SEQUENCE, so out of order is a schema violation.

**A slide with no notes gets no notes part**, and whitespace-only notes count
as none (`noteText()` trims). An empty notes part on every slide is legal but
shows in PowerPoint as a deck where every page has notes.

**`saveSlides` is a whitelist**, so a field missing from its map is dropped on
every autosave. That is what would silently eat notes; the same is true of
`normalize()` in the builder.

Verified in real PowerPoint over COM, through the whole app: Claude wrote the
notes for slide 2 from the chat, the .pptx came off the download endpoint, and
PowerPoint opened it clean with the notes on slides 1 and 2 and none on 3.

**`chatSpark()`** is the waiting state — a four-pointed star in `--accent`
that pulses opacity and rotates 45°, 14px, inline with the word. Drawn as SVG
for the same reason the launcher icon is (round 24 took every emoji out), and
it honours `prefers-reduced-motion`. The `.chat-sub` explainer under the
heading is gone — Will asked for it off.

**Round 52 — slideshow boxes, formatting, and a fresh Canvas pull (2026-08-19).**

**A "box" is now the unit an edit names, and that is the whole design.**
`EDIT_TARGETS` became `boxesFor(row)`: an assignment or essay has one box
(`draft`), a slideshow has two per slide (`slide3.title`, `slide3.bullets`).
`loadBox` reads one, `applyBoxEdits` groups the turn's edits by target and runs
each box separately, so one message can change slide 4 and slide 7 and touch
nothing between them. **Slide numbers are 1-based, matching the builder** —
converted once, in `slideBoxRef`; getting that off by one sends every edit to
the wrong slide.

**An edit with no `target` is REFUSED when the page has more than one box.**
Guessing would drop slide 6's bullets onto slide 1. With a single box it still
defaults, so assignment pages behave exactly as before.

**`opts.toHtml` is the formatting fix and it is one line of wiring.**
`proofread.textToHtml` wraps every block in `<p>`; `richtext.textToHtml` knows
"1. a" is an ORDERED LIST, merges numbered points separated by blank lines into
one list, and keeps a short heading line on its own line. `applyEdits` now takes
`toHtml` the same way it already took `toPlainText`, and assignmentChat passes
richtext's. That is the difference between a real list and "1. a 2. b 3. c"
sitting inside a paragraph — exactly what Will reported. `asMarkup` also uses
`textToInlineHtml` now, so a multi-line find/replace keeps its line breaks.

**In a bullets box one LINE is one bullet**, so `spaceBulletInserts` puts a
newline in front of an `at: "end"` insert. Without it "add a bullet" glued the
new text onto the end of the last one and the slide came back with the same
number of bullets, one of them twice as long. Anchored inserts (after/before)
are left alone — those are deliberately mid-line.

**`api.refreshFromCanvas(id)` runs on the FIRST message of a conversation**
(and only then — it is a network round trip), followed by
`ensureAttachmentText`. Sync is hourly, so without it the chat could be
answering about instructions a teacher rewrote an hour ago. Fail-soft: a Canvas
that will not answer leaves the row alone. It only writes fields Canvas owns
(description, files, points, due_at, submission_types) and **never** the draft,
slides, status or completion. When the description changes it clears
`instructions_simple` and `attachment_text` so they get rebuilt.

**Claude does NOT get the Canvas API itself.** Slate fetches and puts it in the
prompt. Handing the hidden `claude -p` a Canvas token would put a real key on a
process whose tool list is deliberately WebSearch/WebFetch and nothing else.

**`getAssignment(courseId, assignmentId)` added to both clients.** The mock
coerces the course id to a Number (the fixture keys courses numerically,
`canvas_class_id` is TEXT, and a strict filter matched nothing) and calls
`module.exports.listAssignments` so tests that stub the mock still work.

**Frontend:** `pageSlides` mirrors `pageDraft` — the builder registers an
`adopt(slides)` and the chat calls it when the response carries `slides`. It
deliberately does NOT save: the server already wrote them, and posting the copy
the page was holding would undo the change it just made. Released in
`render()`'s teardown alongside `pageChat`.

The panel subtitle was "About this assignment. It will not write it for you."
That stopped being true when the rules were rewritten in round 51c, so it now
says what the panel does instead. **A UI that claims a limit the app no longer
has is worse than one that claims nothing.**

Prompt additions Will asked for: simple everyday words, do only what was asked,
and after an edit keep the reply to a sentence or two rather than repeating the
new text (the receipt already lists every change). Pinned by drive checks.
**Round 60 addendum (2026-08-31): two repos now, and the Mac pushes fine.**
Browser Copilot has its own PRIVATE repo, `wcaldwell2009/browser-copilot`
(created via the GitHub API with the keychain credential — `gh` is not
installed on the Mac and can't be without admin). Plain `git push` works on
the Mac through the osxkeychain credential; `user.name`/`user.email` are now
set globally (Will Caldwell / wcaldwell2009@gmail.com). Its `.gitignore`
keeps out `node_modules/` and `.claude/`. The Windows `gh.exe` note below is
Windows-only.

## GitHub — the project is a git repo now (round 50, 2026-08-15)
**`https://github.com/wcaldwell2009/slate`, PRIVATE.** The workshop folder is
the repo; `main` is the branch. Auth is the GitHub CLI (`gh`, installed via
winget, logged in as wcaldwell2009 with a keyring token) — `gh` is NOT on the
default PATH from this harness, use `"$env:ProgramFiles\GitHub CLI\gh.exe"`.

**`.gitignore` is the whole safety story and it was already right: `data/`,
`dist/`, `*.db`, `.env`, `node_modules/`.** That is what keeps Will's Canvas
token, `slate.db`, his drafts, his class-note photos and every downloaded
attachment off GitHub. **Anything new that writes user data must land under
`data/` (i.e. `SLATE_DATA_DIR`), which is already the rule for other reasons —
now it is also what stops it being published.** Verified at the first commit:
67 files, zero matches for data/dist/.env/db.

Will is non-technical and does not use git. **He says "save it to github" and
that means commit + push** — that phrase IS the approval, no need to re-ask.
Pushing leaves the machine, so a push he did not ask for still needs an OK.

The repo does expose his school (`jcseagles.instructure.com` appears in
CLAUDE.md and README.md). Fine while private; it's the thing to raise if he ever
asks to make it public.

## THE SHIP WORKFLOW — read this before touching code
There are **two copies of Slate** and they must not be confused.

- **Workshop** = this project folder, port **4173**, its own sample data in
  `./data`. This is where edits happen.
- **Installed app** = `%LOCALAPPDATA%\Slate`, port **4174**, Will's real data.
  A Desktop shortcut (`Slate.lnk`) points at it. This is what Will actually uses.

**After every edit: do NOT install.** Start the workshop server and give Will the
localhost link so he can look. Edits pile up there.

**Only when Will says "push it"** (or equivalent): run `npm run push`. That
builds a fresh snapshot into `dist/slate-app`, bumps the build number, closes the
running installed app, deletes the old `app` folder and installs the new one. The
Desktop icon and all of Will's data stay put.

`npm run build:installer` builds the snapshot without installing.
`Install Slate.bat` is the double-clickable installer for Will.

**Never let an update touch Will's data.** The installed layout keeps data out of
the app folder on purpose, because the updater deletes that folder wholesale:
```
%LOCALAPPDATA%\Slate\app\            the snapshot — DELETED AND REPLACED on update
%LOCALAPPDATA%\Slate\data\           slate.db + notes — never touched
%LOCALAPPDATA%\Slate\.env            Canvas token — never touched
%LOCALAPPDATA%\Slate\launch.js       entry point (from tools/installer/payload/)
%LOCALAPPDATA%\Slate\Slate.vbs       hidden launcher the shortcut runs
%LOCALAPPDATA%\Slate\slate-log.txt   last start's log
```
Three env vars make that work and all three must keep working: `SLATE_DATA_DIR`
(db.js + notesAI.js), `SLATE_HOME` (load-env.js finds `.env` there),
`SLATE_INSTALLED=1` (turns on the Quit button + build tag). If you add a feature
that writes files, write them under `SLATE_DATA_DIR`, never beside the code.

**The Quit button only exists on the installed copy.** That is deliberate: the
drive harness clicks every button it can find, and `/api/quit` on the dev server
would shut the harness's own server down mid-run. `/api/quit` returns 403 unless
`SLATE_INSTALLED=1`, and there are drive checks pinning both halves.

**Resolved:** the cut-off request turned out to be "put the nav bar along the
side instead of the top" — done, nav is now a left sidebar (logo top, tabs
middle, sync at bottom; folds back to a top bar under 720px width).

**Round 4:** projects and tests open full pages like assignments (views
'project'/'test' in app.js; popups removed for them — overlay now only used for
the submit-file confirmation). Test page
hosts the study timer + flashcards. Detail pages highlight their parent tab.

**Round 5 — notes → AI study material:** drag a notes file onto a test card on
the Tests page. `src/notesAI.js` saves it to `data/notes/`, sets
tests.notes_status='processing', and (via a promise queue, one at a time) runs
`claude -p --output-format text --allowedTools Read` in a hidden terminal
(windowsHide; on Windows via `cmd /c claude`). It returns strict JSON
{flashcards, notes}; cards are appended (dedup by front), notes appended under a
per-file header, status→done. Fallback = built-in generateCards + raw text when
Claude Code missing/times out/errors or SLATE_NO_AI=1. Verified live: `claude`
is on PATH, real run produced good cards + summary. Test page has a
Flashcards/Notes switcher (swaps only that region so the study timer keeps
running). Study log = time_logged counting up toward goal (2h test / 30m quiz);
budget default raised 90→120. Tests page polls every 3s while any test is
processing. Smoke suite now 13 tests (runs notes path with SLATE_NO_AI=1),
all green.

**Dependency note:** the notes AI needs Claude Code installed + logged in
(it is, on Will's machine). Uses his Claude plan. Nothing else leaves the box.

**Round 7 — PowerPoint builder + download picker.** `src/officegen.js` = zero-dep
generator (own ZIP writer via zlib deflateRaw + CRC32) for real .pptx/.docx, a
hand-rolled text .pdf, plus .html slideshow and .txt. Verified pptx opens clean
in actual PowerPoint (COM, no repair) — both a unit file and one made through
the full app flow. Projects get build_mode='slides' (llm.buildMode: keywords +
.pptx attachments); project page shows a slide builder (title + bullets per
slide, autosave to assignments.slides_json). Unified download system: GET
/api/download-options?kind=&id= returns default name + formats; POST /api/download
{kind,id,filename,format} builds bytes and writes to Desktop (numbered if name
exists). Frontend openDownloadPopup(kind,id,onComplete): editable name +
type dropdown (changing type downloads that format). Text submit + slide submit
both route through it. Old /assignments/:id/submit and GET /download removed.
Smoke suite now 15 tests, all green. officegen formats: text→txt/docx/pdf,
slides→pptx/html/txt.

**Round 8 — styled PPTX + auto images (2026-07-22).** officegen pptx redesigned
with explicit shapes (Slate colors: bg 14181D, accent 8CA891, text E8E6E1):
styled title slide, accent headings + underline, bullets left / image right,
rounded picture with border, auto "Image credits" slide. `src/images.js` fetches
one image per slide: **Wikimedia Commons primary** (relevance >> open-photo
search — real diagrams/NASA), Openverse fallback; tries original URL then
thumbnail; only successes cached to data/images (failures NOT cached so
transient blips retry); non-localized Commons titles preferred. Images embedded
as ppt/media + rels; jpg/jpeg/png Content-Types (must NOT duplicate — a dup
Default corrupts the file, that was the first bug). Verified in REAL PowerPoint
via COM: exported slide PNGs and eyeballed them — title/content/credits all
correct, no repair. performDownload is async now (awaits image fetch) for
pptx/html only. Off-switch SLATE_NO_IMAGES=1 (tests use it). Frontend popup warns
slideshows take a few seconds. Smoke suite 16 tests, all green.

**Round 9 — simplified instructions + slide-seed fix (2026-07-22).** Every
work/project page shows an "Instructions" box up top: `src/simplify.js` rewrites
raw_description into 2-4 plain sentences. Order: ANTHROPIC_API_KEY (fast) →
hidden `claude -p` (no key needed, ~15s cold, queued one-at-a-time) → rule-based
(first 3 sentences). Cached in assignments.instructions_simple. Lazy: detail
returns instructions_ai (cached|null) + instructions_plain (instant fallback);
frontend instructionsSection() shows plain immediately, POSTs
/api/assignments/:id/simplify, swaps in AI version. Works for projects too (same
table). Verified live via Claude Code: "make 6-8 slides…" → clean plain summary.
Fixed seedSlides: was turning project steps into slide titles (e.g. "Build 6-8
slides" became a slide header) — now just title slide + 1 blank; that info
belongs in Instructions. Smoke suite 17 tests, all green.

**Round 10 — auto slide outline (2026-07-22).** `src/outline.js` generates a
slide outline for slideshow projects: reads instructions, `slideCountFromText()`
pulls a count ("6-8 slides"→7 midpoint), Claude picks a specific subject when
told to choose one and fills every slide HEADER (titles only — student writes
content, keeps the no-auto-writing rule). Claude API → hidden `claude -p` →
rule-based fallback (generic headers, count honored). POST
/api/projects/:id/outline saves to slides_json, returns slides. projectDetail
adds has_custom_slides (=!!slides_json). Frontend buildSlideMaker auto-calls
outline on first open when !has_custom_slides (shows "Building your slide
outline…"), plus an "✨ Auto-fill outline" button to regenerate. Verified live:
"choose a founding document / 6-8 slides" → 7 slides titled around the U.S.
Constitution. ~19s cold (Claude Code). Smoke suite 18 tests, all green.

**Round 49 — Fill suggestions off, shipped (2026-08-15).**

The **Fill suggestions** button is off the slide builder — Will said "for now",
so **`outline.generateSuggestions()`, `api.fillSlideSuggestions()` and
`POST /api/projects/:id/suggestions` are all still there and still work.**
Putting it back is re-adding a button, nothing more. The slide builder now has
no controls at all above the slides; the outline still builds itself on first
open via `autoOutline()`.

Pushed to the installed app — see THE SHIP WORKFLOW.

**Round 48 — the project plan is gone (2026-08-15).** Will asked for it out.

**Nothing user-facing shows chunks any more.** `projectDetail` no longer returns
`chunks` / `current_chunk` / `progress` / `all_done`; `projects()` no longer
returns `progress` / `todays_chunk` / `all_done`; the project page lost the plan
list and the compile button; the projects list lost "N of M pieces done".
**Removed from the API on purpose, not just hidden** — a payload still carrying
chunks quietly grows a UI again. Tests and drive checks assert their absence.

**Today's Projects tab lists WHOLE PROJECTS**, soonest due first (limit 8), with
Finished = projects completed today. `todayPlan.project_minutes` is now always 0
and `total_minutes === assignment_minutes`: the 2-hour day counts only what is
genuinely due. `full_on_assignments` still exists and still drives the
"you're done for the day" wording.

**`project_chunks`, `pacing.js`, `planAllProjects()` and `/api/chunks/:id/done`
all still exist and still run.** Deleting them would be a migration and a large
blast radius for no gain; sync keeps planning chunks that nothing reads. If the
plan is ever wanted back, the data is there. `projectProgress()` and
`/compile` are likewise still there, now unused by the UI.

A guide-mode project had no builder and therefore no way to be finished once the
plan went, so it gets a plain **Mark complete**.

**Round 47 — the slide strip scrolls itself (2026-08-15).**

`keepInView(i)` in `renderSlides`: picking a card scrolls the strip so the card
**two ahead** is fully visible, which is what makes the next couple clickable
without dragging. It only scrolls when the target is actually off the end — a
card sitting mid-strip must not jump to the edge under the cursor — and it never
scrolls so far that the selected card itself goes out of view. Runs from
`show()`, so the arrows and arrow keys move the strip too.

**Guarded for the DOM shim**: `offsetLeft` is undefined there, so it returns
early. The drive harness can only prove it doesn't throw; the scrolling itself
was checked in a real browser (`npm run shots slides-handin-slide5` — slide 5
picked, 6 and 7 both on screen).

**Round 46 — Fill suggestions + slide thumbnails (2026-08-15).**

"Build your slideshow" and its explainer paragraph removed. **"Auto-fill
outline" → "Fill suggestions"**; the outline still builds itself silently on
first open (`autoOutline()` is now internal), and the visible button researches.

**`generateSuggestions()` in outline.js runs the hidden `claude -p` with
`--allowedTools WebSearch,WebFetch` and a 4-minute timeout.** It is the only
place in Slate that gives Claude Code the web, and the tool list is exactly
those two — no Read, no Write, no Bash. Verified live: 66s, and it came back with
real specifics (Great Compromise/Roger Sherman, Montesquieu 1748, New Hampshire
ratifying ninth on 21 June 1788).

**WHERE THIS SITS RELATIVE TO THE NO-GHOSTWRITING RULE.** The prompt asks for
the POINTS TO COVER and the facts behind them, and says twice that these are
notes the student rewrites, not finished presentation sentences. That is the
same side of the line as round 12's coach and round 10's headers-only outline.
If this ever gets extended toward polished slide copy, that is the line being
crossed — the rule is in "What this project is" at the top of this file.

**`fillSlideSuggestions()` never overwrites writing.** A slide with any non-empty
bullet is returned untouched, and slide 0 is always skipped (its bullet is the
subtitle). A test types on a slide and asserts it survives — pressing the button
twice must be safe.

**Thumbnails are "Slide N" plus a real miniature**, rendered by the SAME
`slideStage()` as the big one at 152x85.5px. That works only because the slide's
type is sized in `cqw` against `container-type: size` — there is no second
layout to keep in step. Do not "optimise" that into a separate small renderer.

**Round 45 — the PowerPoint hand-in (2026-08-15).**

Button is **"Make my PowerPoint"**. The hand-in popup keeps everything except the
MLA heading editor (a slide has nowhere to put name/teacher/class/date), and
shows a real deck instead of Word pages.

`submissionPreview` returns **`slides`** when `c.ck === 'slides'`, and sets
`heading: null` so the heading editor can't render. `formatting` says "7 slides,
PowerPoint" rather than claiming Times New Roman 12.

`renderSlides(host, p)` + `slideStage(slide, i, total)` in app.js draw a 16:9
stage mirroring what `buildPptx` produces — slide 0 IS the title slide, content
slides get a 2-digit kicker, sage heading + rule, a card per bullet, and **fall
back to a plain list over 6 bullets exactly like the .pptx does**, so the preview
never flatters the output. Thumbnail strip, arrows and arrow keys all move it.
Used on BOTH hand-in routes (Save to Desktop and Submit to Canvas).

**THE PREVIEW CLASSES ARE PREFIXED `pv-`, AND THAT IS LOAD-BEARING.** They were
`.slide-title` / `.slide-bullets` / `.title-slide` first — which are the slide
EDITOR's input and textarea styles, defined later in styles.css and therefore
winning on source order. The preview rendered its heading inside a text-input
box. This is the third class collision in this project (round 31's `.dl-type`
was the first). **A new component gets its own prefix.**

**A 16:9 slide sized off the panel WIDTH pushed the file name and buttons off
the bottom** — round 32 all over again. `.panel.handin > .handin-deck` (three
classes, so it outranks `.panel.handin > *`) is the flex child, the stage takes
its height from that band, and the text scales in **`cqw`** off
`container-type: size` so it tracks the slide rather than the browser window.

Found by looking at the screenshots, not by any check — see round 44.
`npm run shots` also learned to clip to the viewport when the overlay is open
(a popup shot was being stretched to the scroll height of the page behind it)
and its steps are now self-contained, so a filtered run shows the same thing as
a full one.

**Round 44 — `npm run shots`: actually looking at it (2026-08-15).**

Will: "if you make an edit you should click through everything you made or
changed on the website too, not just look at the code." He is right, and the
drive harness cannot do it — its DOM shim has **no layout engine**, so it can
confirm a button exists and that clicking it throws nothing, and it can never
say whether the page looks right. Round 35 and round 42 were both bugs of that
exact shape.

**`tools/shots/run.js` drives a REAL browser.** Headless Edge/Chrome over the
DevTools Protocol using **node's built-in WebSocket** — still zero dependencies.
Boots its own server on its own database with mock Canvas (**never 4173**;
walking the app means clicking, and clicking marks work complete), sets
`state.view` in the page, screenshots each screen full-height into
`dist/shots/`, and collects `Runtime.exceptionThrown` so a page that looks fine
while sitting on a thrown error still reports. `npm run shots tests` filters by
name.

**It found two bugs on its first run, both of which every code check passed:**
1. The Instructions checklist on an assignment with an attachment listed
   `organelle_worksheet.docx` and **`From the attached file "…":`** — Slate's own
   header text, rendered to the student. Round 18's bug all over again.
   `simplify(raw, title, fallbackRaw)` now takes a THIRD argument: reasoning
   gets description + file text, the rule-based path gets **description only**,
   because all it can do is slice off the first few sentences.
   `attachments.stripFileLinks()` also pulls file anchors out of the description
   before it becomes instructions or guide steps — the file has its own button.
2. "Slate is reading these to fill in the instructions." never went away; the
   detail is fetched before the read finishes. Removed.

Also: a class with no Formative/Summative left a hole under the percent where
the other cards have two boxes. It says so in words now.

**PORTS COME FROM THE OS, NEVER A GUESS.** The first version picked 4620 and
photographed a stray server left listening there from an earlier command — every
check green, every screenshot of the OLD code. Rounds 18 and 23 both record this
same trap. `freePort()` binds port 0 and asks.

**Round 43 — the filter that "didn't work" (2026-08-15).**

Will reported the Tests time frame doing nothing. **The code was correct** — the
page in his window had been loaded against a server process started before the
`?weeks=` route existed, so it kept answering with everything. A reload fixed
it. Two real problems sat underneath, and both are now closed:

**`serveStatic` sends `cache-control: no-store, must-revalidate`.** It sent no
cache headers at all, so a long-lived Edge `--app` window could keep serving
yesterday's app.js against today's server: the page looks right and quietly does
nothing. Slate is served from the machine it runs on; caching buys nothing here.
**After an edit, tell Will to reload** — and now that actually works.

**The drive check was worthless and passed anyway.** It asserted
`narrowed <= allCount`, which is true when the filter does nothing, AND every
quiz in the fixture was inside a week so the windows were identical. Both fixed:
mock quiz 6005 is `dueAt(20)`, and the checks now demand **strictly fewer** for
1 week and **strictly more** for 4 weeks, plus six API-level checks on the window
sizes. **A filter check that only says "no more than" is not a check.**

**Round 42 — live page count + test time frame (2026-08-15).**

**`line-height: 2` IS NOT DOUBLE SPACING.** Word doubles the FONT's own line
height, and Times New Roman's is ~1.15em, so a double-spaced TNR 12 line is
~27.6pt (36.8px), not 24pt. At `2` the preview fitted **27 lines to a page where
Word fits 23** — it had been under-counting pages by about one in six since the
preview existed. `.page-body` is `line-height: 2.3` now. **Measured in real Word
over COM**, sweeping MLA documents of known line count: 23 lines = 1 page, 24 =
2. A smoke test recomputes `floor(864 / (16 * lineHeight)) === 23` **from
styles.css**, because the drive harness's DOM shim has no layout engine and
cannot reproduce a page break — same lesson as round 35.

**`pageMeter(kind, id, getDraft)` in app.js** puts "about 2.4 pages in Word"
under both editors. It flushes the draft, fetches `submit-preview?light=1` and
runs **the same `renderPages()`** the hand-in screen uses, into a host that is
`visibility: hidden` and parked off-screen — **not `display:none`**, which has no
layout and would put everything on page one. Debounced off the draft-saved
callback (~2s after typing stops), single-flight with a re-run flag, and every
failure just blanks the label rather than breaking the editor.

`buildEssayEditor(body, p)` has no `projectId` in scope — it's `p.id`. Cost a
drive run.

**`api.tests(weeks)`** takes 1-4 (clamped; anything else means all) and windows
**forward from today**: something already sat only appears under All. A test with
a NULL due_date is kept in every window — a date filter can't judge it and
dropping it would hide it outright. `state.testWeeks` drives the switcher, which
opens on All so the page behaves as it always did until Will narrows it.

**Round 41 — hourly sync + formative/summative (2026-08-15).**

**The hourly sync is a `setInterval` in the running server**, not a Windows
scheduled task. Deliberate: Will asked for "every hour when my computer is on
and the program is open", and a timer inside the process is exactly that — it
exists only while Slate does and leaves nothing behind on the machine.
`SYNC_EVERY_MS` (env `SLATE_SYNC_EVERY_MS`, which is how the test sits through
it in 4s), `SLATE_NO_AUTOSYNC=1` turns it off for the test suite and the drive
harness. The timer is `unref()`'d so it can't hold the process open.

**`runSync()` in server.js is now the ONLY way a sync starts.** Both the timer
and `POST /api/sync` go through it, and a second caller gets the in-flight
promise rather than starting a parallel sync over the same rows. A test fires
two syncs at once and asserts they come back with identical counts.

**Formative/summative comes from the Canvas ASSIGNMENT GROUP, never from the
title.** Will's school runs "Formative" and "Summative" at 50-50 in every class;
`listAssignmentGroups()` maps `assignment_group_id` → name and `categoryOf()`
normalises it. Both `upsertAssignment` AND `upsertGradedAssignment` set it — the
second was missed first time round and left every already-graded assignment
untagged, which is exactly the rows the class page lists.

**A category percent is that category's OWN points.** Canvas's weighting is
BETWEEN categories, and the overall grade already accounts for it, so summing
within one category is right. **Nothing graded gives `pct: null`, never 0** — a
0 next to Summative reads as a failing grade. `has_split` is false for a class on
plain Canvas defaults ("Assignments" / "Imported Assignments") and the card then
shows the overall figure alone.

**Round 40 — grades actually arrive (2026-08-15).**

**`student_ids=self` makes Canvas answer HTTP 500.** Not 400, not an empty
list — a 500. `tryFetch` politely stepped over it, so nothing ever looked
broken; the grades table simply stayed at 0 rows for Will's whole first week and
the GPA read blank. Canvas wants **`student_ids[]=self`**. `api()` in
canvasClient now expands any array param to repeated `name[]=`. **A test stubs
fetch and asserts the query string** — this one is invisible from the outside,
so it has to be pinned at the wire.

Same bug silently killed **`markSubmittedDone`** (round 36) — with no
submissions, Canvas could never tell Slate anything was handed in.

**`getEnrollmentGrade` existed and was never called by anything.** Now it is, and
its answer is stored on `classes.canvas_score` / `canvas_letter`.

**THE CLASS GRADE IS CANVAS'S NUMBER, NOT A SUM OF POINTS.** Teachers weight
categories; Canvas has already applied that weighting. Adding up raw points
gives a different figure, and quoting Will a grade that exists nowhere else is
worse than showing nothing. `classGrade()` prefers `canvas_score` and only falls
back to the points total for a class Canvas hasn't graded. `saveCanvasGrade`
ignores a null answer rather than blanking a grade Canvas already gave.

`recordScores()` matches submission scores onto assignments already in the table
(real Canvas returns nothing from `listPastAssignments`). `points_possible` is
absent from the submission object, so it falls back to the assignment's own
points. **An exam lives in `tests`, not `assignments`, so its score is skipped
here** — another reason the headline grade must come from the enrollment.

**`markSubmittedDone` no longer stamps today when Canvas gives no date.** Work
graded on paper has `score` and `workflow_state:'graded'` but no `submitted_at`.
It uses `submitted_at || graded_at`, and with neither marks the row done with
**no `completed_at`/`completed_day`** — round 26's rule, no stamp means
historical. Otherwise the first successful sync dumps a whole term of graded
work into "Finished today".

Verified read-only against his live Canvas: 5 graded items, 100% in AP Cyber /
AP Pre-Calc / English IV, four classes not yet graded, GPA 4.0.

**Round 39 — Canvas attachments (2026-08-15).** The Future Work item from round
2 onwards, finally done. `src/attachments.js`.

**Real Canvas has NO `attachments` field on an assignment.** This is the whole
reason the feature never worked: `upsertAssignment` read `a.attachments`, which
real Canvas never sends, so `files` was `[]` on all 35 of Will's assignments. A
teacher's attachment is an `<a class="instructure_file_link">` **inside the
description HTML**, pointing at `/courses/<cid>/files/<fid>`.
`linksFromDescription()` parses those out; `attachmentsFor()` takes either shape
so the mock's array still works. Deduped by file id — his three yearbook
assignments link the identical file. `title="Link"` happens, so the anchor text
is the fallback name.

**All bytes come from the Canvas client, never a `fetch()` in attachments.js.**
`client.downloadFile(file)` asks `/files/:id` for a FRESH pre-signed url (the
verifier in a description expires) and falls back to the href. That's what lets
mockCanvas serve a **real .docx** — built with `officegen.makeZip` — so the
whole path is testable with no network.

**Reading is by hand and zero-dependency.** Office files are ZIPs: `zipEntries`
walks the **central directory**, not the local headers, because a streamed entry
carries zeroes for its sizes. docx → `word/document.xml`, pptx → every
`ppt/slides/slideN.xml`, xlsx → `xl/sharedStrings.xml`. **PDFs and photos go to
Claude** (`askAboutFile` in claude.js → hidden `claude -p --allowedTools Read`;
the API path uses a `document` block). Verified live: an 890-byte PDF read back
word for word in 11s.

**`ensureAttachmentText` runs inside `ensureSimplified`,** so the Instructions
box is built from description + attachment. That's the point — teachers here
write "worksheet attached" and put the directions in the file. Cached in
`assignments.attachment_text` / `attachment_state`; fail-soft, like classNotes —
an unreadable file never stops the page or the other attachments.

**Files are addressed by POSITION in the list, never by a name from the page**
(`POST /api/assignments/:id/files/open {index}`), so no path can be smuggled in
from the browser. `openOnComputer` shells out to `start`/`open`/`xdg-open` —
Slate has no viewer of its own on purpose. `SLATE_OPEN=0` (tests + drive) skips
the launch but still downloads.

Both harnesses now set `SLATE_DATA_DIR` to their temp dir, so downloads and
notes stop landing in the real `data/` folder.

**Round 38 — sync prunes the schedule (2026-08-14).**

**Sync was add-only.** Will changed his schedule two days into the year; the new
classes arrived and the dropped ones stayed forever. `pruneClasses()` in sync.js
now treats Canvas's course list as the schedule — a class whose
`canvas_class_id` isn't in it gets `classes.archived = 1`, and one that comes
back gets `archived = 0` again.

**Archived, never deleted, and that is the whole design.** Drafts, class notes,
flashcards, study time and completion stamps all hang off a class; a wrong guess
that deleted would be unrecoverable, and archiving reverses itself for free. A
test asserts the rows and a draft survive an archive/return round trip.

**`pruneClasses` returns 0 on an empty course list.** A Canvas that answers with
nothing is a bad answer, not evidence Will dropped out of school. Pinned by a
test.

**`LIVE_CLASS` (= `'c.archived = 0'`) in api.js is the filter and every list
query joins classes to use it** — Today (both queries), finishedToday,
`scheduledForToday` (which had to GAIN the join), both todayPlan chunk queries,
all five week queries, projects, tests, and `classes()`. **Any new query that
joins classes needs it**, or archived work reappears. Detail-by-id queries
deliberately don't filter — you can only reach them from a list.

`sync()` returns `hidden` in its counts and `classes` now counts active ones
only.

**Round 37 — week tidy-up + day popup (2026-08-14).**

`doneSwitcher()` replaces the stacked Unfinished/Finished sections with a
`.toggle-group`, driven by **`state.doneTab`, shared by Today and Week** on
purpose. `section()` is now only used by nothing — kept for the moment but the
Today/Week paths build their own grid.

**Week projects come from `assignments` by due_date, not `project_chunks` by
scheduled day.** A project used to appear on every day it had a chunk, which put
the same one across five columns. Mock fixture moved: "Founding Document
Analysis" is `dueAt(5)` so at least one project falls inside the 7-day window,
otherwise the rule has nothing to show.

`week()` now returns `id` on every item so `openWeekDay()` can route a click to
the right page (`work` / `project` / `test`). Day columns are `.clickable` with
an onclick.

**Harness note:** anything asserting finished work is *visible* on Today has to
switch tabs first — Today opens on Unfinished, so a finished card is not in the
DOM until the switcher is clicked. One check now asserts the count on the
switcher instead.

**Round 36 — carry-over + no auto-indent (2026-08-14).**

**Unfinished work rolls over.** `todayAssignments` selects `due_date <= today`
for `status='todo'`, flags `overdue` + `days_late`, and **sorts overdue above
today's above work-ahead whatever the sort is** — so the impact sort now orders
*within* a band, not across (two tests had to learn that).

**`markSubmittedDone()` in sync.js** marks anything Canvas has received as done,
stamped with `submitted_at`'s day so it lands in the right Finished list.
Canvas wins over a local reopen — if Canvas has it, it's in.

**`scheduledForToday()` must stay stable across the day.** It counts work due
today (any status) PLUS carried-over work that is either still todo *or was
completed today*. Without that last clause the number shrank as Will worked
through late items, and a busy day would start pulling work forward halfway
through. That was a real flaw in the first version of this.

**Harness gotcha:** anything that completes "the first assignment" and then
looks for it in the WEEK must pick one `!overdue` — the week's columns start at
today, so a carried-over item lands in a day the week doesn't show. Two checks
broke on exactly that. Mock fixture: assignment 5105 is due `dueAt(-2)` and
never submitted.

**No auto-indent anywhere.** The first-line indent is gone from `buildMlaDocx`
(`firstLine` unused now), `buildMlaPdf`, `mla.toText` (both the block and the
plain-draft branches — the second was missed first time) and `.doc-para` in the
preview. List indents stay: that's list formatting, not an auto-indent.

**Round 35 — pagination + stationary preview (2026-08-14).**

**Every block was landing on its own page.** `.page-body` had `height: 100%`,
so `scrollHeight` came back as a full page no matter what was in it and every
block after the first looked like an overflow. **`.page-body` must stay
auto-height** — the `.page` around it is the fixed, clipping one — and the
paginator now measures `body.offsetHeight > PAGE_H` (offsetHeight includes the
body's own 96px padding, hence the full page height, not the text area).
The generated .docx was never affected; this was preview-only.

**The hand-in popup is three fixed bands**: `.panel-head` (title centred, close
button absolutely positioned so the title centres on the panel rather than
beside the button), `.handin-paper` (the only scroller), and `.handin-settings`
(everything else, pinned at the bottom). `.panel.handin` has
`overflow: hidden` — the panel itself never scrolls.

**The drive harness cannot catch layout bugs** — the DOM shim has no layout
engine, and a fake `offsetHeight` on `.page-body` does NOT reproduce this one,
because the real fault was a browser measuring a CSS-fixed element. A smoke test
reads styles.css and fails if `.page-body` regains a `height:` declaration.
Verified by reintroducing the bug and watching it fail. **For anything that only
goes wrong in a real browser, guard it by asserting on the source, not through
the shim.**

**Round 34 — document structure fixes (2026-08-14).** Will's real assignment
exposed two `textToHtml` bugs, both only visible with the way people actually
type:

1. **A heading on its own line got swallowed.** "Big Idea:" followed by the
   paragraph beneath it became one paragraph, because line breaks inside a block
   are treated as soft wrapping. Now a **short** (≤60 char) first line ending in
   a colon splits off as its own paragraph. The length guard matters — prose
   containing a colon mid-sentence must stay one paragraph.
2. **Numbered points separated by blank lines became five one-item lists**, so
   every question rendered as "1.". Adjacent lists of the same type are merged.

**`toText` and `buildMlaPdf` now render from `doc.blocks` too**, like
`buildMlaDocx` already did — otherwise the .txt and .pdf disagreed with the
.docx about where a heading ended. One model, three renderers; that was the
point of the block model and two of the three weren't using it.

Verified on his actual work in real Word: 2 pages, TNR 12, double spaced,
heading its own line, questions numbered 1-5.

**Round 33 — rich editor + page preview (2026-08-14).**

**`src/richtext.js` is the new middle layer.** The assignment editor is
contenteditable, so drafts can carry formatting. `parseHtml()` turns the
editor's HTML into blocks of runs `{text,b,i,u,font,size}`; the Word builder,
the PDF builder and the on-screen page preview all render from that one model.

**`draft_html` is the formatted draft; `draft_text` stays the plain version**,
derived server-side in `saveDraft` via `toPlainText`. That is deliberate — word
counts, the essay outline, the AI checker, the MLA Works-Cited split and the
`.txt` download all keep working on plain text exactly as before. **Do not make
anything else read `draft_html` directly.** Old plain drafts open through
`textToHtml`.

**`doc_font` / `doc_size` (null = MLA).** The toolbar's font and size pickers
set the DOCUMENT default, not a selection, and POST to
`/api/assignments/:id/doc-style`. `buildMlaDocx` writes them into
`docDefaults`; per-run bold/italic/underline/font/size go in `w:rPr`.

**Page preview.** `renderPages()` builds real 816x1056px pages (8.5x11in at
96dpi) with 96px margins, flowing blocks in and starting a new page when
`scrollHeight` passes the body height; `fitPages()` scales the stack to the
available width. `.panel.handin` is `height: 94vh` and
`width: calc(94vh * 0.773 + 52px)` — the page aspect ratio — so the document
never looks squashed.

**The essay editor was deliberately NOT converted.** `renderEssayEditor`'s
outline, click-to-jump and the Get-unstuck stuck-note all work off
`ta.selectionStart` in a textarea; porting them to contenteditable selections is
its own piece of work. It keeps `listToolbar` (plain-text "• " / "1. "
markers). Told Will explicitly.

**Round 32 — hand-in screen fits (2026-08-14).** Round 31's preview pushed the
file-name row and the buttons off the bottom. `.panel.handin` is now compact
(18/20 padding, smaller labels, inputs and gaps) and the paper is capped at
`34vh` via `.submit-preview.handin-paper` — **two classes on purpose**, because
`.submit-preview` further down the file sets `max-height: 40vh` and would
otherwise win on source order. `.panel.handin` also gets `overflow-y: auto` as a
last-resort so nothing can be unreachable on a short window. Type styling stays
with `.paper`; the handin rule only does layout.

"Use these" → **"Save"** in both places (heading editor and the essay hand-in
panel); the "Shortened from…" and "the date fills itself in" lines are gone, as
is the footer explainer. Drive checks now assert the file-name row and the
actions are still children of the panel.

**Round 31 — preview on the hand-in screen (2026-08-14).** The document preview
only existed on the Submit-to-Canvas screen, so the Save-to-Desktop route never
showed it. `openDownloadPopup` now renders it first — directly under the title,
above the file name/type row — along with the heading editor.

**Only the paper scrolls**: `.panel.handin` is a flex column with
`max-height: calc(100vh - 80px)`, every child is `flex: none` except
`.handin-paper`, which takes the remaining space and scrolls. `closePanel`
resets `panel.className` so that layout can't leak into the other popups.

`submissionPreview(..., {light:true})` (`?light=1`) skips the `getMySubmission`
Canvas round-trip — prior attempts only matter on the Submit screen. ~25ms.

**Class collision worth remembering:** the Mr./Mrs. picker was `select.dl-type`,
the same class as the FILE TYPE dropdown, and the drive harness grabs
`.dl-type` to change formats — it found the title picker instead and crashed.
The picker is now `dl-type heading-title` and the harness excludes it. **Two
selects on one panel need distinguishable classes.**

**Round 30 — the work-ahead gate (2026-08-14).** The lookahead was gated on how
many assignments were **still todo** today, so clearing a three-assignment day
took the count to 0 and pulled next week's work in. **It is now gated on how many
were SCHEDULED for today, finished or not** — a `COUNT(*)` over due_date with no
status filter. Finishing work can no longer change what kind of day it was.

`todayPlan` returns `scheduled_today_count`; the Today page uses it to tell
"you cleared a real day" (→ "You're done for the day") apart from "today was
always empty" (→ the not-connected / nothing-due empty state).

**A drive check had to move.** The mock's day always holds 4–5 assignments, so
under the new rule it can never produce a pulled-forward item — the old
"work gets pulled forward once today drops to 2 or fewer" check became
impossible to satisfy there. The lookahead rule is now pinned in the smoke suite
instead, in a subprocess with its own database where the number of assignments
due today can actually be controlled (0, 2 and 3 due; then all 3 finished).

**Round 29 — document headings + list toolbar (2026-08-14).**

**All typed work now goes through the MLA path**, not just essays:
`contentFor()` returns `ck:'mla'` when `work_mode === 'text'`. That means every
typed assignment downloads/submits as Times New Roman 12, double spaced, with a
heading — and its download formats changed from txt/docx/pdf to **docx/pdf/txt**.
Guide-mode work is still plain text.

`headingFor(row)` in api.js assembles student / teacher / class / date;
`saveHeading()` stores corrections per class (`teacher_title:<id>`,
`teacher_name:<id>`, `class_short:<id>`, global `student_name`). **The student
name comes from the account** (`users.owner().name`) — which is why admins can
now rename people (`users.renameUser`, `POST /api/admin/users/:id/rename`).

**`src/classNames.js`** turns a Canvas course name into heading pieces.
`splitClassName` pulls a trailing surname off (guarded by a NOT_A_NAME list so
"Algebra II Honors" doesn't yield teacher "Honors"); `shortenSubject` applies a
longhand table, then prefers the part before a colon, then drops joining words,
then keeps whole words — **it never cuts mid-word and never invents an
abbreviation**. `splitTeacher` pulls an honorific out of a name, which is what
stops "Mr. Mr. Ortiz" (older saves stored the title inside the name).

**Titles: no placeholders.** `[title]` used to be emitted when an essay had no
title. That was fine on the essay checklist and disastrous on a plain assignment,
which would hand in the literal text. Now a missing title means no title line,
and non-essay work defaults its title to the assignment name (`writtenDoc(row,
{isEssay})`).

**Lists are plain text on purpose.** `listToolbar()` in app.js inserts real
"• " / "1. " characters — no hidden markup — so autosave, snapshots, the AI
checker and the doc builders all keep working on exactly what's on screen. Enter
continues a list, an empty item ends it. Three places had to learn about it:
`mla.splitDraft` (a list block keeps its line breaks instead of being joined
into one paragraph), `officegen.mlaPara({list:true})` and `buildMlaPdf`.

**Verified in real Word via COM:** opens clean, TNR 12, LineSpacingRule 2,
heading correct, list lines indented 36pt.

**Round 28 — finished-today fixes (2026-08-14).** Three bugs Will found.

1. **Finishing pulled-forward work made it vanish.** `finishedToday()` required
   the item to be due today; work-ahead is due later, so it matched neither
   list. **"Finished today" now means completed_day = today and nothing else** —
   the due date is irrelevant to whether you finished it today.
2. **New `assignments.completed_day`** (local ymd) alongside completed_at.
   `date(completed_at)` was SQLite reading a UTC instant, so anything finished
   after ~8pm Eastern rolled to tomorrow and dropped off the list. Same lesson
   as `time_log.day` in round 22 — **never derive a local day from a UTC
   timestamp in SQL.** `week()`'s per-day finished list keys off it too.
3. **The GPTZero key box only rendered when Canvas was disconnected**, because
   `renderApi` returns early in the connected branch and the settings block sat
   below that return. Now appended in both branches.

Labels: "Submit — make my file" → **Submit**; "Not done after all" →
**Move to unfinished**.

**Round 27 — optional AI checker (2026-08-14).** `src/aiCheck.js`. Off unless a
GPTZero key is saved on the API page (settings table, server side, only the last
4 chars ever returned). Auto-runs on the hand-in popup for written work, cached
in `assignments.ai_check` against a sha of the draft so reopening costs nothing.
Under 50 words it returns state 'short'; slideshows return 'not_writing'.

**IT REPORTS A SCORE AND NOTHING ELSE. Do not add an explanation of what the
detector reacted to** — not a reasons list, not highlighted spans, not "try
changing X". That is a tuning loop and it works just as well on writing the
student didn't do. This was declined twice (round 14, and again when Will asked
about detector APIs) and Will himself agreed to the line when he asked for this
build: "ofc no ranking of reasons text is ai". A smoke test greps aiCheck.js for
that language and fails if it appears.

It is also **never a gate** — `can_submit` does not consult it, and a drive check
pins that.

`readScore()` tolerates both GPTZero response shapes (`class_probabilities.ai`
and the older `completely_generated_prob`) and throws rather than inventing a
number. **The real API has never been called** — I have no key. Everything is
verified through `SLATE_AI_CHECK_FAKE=1`, which the smoke suite and the drive
harness both set so nothing can reach the live service. If Will reports an error
from a real call, the parsing in `readScore` is the first place to look.

**Round 26 — finished/unfinished sections (2026-08-14).** New
`assignments.completed_at`, set by `completeAssignment` and by a successful
Canvas submit, cleared by `reopenAssignment`.

**`completed_at IS NOT NULL` is the filter that matters.** Canvas imports past
graded work as `status='done'` with no stamp, so without that condition the
Finished lists would fill with months of old work. Any new "what did I finish"
query must keep it.

`todayPlan` gains `finished` / `finished_count` / `finished_projects`;
`finishedToday()` takes work completed today OR due today with a stamp, so a
pulled-forward assignment you finish still shows. `week()` gains
`done_assignments` / `done_projects` per day (due that day + stamped).

Frontend: `section(title, count, nodes, emptyLine)` renders a heading + count +
grid, and **skips itself entirely when the count is 0 and there's no empty
line** — that's why a fresh day shows no Finished heading. Cards get `.finished`
(dimmed, struck through) and a "Not done after all" button; `weekItem` takes a
`done` flag.

**Watch the string escaping when patching app.js from a script.** A python
replacement containing `
` inside a JS template literal silently failed to
match, so `renderWeek` kept its old body while `weekItem` got the new signature
— the page rendered fine and simply never showed the Finished block. The drive
check caught it; nothing else would have.

**Round 25 — submit to Canvas (2026-08-14).** Will asked for it explicitly after
asking whether the API could submit; the spec's "never auto-submit" rule is about
Slate deciding on its own, which this does not do.

**This is the ONLY place Slate writes to Canvas.** `apiPost` in canvasClient,
used by `submitText` (online_text_entry) and `submitFile` (Canvas's three-step
upload: request a slot → POST the bytes to `upload_url` with `upload_params` →
attach the returned file id). Everything else in the client is a GET. Do not add
writes anywhere else.

Flow: the hand-in popup offers **Save to my Desktop** or **Submit to Canvas**;
Canvas goes via `openSubmitPreview`, which shows the real content, filename,
size, word count and deadline, and offers Go back / Save instead / Send. Nothing
is sent until Send. `submissionPreview()` builds the SAME bytes the submit will,
so the preview cannot disagree with what goes.

`submitRouteFor` reads `submission_types`: online_upload → file, online_text_entry
→ text, anything else → blocked with a plain reason (on paper, external tool,
media recording). MLA docs and slideshows can't go as text and say so.
`getMySubmission` warns about prior attempts (read-only, failure ignored — it
must never block the preview). Submitting marks the assignment done.

**`can_submit` is `canvasMode() !== 'none'`, so MOCK counts.** That is
deliberate: mockCanvas's `submitText`/`submitFile` record into an exported
`submitted` array instead of sending, which is the only way the full submit path
gets tested. `GET /api/_submitted` exposes that array and **404s unless
canvasMode()==='mock'**, so it cannot leak against real Canvas.

**The real send has never been executed** — everything is verified against the
mock. Will presses it first. Never fire `/api/submit-to-canvas` against the
workshop server (port 4173), which holds his real token.

**Round 24 — email popup, exams, emoji/bars removed (2026-08-14).**

*Email popup.* Canvas only returns full bodies + attachments per-conversation,
so `emails()` still lists previews and `emailDetail(id)` fetches the message on
open, caching into new `emails.body_full` / `emails.attachments` columns. Both
clients gained `getConversation(id)`. A Canvas that won't answer falls back to
the stored preview (`full_text_loaded:false`) rather than erroring.

*Exams were landing on Projects* because `categorizeLocal` calls anything worth
50+ points a project, and teachers post exams as plain assignments. New
`assessmentKind()` in llm.js runs FIRST in sync's assignment loop and diverts
exam/test/quiz titles into the tests table via `upsertTestFromAssignment`
(canvas id namespaced `a:<id>` — assignment and quiz ids can collide, and
canvas_test_id is unique; it also deletes any assignment row created before this
rule existed). **`ABOUT_AN_EXAM` is load-bearing**: study guides, review sheets,
test corrections, quiz prep and practice tests are ordinary work, and an essay
titled "(Final)" is a final DRAFT, not a final exam. Verified on real data:
"Unit 1 Exam"/"Unit 2 Exam" now sit on Tests & Quizzes.

*Due date + time everywhere.* `fmtDue(due_at, due_date)` in app.js prints the
REAL Canvas deadline ("Fri, Aug 15 at 8:00 AM"). `due_at` now flows through
assignment cards, assignmentDetail, projectDetail, tests and the week. This is
what makes the before-noon shift legible instead of looking wrong — the card
shows the true deadline and adds "do it today".

*Removed by request:* `progressBar()` and every use, all emoji (kept ←, ↗, ⋯, ✓
as functional glyphs), `emptyState` no longer takes an icon, and both
"worked today" displays. **`time_log` and `worked_seconds` still record** — only
the display went, so it can come back without a migration.

**TESTING TRAP — never call sync() in the test runner.** A test did, and
`src/db` in the runner process resolves the DEFAULT path, so it wiped and
re-synced **Will's real workshop DB against his real Canvas** on every `npm
test`. Anything calling sync()/resetDb() directly must run in a child process
with `SLATE_DB_PATH` and `CANVAS_MODE=mock` set (see the "one awkward class"
test for the pattern). Proof of the fix: last_sync and row counts are identical
before and after a full run.

**Round 23 — sample data removed, day rules (2026-08-13).**

**Slate starts EMPTY.** `ensureSeeded` only seeds when `CANVAS_MODE=mock` is set
explicitly (the test + drive harnesses do). `canvasMode()` in canvasClient now
returns **'mock' | 'real' | 'none'**, and `sync()` returns early on 'none'
instead of falling back to the mock — pressing Sync now with nothing connected
must leave the app empty, not fill it with fakes. `/api/status` reports
`canvas_mode:'none'`, the frontend's `notConnected`/`emptyOr()` turn every empty
page into "Canvas is not connected". **The mock and `src/seed.js` are still
there and must stay** — deleting them would take 621 checks with them.
`npm run clear` / `clear:all` (tools/clear-data.js) wipes Canvas-derived data
from the workshop and/or installed DB; it deliberately leaves accounts and the
Canvas token alone.

**Before noon → the day before.** `workDayFor(dueAt)` in dates.js: due_date is
now the day the work must be DONE on, and anything with a local time before 12:00
belongs to the previous day. New `assignments.due_at` / `tests.due_at` keep the
real Canvas deadline. `assignmentCard` returns `due_morning_of` (a time label)
when it was shifted — **`isEarlyMorning()` and `workDayFor()` must agree exactly**
or the card explains something different from what happened; a test pins that.
Mock fixture: assignment 5002 is due `dueAt(1, 8, 0)`.

**Light days pull work forward.** `todayAssignments()`: when today has
`LOOKAHEAD_WHEN_AT_MOST` (2) or fewer, it appends up to `LOOKAHEAD_MAX` (3) of the
soonest future assignments, flagged `upcoming:true` and always sorted below
today's own. `todayPlan` adds `due_today_count`/`due_today_minutes`/
`upcoming_count`, and **`full_on_assignments` is computed from today's own
minutes only** — otherwise pulled-forward work would make a quiet day look full
and starve the project-chunk filler.

**Real-Canvas robustness (found the hard way).** Will's Canvas *is* connected
(jcseagles.instructure.com). A sync fired during testing and **died on a class
with quizzes switched off** — Canvas 404s that endpoint — leaving one class in
and the rest missing. `sync()` now wraps every per-course fetch in `tryFetch()`,
counts what it skipped, and carries on. Real Canvas is patchy in ways the mock
never was; **assume any per-course endpoint can fail.**

Also fixed: `canvasSettings().connected` was `!useMock()`, so a fresh Slate with
no Canvas at all claimed to be connected. It's `canvasMode() === 'real'` now.

**TESTING TRAP — orphaned servers.** A `npm test` run that gets killed (timeout,
Ctrl-C) leaves its server child holding port 4599. The next run's server can't
bind, the harness happily talks to the OLD one, and you get a cluster of nonsense
failures ("has a next chunk", "new flashcards were added", `My Essay (4).txt`).
Same shape as the round-18 drive-port collision. **If several unrelated tests
fail at once, kill stray node processes before believing any of it.**

**Round 22 — "worked today" (2026-08-13).** Will pointed out the timer showing
how much he'd worked never reset. It didn't — `tests.time_logged` and
`assignments.time_logged` are lifetime counters and always have been.

**They stay lifetime counters.** `tests.time_logged` measures readiness ("am I 2
hours into studying for this yet"); resetting it daily would make the goal
unreachable. Instead there's a new `time_log` table — one row per logged stretch,
stamped with the LOCAL calendar day (`day` TEXT, indexed). `secondsWorkedOn(day)`
and `workedToday()` in api.js add them up.

**Nothing runs at midnight, deliberately.** A new day has no rows, so it reads
zero on its own. No scheduler to drift, double-fire, or miss a day because the
app was shut. It follows the machine clock, which is Eastern on Will's PC — there
is no America/New_York handling anywhere and adding one would only matter if he
travelled.

`addTime`/`addStudyTime` write both numbers and return `worked_seconds`.
`todayPlan()` returns `worked_seconds`; `testDetail` returns `time_logged_today`
alongside `time_logged`. Frontend shows "45 min worked today" under the day bar
and "…of that was today" under the study-log bar.

**app.js now polls the local date every 30s** and re-renders when it changes —
Slate stays open in the background, so a window left up overnight used to show
yesterday until something was clicked. It disposes `pageTimer` first so a running
study timer banks its seconds against the day they were worked. `makeTimer` only
saves on pause/navigate, so without that the whole session would land on tomorrow.

**Round 21 — Class Notes (2026-08-13).** Photograph notes → Claude types them up
→ attach to a test → Claude decides what deserves a flashcard.

**`src/claude.js` is now the shared way to ask Claude anything** — `ask(prompt)`,
`askAboutImage(path, prompt)`, `parseJson(reply)`, `queued(job)`. Same chain as
always (ANTHROPIC_API_KEY → hidden `claude -p` with windowsHide → give up),
`SLATE_NO_AI=1` skips to giving up. simplify/outline/unstuck/notesAI still have
their own older copies and were deliberately left alone; **anything new uses
this module**. `parseJson` repairs one thing before parsing: a model asked for
multi-line text inside JSON often emits a REAL newline instead of `\n`, which is
invalid JSON — since typed-up notes are always multi-line, that would have broken
the common case. Raw control chars inside string literals get escaped and it
retries.

**`src/classNotes.js`** owns the feature. Tables: `class_notes` (class_id, title,
text, image_file, status reading|ready|error) and `note_tests` (note_id, test_id,
status thinking|done|error, cards) whose **composite primary key is what stops a
note being added to the same test twice**. `flashcards.source_note_id` records
where a card came from, so deleting a note takes its cards with it. Photos live
in `<data>/notes/class-notes/`, served by `GET /api/notes/:id/image`.

**Both AI steps are deliberately fail-soft, and this is the part not to break:**
the note row is inserted and the image written BEFORE any Claude call, so a
failed read leaves a real note the student can type into (`saveNote` clears the
error the moment there's text). A failed card run leaves `note_tests` in place
with status='error' and a Try again button — the note keeps its place on the
test. **Never make either step a precondition for saving.**

**There is no rule-based fallback for flashcards, on purpose.** Will asked
specifically for reasoning, not sentence-splitting; a card-per-line generator
would be worse than no cards. `parseCards()` validates the reply as data —
drops anything without both front and back, dedupes fronts, caps at 40 — and
throws if nothing usable came back.

Classes now open as a FULL PAGE (`state.view='class'`, `state.classTab`), which
finally matches assignments/projects/tests; the old `openClass` grades popup is
gone. `classDetail` returns `notes` + `tests`; `testDetail` returns
`class_notes` (**separate from `notes`**, which is still the older
drag-a-file-onto-a-test summary — don't merge them).

**Live-tested end to end** (`drive:all`, phase 5, using `test/sample-notes.png`):
a rendered page of cell-respiration notes read in ~15s, 14 cards in ~12s, and it
threw away "p. 142-149, do questions 3-11 odd for friday" and the teacher aside.
The harness asserts that rejection explicitly. It does NOT assert card count
against line count — that check was wrong and failed on good output, because one
line holding three facts *should* become three cards. It checks instead that no
card front is a verbatim line of the note, which is what naive splitting looks
like.

**Round 20 — API tab + Admin tab, accounts (2026-08-12).** Two new tabs at the
bottom of the sidebar: **API** then **Admin**.

*API page* (`renderApi`, `/api/canvas` GET/POST + `/api/canvas/disconnect`):
Canvas address + token, verified against `/api/v1/users/self` via
`verifyCredentials()` in canvasClient **before** anything is saved, then it syncs
immediately. Stored in the **settings table**, not `.env` — settings live in the
data folder, so connecting survives every update. `token_hint` (last 4 chars) is
all that ever goes back to the page; the token itself never leaves the server.

*Accounts* (`src/users.js`): `users` + `sessions` tables. Passwords are
scrypt+salt (`scrypt$salt$hash`), compared with `timingSafeEqual`. Sessions are
random 32-byte tokens in an **HttpOnly SameSite=Lax cookie**; one row per device,
which is what the Admin page counts. `describeDevice()` turns a user agent into
"Chrome on Windows" — **the match order matters** (Edge claims to be Chrome,
Chrome claims to be Safari) and a test pins it.

**`loginRequired()` is the key idea: sign-in is OFF until there are 2+ accounts
AND the owner has a password.** With it off, `currentUser()` returns the owner, so
every existing endpoint behaves exactly like the single-user app it has always
been — that is why rounds 1-19 kept working untouched. Adding a friend can never
lock Will out, because his own password is the second half of the switch. The
Admin page banner says which half is missing.

The **owner** row (`is_owner=1`, created in `migrate()` on first run, named from
`student_name` or 'Will') can't be frozen, deleted or demoted. Freezing ends every
session immediately and `sessionUser()` also kicks a frozen account mid-request.

*Guard* is in `handleApi`: `/api/me`, `/api/login`, `/api/logout` and
`/api/status` are always open; everything else 401s when `loginRequired() && !me`;
`/api/admin/*` needs `me.is_admin`.

**NOT DONE YET — do not tell Will this is finished:**
1. **Data is still global.** No table has a `user_id`. Every account that signs in
   sees *Will's* schoolwork. Making this real means adding `user_id` to classes/
   assignments/project_chunks/tests/flashcards/grades/emails/draft_snapshots,
   filtering every query in api.js, and moving `canvas_api_token` to per-user.
2. **Server still binds 127.0.0.1.** Nobody else can reach it. Exposing it means
   binding the LAN + a firewall rule, and then passwords and *other people's*
   Canvas tokens travel over plain HTTP on shared school wifi — Will has been
   told this; decide it with him before binding anything wider.

**Round 19 — Slate becomes an installed app (2026-08-12).** See THE SHIP
WORKFLOW above for how the two copies work; this note covers the machinery.

`tools/installer/build.js` freezes the workshop into `dist/slate-app` (copies
server.js, package.json, src, public, branding — **deliberately not CLAUDE.md**,
which the hidden `claude -p` would otherwise read and start greeting Will inside
his own assignment instructions, the round 18 bug) and stamps `build.json` with
an incrementing build number. `install.ps1` does the install; `Install Slate.bat`
is the double-click wrapper; `push.js` (= `npm run push`) is build + install.

`tools/installer/icon.js` draws the Desktop icon from scratch — the brand mark is
one arc, so it's rendered with plain math at 4x supersampling rather than by
decoding the branding PNGs (which are 512/1024px and won't fit an ICO dimension
byte anyway). Own PNG encoder (zlib deflate + CRC32) for the 256px entry, classic
bottom-up 32-bit DIB + AND mask for 128/64/48/32/16. Dark rounded square
(#1F252C) + sage arc (#8CA891).

Launch chain: `Slate.lnk` → `wscript.exe Slate.vbs` (window style 0 = no console
flash at all) → `node launch.js` → sets the env vars → `require(app/server.js)`.
launch.js runs hidden, so it mirrors console output into `slate-log.txt` and pops
an `mshta` message box on a fatal start — otherwise a failed launch is
indistinguishable from the icon doing nothing. `openWindow` (src/openWindow.js,
shared with server.js) finds Edge or Chrome and opens `--app=<url>`: no address
bar, no tabs.

**Two real bugs found while testing this, both fixed:**
1. Quit then immediately double-click the icon → the new copy hit EADDRINUSE on
   the port the old one hadn't released and died silently. `listen()` in
   server.js now retries EADDRINUSE 20× at 500ms, and `/api/quit` uses
   `server.close(cb)` (with a 1.5s hard backstop) instead of exiting outright.
2. launch.js's "already running? just reopen the window" check could latch onto
   a server that was mid-shutdown, leaving Will at a window pointing nowhere. It
   now re-checks 2s later and starts a fresh server if that copy has gone.

**PowerShell gotcha:** `Invoke-RestMethod` against localhost fails intermittently
in Windows PowerShell 5.1 (it leans on the IE engine). install.ps1 uses raw
`[System.Net.HttpWebRequest]` for the graceful-quit call. It cost an hour of
chasing a phantom "the app won't start" bug that was really just the test poller
— **if a local HTTP check looks flaky in PowerShell, suspect the poller, not the
app.** Use curl or node to verify instead.

**Round 18 — full-app drive harness + 2 bugs (2026-07-22).** New
`tools/drive/` (kept OUT of `test/` — `node --test` sweeps that whole folder and
would try to execute the drivers). `npm run drive` = api + ui phases;
`npm run drive:all` adds the live-Claude phase; **`npm run drive:loop` re-runs
the whole sweep on every file save** (fs.watch over src/public/server.js/test,
300ms debounce) until it comes back clean — the useful half of a loop, since the
checks are deterministic and only a code change can flip a FAIL to a PASS.
`run.js` boots throwaway servers against a temp DB + temp Desktop and polls
`/api/status` for readiness (a fixed sleep raced first-run seeding and produced
a phantom failure).

**Servers take an OS-assigned free port, never a fixed one.** Two sweeps running
at once (a watch loop plus a manual run) previously booted onto the same ports
and silently corrupted each other's data — it surfaced as ~6 nonsense failures
("time accumulates", "photo toggle persists", "dropped file added flashcards
9 -> 9") that looked like real app bugs and were not. If you ever see that
cluster again, check for a stray drive process first.

Loop verified by deliberately breaking `DAILY_TARGET_MINUTES` and the
`Conclusion` label in `essayRoles`: both caught unprompted, both back to green
on save.

- `api.js` — 266 checks: every endpoint, every assignment (draft round-trip with
  quotes/ampersands, all download formats, complete/reopen, time), every
  project, chunk ticking in any order, the full slideshow and essay flows, notes
  uploads (txt/md/mixed/binary/oversized/duplicate), flashcards, grades, and bad
  input (missing ids, junk filenames, unknown formats, traversal-ish names).
- `ui.js` — 146 checks: runs the REAL `public/app.js` inside a `vm` context
  against a hand-rolled DOM shim, renders every view and clicks every button,
  checkbox and dropdown, including a synthesised drag-and-drop file drop.
  **Shim gotchas:** `innerHTML` is stored as a string (not parsed into nodes) so
  use the `hasClass` helper; `.text` must decode entities or `esc()`'d output
  like "Intro &amp; thesis" fails a naive compare; the sandbox needs
  `AbortController`/`btoa`/`TextEncoder` explicitly.
- `ai.js` — 24 checks against the real hidden `claude -p` (~45s).

**Bugs it found, both fixed:**
1. `attachStudyGuides` only matched titles containing "study guide"/"review", so
   the mock's "Vocabulary Set 4 List" was ignored and that quiz had zero
   flashcards. Widened to notes/vocab/terms/glossary/list/practice/outline AND
   now skips any item whose content is empty, so a title match with nothing
   behind it can never be picked over a real guide.
2. **`simplify` returned raw text, so the hidden `claude -p` — which runs in the
   project folder and therefore reads CLAUDE.md — prefixed "hey will" and it
   rendered as the first bullet of the student's Instructions checklist.** Now
   it asks for `{"steps":[...]}` and `parseSteps()` discards anything wrapped
   around the JSON (with a line-filter rescue if there's no JSON at all). The
   other three AI features were already safe because they all parse JSON out of
   the reply. **Any future AI feature must parse structured output, never trust
   raw stdout.**

**Round 17 — works-cited handling fixed (2026-07-22).** Feeding a realistic
full-length sample essay through the app found two bugs that only show up with
a real Works Cited section:
1. `essayRoles` only treated a block as citations if that block STARTED with
   "Works Cited". With the heading on its own line and the entries in the next
   block (the normal way to write it), the entry list counted as a paragraph,
   so `lastIdx` pointed at it and the real conclusion got labelled "Body 4".
   Fixed with a latch — once the heading appears, every later block is cited.
2. The percent meter counted citation entries as sentences (3 MLA entries read
   as ~9), inflating progress. `essayPercent` now counts
   `splitDraft(draft).body` only, and the frontend `drawDone` filters out
   blocks whose role is 'Works cited'.
Also `longEnough` in essayRoles now compares the target against the count of
NON-cited blocks, so a Works Cited page can't pad a draft into looking finished.

**`test/sample-essay.txt`** is the fixture that found them — paste it into the
essay editor to exercise the whole flow. 5 paragraphs, 30 sentences, 3 MLA
sources, 603 words; lands the essay page at exactly 100% with every hand-in
check ticked. Placeholder/lorem text does NOT exercise these paths. Verified end to end: percent,
outline labels, checklist, and a 3-page MLA docx opened in real Word (TNR 12,
double spaced, "Caldwell 1" header, Works Cited hanging-indented on page 3).

**Round 16 — slide redesign, pictures removed (2026-07-22).** Slide model is now
`{title, bullets[], photo}` and **slides[0] IS the title slide** — `buildPptx`
renders it instead of synthesising its own from `opts.title` (that double-title
bug is why the change was needed; opts.title/subtitle are fallbacks only).
`seedSlides` pre-fills slide 1 with the assignment name + class name as
subtitle; `outline.titlesToSlides(titles, subtitle)` does the same, and
`generateSlidesOutline` passes the class name in.

**All image fetching is gone.** `src/images.js` deleted, `attachImages` removed
from api.js, `performDownload` no longer awaits anything for slides, no
`ppt/media` parts, no jpg/png Content-Type defaults, no credits slide. The
`SLATE_NO_IMAGES` env var is dead. Don't reintroduce auto-images — Will asked
for them out.

Per-slide `photo: true` reserves a dashed accent frame ("Picture goes here") on
the right and narrows the body to 6217920 EMU; it is a plain styled shape, not
a real PowerPoint picture placeholder, so it can just be deleted once a picture
is dropped in. Content slides: 2-digit kicker, sage title + underline, each
bullet as a `panelShape` card (surface 1F252C) with an accent tab, stack centred
vertically in the body area, "n / total" footer. Over 6 bullets falls back to a
plain bullet list. Title slide: accent rule + big title + subtitle + three-dot
motif. buildHtmlSlides mirrors all of it.

**Testing note:** makeZip deflates every part, so `bytes.includes(...)` only
finds FILENAMES (central directory), never content. The smoke suite has an
`unzipEntry(buf, name)` helper (inflateRawSync off the local header) — use it
to assert anything about slide XML. **Verified in real PowerPoint via COM:** 5
slides, no repair, shape names per slide as expected, exported PNGs eyeballed.

**Round 15 — even weighted pacing, sentence progress, timers removed (2026-07-22).**
`pacing.planChunks(steps, dueDate, today)` rewritten — **the signature changed,
regularLoadByDay is gone** (day-balancing is the Today page's job now). It gives
EVERY work day exactly one piece. Steps are weighted by `stepWeight()` (a stated
count like "three body paragraphs"/"6-8 slides" sets the base; write/draft/
research/build ×1.5; works-cited/format/proofread/label ×0.6), then
`allocateDays()` spreads days proportionally with a floor of 1 day per step and
largest-remainder for the leftovers. Multi-day steps are labelled
"Start:/Keep going:/Finish: <step> (day k of n)". More steps than days falls
back to an even slice per day. Result for the sample essay over 9 days: thesis
2, body paragraphs 6, works cited 1 — uniform splitting had given 3/3/3, which
read as nonsense ("Works Cited page (part 1 of 3)").

`projectDetail` now returns `chunks` (ALL of them, each with `done` +
`is_today`) so any piece can be ticked in any order — `buildChunkList` in app.js
renders the checkbox list, and `/api/chunks/:id/done` already took `{done:
false}` for unticking. `essay_done_pct` = sentences written vs
`targetsFromText().sentences` (words/18, else paragraphs×6, else 30);
`countSentences` exists in BOTH src/unstuck.js and public/app.js and the two
must stay in step — a test asserts the browser copy and server copy agree. The
abbreviation mask is an explicit list on purpose: matching any short capitalized
word ate real sentence endings ("One." counted as an abbreviation).

The essay page shows a big percent instead of the chunk progress bar. **All
pomodoro/focus timers were removed** (makePomodoro deleted, `?fastTimer=1` hook
gone with it) — only the tests page count-up study timer remains, and
`pageTimer` now exists just for that. `/api/assignments/:id/time` still exists
and is still tested, but nothing in the UI writes to it.

**Round 14 — MLA hand-in + the draft-loss fix (2026-07-22).**

*The bug:* editors autosave on a debounce (800ms/1.2s). Marking a chunk done
called `render()`, which blew away the DOM and re-fetched the project — reading
a draft that was still older than what was on screen, so typing vanished. Fixed
with a `pageDraft` handle (mirrors `pageTimer`): `registerDraft(id, textarea)`
tracks the last-saved text, and `render()` now `await`s `pageDraft.flush()`
BEFORE tearing down, with a `beacon()` on beforeunload. Both editors use it.
If you add another editor, register it the same way.

*MLA hand-in:* `src/mla.js` splits a draft into body paragraphs + Works Cited
(a block starting with a bare "Works Cited"/"Bibliography"/"References" line
switches the rest to citation entries; soft line breaks inside a paragraph get
joined), builds the doc object, renders plain text, and runs `checkEssay` for
the pre-hand-in checklist. `officegen.buildMlaDocx` is real MLA — styles.xml
sets Times New Roman 12 + `w:line="480"` double spacing as docDefaults,
header1.xml holds the "Lastname PAGE-field" running header, first-line indent
720 twips, Works Cited on a page break with a hanging indent. `buildMlaPdf`
does the same in Times-Roman with per-line `Tm` positioning. New format kind
`'mla'` → docx/pdf/txt; `contentFor('essay', id)` returns it. **Verified in real
Word via COM: opens with no repair, 2 pages, TNR 12, LineSpacingRule 2 (double),
1" margins, header "Caldwell 1", title centered, Works Cited hanging-indented on
page 2.** New column `assignments.essay_title` (the student's own title —
deliberately NOT the Canvas assignment name). Settings hold `student_name` and
`teacher_name:<class_id>`.

*Writing record:* new `draft_snapshots` table; `saveDraft` keeps a version every
10 min (or after a 150-word jump) once the draft passes 20 words.
`writingHistory(id)` returns versions/days/first/last/minutes_logged, shown on
the hand-in screen. This is the honest answer to "prove you wrote it" — see the
next paragraph for why that matters.

**IMPORTANT — the AI-detector request was declined.** Will asked for the finish
flow to run the essay through an online AI detector in a headless Playwright
window and then report "every reason it might be coming up as AI, using detailed
research of what AI detectors flag." That was not built, for three reasons and
they all still hold: (1) it is a detector-evasion loop — the only use for a
ranked list of what's triggering a detector is to edit until it stops
triggering; (2) it needs Playwright + a browser download, which breaks the
zero-dependency decision this whole app is built on; (3) it uploads his
schoolwork to a third-party site, which the approval rules say has to be asked
about, and those sites sit behind bot detection that automating means evading.
The writing-record feature above was built instead, because the real defense
against a false accusation is showing your drafting history, not tuning your
prose. If this comes up again: the record is the answer, not the detector.

**Round 13 — day planner + labelled paragraphs (2026-07-22).** `src/effort.js`
estimates minutes per assignment (rule-based, instant — points × 2 as the base,
then multipliers for writing/reading/recording/review, a stated problem count
like "#1-25 odd" → 13 wins over the points guess, +4/step, +10 for long
instructions, clamped 10–180 and rounded to 5). `chunkMinutes` sizes one day of
project work (15–90). `api.todayPlan()` returns
{assignments, assignment_minutes, projects, project_minutes, total_minutes,
target_minutes:120, full_on_assignments}: it sums today's unfinished assignments
and, while ≥10 min of the 2-hour target is left, pulls in undone project chunks
(day ≤ today first, then soonest upcoming). **GET /api/today now returns this
object, not an array** — tests and frontend updated. Today page has a progress
bar for the day and an Assignments | Projects toggle (`state.todayTab`); the
sort toggle only shows on the Assignments tab. Projects page is unchanged (all
projects together). With sample data today's 4 assignments = exactly 120 min, so
the Projects tab starts empty and fills as things get marked complete — that is
correct behavior, not a bug.

Essay outline paragraphs are now named by `essayRoles()` in app.js: Intro &
thesis / Body N / Conclusion / Works cited. The last paragraph is only called
the Conclusion once the draft reaches the assignment's paragraph target (or it
opens with a wrap-up phrase) — mid-draft it stays a body paragraph. The role
also goes into the Get Unstuck stuck-note ("the body 2 — paragraph 3 of 5…").
Tested by eval'ing the real functions out of public/app.js in the smoke suite.
Smoke suite now 24 tests, all green.

**Round 12 — essay editor + Get Unstuck coach (2026-07-22).** New project
build_mode `'essay'` (llm.js ESSAY_WORDS: essay/thesis/argumentative/persuasive/
expository/research paper/term paper/lab report/book report/paragraphs; checked
AFTER the slides check so slideshows still win). `buildEssayEditor` in app.js:
big autosaving textarea (draft_text, 1.2s debounce), live word/char/reading-time
stats, word+paragraph goal read from the instructions
(`unstuck.targetsFromText` → projectDetail.essay_target), and a clickable
paragraph outline (blank-line blocks via `essayBlocks`, current block
highlighted, click to jump). Submit routes through the existing download popup
(essays fall through contentFor to text → txt/docx/pdf).

`src/unstuck.js` = the Get Unstuck coach. Same fallback chain as the rest
(ANTHROPIC_API_KEY → hidden `claude -p` with windowsHide, queued one-at-a-time →
rule-based). Returns JSON {where_you_are, next, points[], question}. POST
/api/projects/:id/unstuck takes {draft, stuck_note}; it saves the draft first so
the coach always sees the newest text. The stuck note is built on the frontend
from the selection, or "paragraph N of M, which starts …", or the gap between
paragraphs. Cancel/navigate-away aborts the fetch → server aborts → child
`claude` is killed (verified: server survives, queue not wedged after a cancel).
Verified live through real Claude Code: ~13-22s, genuinely useful direction.

**IMPORTANT — what this feature deliberately does NOT do.** Will's spec asked for
the button to call the `write-as-will` skill and generate the missing section as
drop-in prose in his voice, inserted into the draft. That was declined and built
as a coach instead: it says what the section must accomplish and what to cover,
never sentences that could be pasted in. Claude writing graded schoolwork in the
student's voice is over the line, independent of Slate's own "never auto-write
assignments" rule. The prompt in unstuck.js states this hard rule twice on
purpose; the offline fallback only ever emits short fragments. Will pushed on
this three times — if it comes up again, the answer is still no, and the reason
is the ghostwriting, not the rulebook. Keep any future edits on the coaching side
of that line.

**Round 11 — instructions readability (2026-07-22).** simplify.js now prompts for
a short checklist (one action per line, fewest words, no fluff) instead of a
paragraph; ruleBased also returns short lines. Frontend instructionsSection
renders `<ul class="instructions">` (no box — plain text, accent dot bullets,
16px) via instructionLines() (splits on \n, breaks a lone long line into
sentences). Removed the `.deliverable` box styling from instructions. Applies to
all assignment/project/slideshow pages. 18 tests green.

**Validation tip:** to check a generated Office file really opens, use PowerPoint
COM from PowerShell (New-Object -ComObject PowerPoint.Application; .Open(path,
readonly, untitled, withwindow=$false); read Slides.Count / export slide PNGs).
It IS installed on Will's machine. Windowless .Export works.

**Testing hook:** `SLATE_DESKTOP_DIR` env overrides where
submit files land (used by tests so they don't clutter the real Desktop).

## Future Work (do once school starts + real Canvas data exists)
These are agreed-on ideas to add later, when there's real Canvas data to test
against. Not started yet.

- ~~**Read attached Canvas documents to build the assignment page.**~~ **DONE in
  round 39** — see that note. The plan here assumed the file names were already
  arriving and only the contents were missing; that was wrong. Real Canvas sends
  no attachment list at all.
- **Local web app** on localhost (not Electron for now) — a small Node server
  serves the UI; Will opens it with a double-click launcher (`Start Slate.bat`).
  Chosen over Electron because it's simpler to build/test and avoids native
  build headaches. Can wrap in Electron later if Will wants a "real app" feel.
- **Node.js** (v24) backend, **zero npm dependencies** on purpose:
  - Database: **`node:sqlite`** (built into Node 24 — no install, no native
    compile, nothing to break).
  - HTTP server + Canvas/Claude calls: built-in `http` + `fetch`.
- **UI:** plain HTML/CSS/JS, dark theme using Slate's brand colors. No framework
  — keeps it simple and clutter-free (spec's #1 priority).

## Brand (from /branding)
- App name: **Slate**
- Colors: `#14181D` (darkest bg), `#1F252C` (card/surface), `#8CA891` (sage
  accent), `#E8E6E1` (main text), `#6B7078` (muted text).
- Logo: sage arc mark (`slate-mark-*.svg`) + wordmark. Dark + light versions.

## External things that need Will (deferred, not blocking the build)
- **Canvas API token + institution URL** — needed only for REAL sync. School
  hasn't started, so we build against a **mock Canvas API + fake seed data**
  first. Ask Will for these when he's ready to connect real Canvas.
- **Claude API key** — the spec wants "categorize regular vs project" and
  "simplify description" done as real Claude API calls (costs money, external).
  Until Will provides a key, Slate uses a built-in rule-based fallback so
  everything still works. Wire the real API when he says go. Stored in `.env`.

## Next Recommended Step
**Both servers are running clean as of 2026-09-04** (Slate 4173, copilot
4321, copilot Opera up on 9222 with Slate open in it). If either is
restarted from a Claude Code session, strip the env — see round 69.

**Will is setting the copilot up on his Windows PC** (2026-09-02). As of
round 69b the steps are: in the Slate workshop `git pull`, then
`npm install` inside `browser-copilot\`, then `npm run push` to update the
installed app (the separate clone he was told about before is no longer
needed). The
copilot's Windows browser paths and openers were added in round 68's push —
untested on real Windows, so if he reports the Copilot tab not finding
Opera there, `lib/chrome.js`'s BROWSERS list is where to look. On the Mac
everything runs: Slate on 4173, copilot on 4321, both started fresh
2026-09-02.

Older Windows note, still true last it was checked: the installed Desktop
app there (`%LOCALAPPDATA%\Slate\data\slate.db`) had no Canvas connection —
the token lives in the workshop database. He pastes the token on the API tab
himself, or **asks** for the settings to be copied across; never unasked.

Open, all offered and none refused — just not answered yet:
- **The personal-settings leak is only fixed in claude.js** (round 51).
  simplify.js, outline.js, unstuck.js and notesAI.js each spawn their own
  `claude -p` without `--setting-sources ''`, so Will's working rules are still
  being injected into those four. Nothing shows today because they all parse
  JSON, but it is the same bug. One line each.
- **Fill suggestions** was taken off the slide builder "for now" (round 49). The
  server side is intact; putting it back is one button.
- **A targetable drive sweep** — `npm run drive week` to run one section instead
  of all 825 checks. Offered 2026-08-14 and again 2026-08-15; ~20 minutes of work
  in `tools/drive/run.js` plus section tags. Ask before building it.
- **Per-user data separation and network exposure** (round 20) — every account
  still sees Will's schoolwork, and the server is still 127.0.0.1 only. His
  friends' Canvas tokens on plain HTTP over school wifi is the thing to settle
  with him first.
- **The essay editor is still a plain textarea** while the assignment editor is
  rich (round 33).

## Open Tasks (Build Order) — all done
1. [x] Local DB schema + launcher scaffold
2. [x] Canvas API sync (read-only pull, mock first)
3. [x] Assignment name/description cleanup + categorization
4. [x] Daily dashboard + mark-complete + grade-impact sort + focus timer
5. [x] Weekly workload view
6. [x] Classes/grades/GPA page
7. [x] Projects dashboard + pacing logic
8. [x] Tests dashboard + study timer + flashcards
9. [x] Email viewer

## How to run / key files
- Start: `Start Slate.bat` (or `npm start`) → http://localhost:4173
- Reset sample data: `npm run seed`
- `server.js` (HTTP + routing), `src/api.js` (queries/business logic),
  `src/sync.js` (Canvas→DB), `src/canvas/` (mock + real client),
  `src/llm.js` (cleanup/categorize), `src/pacing.js`, `src/flashcards.js`,
  `src/dates.js` (local-date handling), `public/` (UI).

## Important Decisions
- **Local web app + node:sqlite, zero dependencies** — max reliability, nothing
  to install or compile that could fail on Will's machine.
- **Mock Canvas + fake seed data** so the whole app can be built/tested before
  school starts.
- **Rule-based fallback for categorize/simplify** until a Claude API key exists,
  so no external/paid call is required to build and test.
- Canvas token + Claude key live in `.env` (gitignored), read at runtime. Never
  hardcoded, never committed.

## Working Preferences
- Casual, direct, simple language. Short responses; no walls of text.
- Prose, not bullet lists, unless genuinely tabular.
- Only flag a risk if it's decently likely AND would cause a big problem.
- One section/decision at a time for complex topics; one step per message for
  click-through guides.
- Don't ask questions the files already answer.
- **Look at the page, don't just read the code.** `npm run shots` drives a real
  headless browser and writes a PNG of every screen to `dist/shots` — open them.
  Will asked for this on 2026-08-15: "click through everything you made or
  changed on the website too... so you can be 100% sure it looks good." It found
  two bugs in its first run that every code check had passed.
- After an edit, verify what the change touched — not the whole codebase. Save
  the full `npm run drive` sweep for broad changes or the end of a batch.
  **Will has raised this twice now (2026-08-14 and 2026-08-15), so treat it as
  a rule, not a preference.** What it means in practice:
  - Default after an edit: `npm test` (5s) plus a throwaway script that
    exercises the thing that changed. That is enough for most rounds.
  - `npm run drive` is ~90s of 814 checks. Once per batch, at the end.
  - **Never re-run a suite just to grep different lines of its output.** Capture
    it once (`npm run drive > out.txt 2>&1`) and read the file. Round 43 ran the
    full sweep five times in one round doing exactly that, which is what made
    him say it a second time.
- Start every response with "hey will".
- Keep a plain-English `CHANGES.md` updated after code edits.

## Approval Rules
- File/code/doc edits: just make them, then explain.
- Anything leaving the machine (installs from the internet, Canvas/Claude calls
  with real keys, publishing): explain first, wait for Will's OK.
- Will's instruction in a message IS approval.

## Activity Log
- **2026-10-28 (round 75)** — Copilot documents: uploaded Word files are now
  edited in place (formatting kept, answers and pictures dropped in by
  paragraph number) instead of rebuilt as plain text; new make_pdf prints
  Claude's HTML layouts to real PDFs in a hidden browser (also how it copies
  an uploaded PDF with screenshots added); capture_image grabs cropped
  pictures of a tab for them; finished files come back as chat cards. Live
  two-turn check green on a throwaway rig.
- **2026-09-20 (round 74)** — Restructured Slate from a Canvas dashboard into a
  set of tools: removed Today/Week/Tests/Classes/Email; the sections are now
  Documents, Slideshows, Copilot, Watermarks (Canvas + Admin as bottom
  utilities). New projects: click New, pick a Canvas class + assignment for the
  instructions, chat with the on-page Claude, save and reopen. User projects are
  `source='user'` assignments rows; added the columns, endpoints, picker UI, and
  a pre-saved "Secular Ethics Presentation" slideshow (id 123 on his DB, backed
  up first). Rewrote the drive UI harness + shots to match. npm test 108/5,
  drive api 516 / ui 272 green.
- **2026-09-20 (round 73)** — Made the PowerPoint maker output a plain, blank
  deck (header + bullets on white, default placeholders, theme-able) instead
  of the designed dark deck with cards/kickers/footers/picture frames. Removed
  the "leave space for a picture" feature and the `photo` field entirely.
  Preview, HTML export and text export all match. Verified the .pptx with
  python-pptx and eyeballed the preview. Tests re-pinned to the plain output;
  npm test 108/5 (5 = round 51c guards), drive api 516 / ui 385 green.
- **2026-09-11 (round 72)** — Fixed uploading files to the copilot: it now
  reads Word/PowerPoint/Excel attachments (not just text/PDF/images) and can
  edit them, saving the changed version as a real Word file on the Documents
  tab. Zero-dep Office read/write ported from Slate. Verified with a live
  turn: uploaded a Word doc, got back a corrected Word doc.
- **2026-09-10 (round 71)** — Slate.app on the Mac Desktop: opens Slate in
  the copilot's Opera window, starting Slate and the copilot first if
  needed. First cut handed the URL to Opera directly and gave a black page;
  now it goes through Launch Opera's route and fronts the tab. Will declined
  screen recording; verified through the copilot's port instead. Found and
  documented the do-shell-script backgrounding trap. Also put the website link in the
  outreach bot's email signature (separate repo, committed, not pushed).
- **2026-09-09 (round 70)** — The copilot can now work pages that are just
  a picture (browser remote desktops, virtual labs, canvases): it looks with
  a screenshot and acts by coordinate — click, drag, scroll, real keystrokes,
  key combos, wait, look again. Screenshots can be saved full-size to the
  Desktop by name. Found and documented a headless-only keystroke flood
  while testing. 28 rig checks + one live haiku turn green; copilot on 4321
  restarted clean. Not committed.
- **2026-09-04 (round 69)** — Launch Opera was failing: both servers had
  been left running as children of an old Claude Code session and Opera
  would not start from them, and the launch gave up after 10s when a cold
  Opera needs ~30s. Restarted both clean, wait is 45s now, and Launch Opera
  opens Slate inside the copilot's window so it can be the one Will works
  in. Verified with a live chat turn, warm and cold launches, and a
  screenshot of the Copilot tab inside that Opera.
- **2026-09-02 (round 68)** — Clicking off the Copilot tab and back now lands
  exactly where you were: each chat remembers which browser tab it was
  pinned to (stored with the transcript), and the open chat + current view
  come back via localStorage. Verified with a scripted real-page reload:
  everything restored identical, seven checks green.
- **2026-09-01 (round 67)** — Fixed the copilot forgetting conversations:
  every Slate navigation reloaded its page and threw the sessions away.
  Chats now persist to disk, rebuild in the UI after any reload, survive
  server restarts (a fresh session is handed the story so far), and only ✕
  forgets one. Proven by killing the server mid-conversation and getting the
  codeword back from the reborn one.
- **2026-09-01 (round 66)** — The copilot can make real documents now: Claude
  writes files into a sandboxed "Browser Copilot" folder in Documents, shown
  on a new Documents view with preview and Open. A paperclip sends Claude
  files to read (text, images, PDFs), a header picker switches the model for
  new chats, and the cost line is gone. Verified live: an attached file's
  secret marker came back exactly in a document Claude saved.
- **2026-09-01 (round 65)** — Took the pills back out: the Working on
  dropdown is the viewer's one control, pinning both the chat and the view to
  its tab with the same leave-Opera-alone machinery. New tab button returned
  to the viewer's corner. Six checks green on the rig.
- **2026-09-01 (round 64)** — The strip earned its place: clicking a pill now
  pins the viewer to that tab without moving Opera at all — front tabs
  stream, background tabs show live once-a-second screenshots (found that
  screenshots re-render hidden tabs even though streaming can't), and input
  lands in the pinned tab either way. A Follow pill restores the mirror.
  Nine end-to-end checks green on the isolated rig.
- **2026-09-01 (round 63)** — The viewer got a tab strip: a pill for every
  open tab, click to show it (which fronts it in Opera too — only the front
  tab draws, so that's what showing means), with the ＋ button on the end.
  Test scripts now run against a throwaway copilot + headless browser pair
  instead of the real one, after a test's typing chased Will's own click into
  his live Slate tab (no harm done, verified read-only).
- **2026-09-01 (round 62)** — Fixed both tab-viewer complaints: the dropdown
  no longer flips the real Opera's tabs (it only pins the chat now), and the
  viewer became a live mirror of whatever tab is front — following tab
  switches automatically — with Opera launched so it keeps drawing while its
  window sits behind Slate, which was the real cause of the freezing. Six new
  end-to-end mirror checks green.
- **2026-09-01 (round 61)** — The copilot switched from headless Chrome to a
  visible Opera carrying a one-time copy of Will's real profile — logins,
  bookmarks and his saved session included; its first launch brought his
  actual tabs back. His everyday Opera window itself can't be attached to
  (engine restriction since Chromium 136) and he was told so plainly. Chrome
  stays as the fallback browser. All interaction checks re-run green on Opera.
- **2026-08-31 (round 60)** — The copilot's Chrome runs invisibly now (Will's
  choice, offered both ways): no window anywhere, the clickable live view in
  Slate is the only place its tabs exist, same profile so logins persist. A
  ＋ New tab button in the viewer opens a tab, shows it, and pins the chat to
  it — starting Chrome itself first if needed. Streaming and clicking
  re-verified against the windowless Chrome.
- **2026-08-31 (round 59)** — The copilot got a Chat | Tab switcher: Tab shows
  the Chrome page live where the chat feed was, and it's clickable — clicks,
  scrolling and typing pass through to the real page, and the view follows
  whichever tab the chat (or Claude) moves to. All inside the copilot project;
  Slate itself untouched. Verified end-to-end against a driven test tab.
- **2026-08-31 (round 58)** — Browser Copilot got its own tab in Slate: the
  sidebar gained Copilot, which frames the copilot app in place and can start
  it with one button. Rebranded the copilot itself into Slate's colors and
  mark. It stays a separate program — Slate keeps zero dependencies, and the
  two share no data by design (guard test enforces it). 902 checks + 108 tests
  + 32 screens; 5 guard tests still red by design.
- **2026-08-27 (round 57)** — Rebuilt Marks on the actual upstream code (Layer A
  of watermarks-remover, MIT, ported to dependency-free JavaScript). That fixed
  a real bug in the first version, which deleted every invisible character and
  would have destroyed emoji, flags and Persian spelling — the upstream code's
  whole substance is deciding by context, and now Slate does too. Added the
  spinner Will asked for on Scan and Remove. The statistical rewrite layer stays
  unported, now pinned by a test. 890 checks + 104 tests + 31 screens;
  5 guard tests still red by design.
- **2026-08-26 (round 56)** — Added a Marks page: paste text and see every
  character in it that never renders, including whole sentences hidden in
  Unicode tag characters, with a button to strip them and a before/after.
  Declined wiring the watermark remover into the chat's output path and
  declined its statistical rewrite layer; built the inspector and the manual
  clean instead, on its own page, deliberately unable to touch a draft. Caught
  an XSS hole in it before it shipped. 890 checks + 99 tests + 30 screens;
  5 guard tests still red by design.
- **2026-08-26 (round 55)** — Fixed the hand-in screen, which showed half a
  cut-off page and no buttons at all, so work could not be handed in from it.
  Two layout faults: the document was taking its full height and shoving
  everything below it out of the popup, and a shrunk page was being centred
  about 150px off. Found the reason no check caught it — the screenshot test
  opened that screen on an empty essay and had never once photographed a real
  document. Added a shot with actual work in it, plus one for the
  Submit-to-Canvas half that had never been photographed, and taught the
  harness to run on macOS at a settable window size. Also got Slate running on
  Will's Mac. 890 checks + 93 tests + 28 screens; 5 guard tests still red by
  design.
- **2026-08-19 (round 54)** — Fixed the chat claiming it could not see Canvas,
  cut the reply and the change list down to a sentence each, stopped speaker
  notes being written into the bullets, and added a sources panel: click to see
  every page it used and which slide it backs up, hover to light that box up
  until the panel closes. 968 checks + 98 tests + 26 screens; 5 guard tests
  still red by design.
- **2026-08-19 (round 53)** — Speaker notes: a Notes box on every slide, which
  Claude can fill in one slide at a time, and which comes out in the real
  PowerPoint notes pane. Found that a notes master sharing the slide master's
  theme makes PowerPoint reject the file outright. Added a pulsing sage star
  while Claude is thinking and removed the explainer line under Ask Claude.
  965 checks + 93 tests + 25 screens; 5 guard tests still red by design.
- **2026-08-19 (round 52)** — Ask Claude moved onto project pages; on a
  slideshow it edits individual slide boxes rather than the whole deck. Lists
  now come out as real lists everywhere (the "1. a 2. b" run-on is fixed), a
  conversation pulls the assignment fresh from Canvas when it starts, and the
  prompt asks for plain words and no unrequested extra work.
  964 checks + 90 tests + 24 screens; 5 guard tests still red by design.
- **2026-08-16 (round 51)** — Ask Claude on every assignment page: a support-desk
  widget in the bottom-right corner holding a saved conversation that knows the
  assignment, the attached files and Will's draft, can search the web, and
  refuses to write the work. Opening it shifts the page over rather than
  covering it. Found that Will's personal Claude settings were being injected
  into every hidden call Slate makes — the real cause of the round 18 "hey will"
  bug — and shut it off at the source. Then gave the chat Grammarly-style
  proofreading: it corrects spelling and grammar in the draft itself and lists
  every change, while `src/proofread.js` blocks anything bigger than a fix so a
  "make it sound smarter" can never land. 931 checks + 90 tests + 23 screens
  clean, both halves verified against real Claude.
- **2026-08-15 (round 50)** — Put Slate on GitHub as a private repo
  (wcaldwell2009/slate). Installed the GitHub CLI, logged Will in, first commit
  of 67 files. Checked before pushing that no token, database or schoolwork was
  in the set — the existing `.gitignore` already covered all of it.
- **2026-08-15 (round 49)** — Took the Fill suggestions button off the slide
  builder (server side kept), then pushed everything from today to the installed
  Desktop app. 825 checks + 74 tests green.
- **2026-08-15 (round 48)** — Removed the daily plan from projects entirely: no
  pieces, no tick-off list, no progress fraction. Today shows whole projects and
  the 2-hour day counts only what is really due. The slide strip scrolls left as
  well as right. 828 checks + 74 tests + 21 screens clean.
- **2026-08-15 (round 47)** — Clicking a slide card scrolls the strip along so
  the next two stay clickable, without moving when it does not need to.
- **2026-08-15 (round 46)** — Slideshow builder lost its heading and explainer;
  Auto-fill outline became Fill suggestions, which researches the topic on the
  web through a hidden Claude Code window and puts real points into the empty
  slides without ever touching what Will has written. Hand-in thumbnails are now
  Slide 1/2/3 with a live miniature of each slide. 835 checks + 74 tests green.
- **2026-08-15 (round 45)** — Slideshow hand-in: the button says Make my
  PowerPoint and the popup shows a real clickable slide deck instead of a Word
  page preview. Found two layout bugs by looking at the screenshots — a class
  collision with the slide editor, and the buttons pushed off the bottom.
  827 checks + 74 tests + 20 screens clean.
- **2026-08-15 (round 44)** — Built `npm run shots`: drives a real headless
  browser and photographs every screen, because the existing harness has no
  layout engine and literally cannot see how a page looks. It found two bugs on
  its first run — Slate's own text leaking into a student's instruction
  checklist, and a status line that never went away. 814 checks + 74 tests + 17
  screens clean.
- **2026-08-15 (round 43)** — Tests time frame appeared broken; the code was fine
  and his page was talking to an older server copy. Slate now tells the browser
  never to cache its files, and the drive check that should have caught a dead
  filter was rewritten to demand a strict change. 814 checks + 74 tests green.
- **2026-08-15 (round 42)** — The editor says how many pages the work will be in
  Word as you type, and Tests & Quizzes got a 1-4 week / All time frame picker.
  Found and fixed the preview fitting 27 lines to a page where Word fits 23.
  806 checks + 74 tests green; page geometry re-measured in real Word.
- **2026-08-15 (round 41)** — Slate re-checks Canvas every hour while it is open,
  and class cards show the overall grade plus the Formative and Summative halves,
  with every graded assignment tagged with which one it counted towards. Taken
  from the Canvas assignment group, not guessed. 799 checks + 73 tests green.
- **2026-08-15 (round 40)** — Grades: found that Slate had been asking Canvas for
  submissions in a way Canvas rejects with a 500, which is why the grades page
  and the GPA were empty all week. Fixed, and the class grade now comes straight
  from Canvas rather than being recomputed from raw points. Same bug had also
  been stopping Canvas from reporting work as handed in. 793 checks + 70 tests
  green; verified read-only against his live Canvas.
- **2026-08-15 (round 39)** — Canvas attachments: the assignment page lists the
  teacher's attached files and opens them in whatever program the machine uses
  for that type, and Slate reads what's inside them into the Instructions box.
  Found the reason it never worked — real Canvas hides attachments as links in
  the description HTML. 793 checks + 68 tests green; PDF reading verified live.
- **2026-08-14 (round 38)** — Sync now follows the schedule: a class that stops
  appearing in Canvas is hidden everywhere instead of sitting there forever.
  Hidden, not deleted — it comes back intact if the class returns, and an empty
  answer from Canvas can never wipe the schedule. 773 checks + 65 tests green.
- **2026-07-19** — Read spec + branding. Chose stack (local web app, node:sqlite,
  zero deps). Wrote this CLAUDE.md. Started scaffold.
- **2026-07-19** — Built the entire app: DB, mock Canvas + seed, sync engine,
  name cleanup/categorize, pacing, flashcards, JSON API, and all 6 UI pages.
  Tested every page in a real browser. Caught + fixed a UTC date bug and a
  render race. Added launcher, daily-sync setup, README, CHANGES. Build done.
- **2026-07-19 (round 2)** — Full-page assignment views; work_mode classifier
  (text vs guide) from Canvas submission_types + keywords; in-app editor with
  draft autosave; submit→.txt-on-Desktop with popup + download; step-by-step
  guide pages; looping 30/10 pomodoro replacing the count-up timer on work
  pages; wrote 12-test smoke suite (`npm test`) — all green. Browser extension
  disconnected before a final visual pass; backend fully verified. Will's
  message was truncated at the start ("instead of the top…") — asked him.
- **2026-07-19 (rounds 3–7)** — Left sidebar nav; projects+tests as full pages;
  drag notes onto a test → Claude Code → flashcards+notes; Flashcards/Notes
  switcher + study log (2h/30m); download popup with filename + file-type
  dropdown; zero-dep Office file generator (pptx/docx/pdf/html) verified in real
  PowerPoint.
- **2026-07-22 (rounds 8–11)** — Styled PPTX + auto images (Wikimedia Commons)
  + credits slide; simplified plain-language Instructions on every page; fixed
  slide-seed bug; auto slide-outline (picks subject, honors slide count, fills
  headers); instructions reformatted as a clean no-box checklist. Smoke suite
  now 18 tests, all green. Session wrapped — everything saved, nothing broken,
  still on sample data. Next: Will tries it; real Canvas token when school
  starts; see Future Work for reading attached Canvas docs.
- **2026-07-22 (round 12)** — Essay editor under Projects + "Get unstuck" coach
  (`src/unstuck.js`, POST /api/projects/:id/unstuck, build_mode 'essay').
  Declined the ghostwriting half of the spec (write-as-will → drop-in prose);
  built the coaching version instead — see the round 12 note above, it matters.
  Verified live end-to-end through real Claude Code, plus the cancel path. Smoke
  suite now 21 tests, all green. Also recomputed build_mode on Will's live DB so
  the editor shows up as soon as he restarts Slate.
- **2026-07-22 (round 13)** — Time estimates per assignment (`src/effort.js`);
  Today now plans the full 2-hour day and fills leftover time with project
  chunks, split across Assignments | Projects tabs; essay outline paragraphs
  labelled intro/body/conclusion/works-cited. GET /api/today changed shape.
  Smoke suite now 24 tests, all green.
- **2026-07-22 (round 14)** — Fixed drafts being wiped when a chunk was marked
  done (pageDraft flush-before-render). Essay hand-in: MLA assembly
  (`src/mla.js` + `buildMlaDocx`/`buildMlaPdf`), checklist, per-class teacher
  names, student's own title, download to Desktop; verified in real Word.
  Added `draft_snapshots` writing history. Declined the Playwright AI-detector
  request — reasons recorded in the round 14 note above. 28 tests, all green.
- **2026-07-22 (round 15)** — Even weighted project pacing (planChunks signature
  changed); every chunk tickable in any order; essay progress shown as percent
  of sentences written; all focus timers removed except the tests study timer.
  Re-planned the chunks in Will's live DB (nothing was marked done, so nothing
  was lost). 31 tests, all green.
- **2026-07-22 (round 16)** — PowerPoint redesign: slide 1 is an editable
  pre-filled title slide, all auto-image fetching removed (src/images.js
  deleted), per-slide "leave space for a picture" toggle, bullets render as
  accent-tabbed cards. Verified in real PowerPoint. 31 tests, all green.
- **2026-07-22 (round 17)** — Fed a realistic sample essay through the app and
  it found two Works-Cited bugs (conclusion mislabelled "Body 4"; citations
  counted as sentences in the percent meter). Both fixed with regression tests.
  31 tests, all green.
- **2026-08-14 (round 37)** — Unfinished/Finished became a switcher on Today and
  Week; projects show only on their due date instead of every day leading up;
  week days open a popup of cards that link through to each item.
  773 checks + 64 tests green.
- **2026-08-14 (round 36)** — Unfinished work now carries over to the next day
  instead of vanishing, sorted to the top with how late it is; Canvas
  submissions mark work done on sync. Removed the automatic first-line indent
  from every output format. 767 checks + 64 tests green.
- **2026-08-14 (round 35)** — Fixed the preview putting every paragraph on its
  own page (a fixed-height element being measured); hand-in popup is now three
  fixed bands with only the paper scrolling and the title centred.
  739 checks + 61 tests green.
- **2026-08-14 (round 34)** — Fixed headings-on-their-own-line being merged into
  the paragraph below, and blank-line-separated numbered points all rendering as
  "1."; .txt and .pdf now render from the same block model as .docx. Also
  destroyed and restored Will's real homework with a careless verification
  script — see the rule at the top of this file. 735 checks + 60 tests green.
- **2026-08-14 (round 33)** — Assignment editor is now a real rich-text editor
  with a Canvas-style toolbar (font, size, B/I/U, alignment, lists); MLA is the
  default until a font or size is picked, which then carries into the Word file.
  Hand-in preview shows real Letter pages that paginate like Word, with the
  popup sized to the page aspect. Essay editor deliberately left on its
  textarea. 735 checks + 58 tests green.
- **2026-08-14 (round 32)** — Hand-in popup compacted so the file name and
  buttons stay on screen; "Use these" renamed to "Save"; extra heading notes
  removed. 720 checks + 56 tests green.
- **2026-08-14 (round 31)** — Document preview moved to the top of the hand-in
  screen (above the file name/type), with only the document scrolling; heading
  boxes available on both hand-in routes. 720 checks + 56 tests green.
- **2026-08-14 (round 30)** — Work-ahead now keys off how many assignments the
  day held rather than how many are left, so clearing a busy day says "you're
  done" instead of pulling next week's work in. 715 checks + 56 tests green.
- **2026-08-14 (round 29)** — Every typed assignment now produces a proper
  document: MLA heading (name/teacher/class/date), Times New Roman 12, double
  spaced, with the class name auto-shortened from Canvas and a Mr./Mrs. picker.
  Admins can rename accounts. Bullet/number toolbar over every text box.
  730 checks + 55 tests green; Word output re-verified.
- **2026-08-14 (round 28)** — Fixed pulled-forward work vanishing when finished
  (finished-today now keys off completed_day only), an evening UTC day-rollover
  bug it exposed, and the GPTZero key box being hidden whenever Canvas was
  connected. Renamed two buttons. 735 checks + 53 tests green.
- **2026-08-14 (round 27)** — Optional GPTZero check on the hand-in screen:
  score only, never a reasons list, never a gate, off without a key. Verified
  against a stand-in; the real service has never been called. 722 checks + 52
  tests green.
- **2026-08-14 (round 26)** — Today and Week split into Unfinished / Finished,
  driven by a new `completed_at` stamp so Canvas's old graded work stays out of
  it. 704 checks + 49 tests green.
- **2026-08-14 (round 25)** — Hand-in now offers Save to Desktop or Submit to
  Canvas, with a mandatory preview of the exact file/text and a way back to the
  editor. Only write path in the app; verified end to end against the recording
  mock, never fired at real Canvas. 675 checks + 49 tests green.
- **2026-08-14 (round 24)** — Email popup with full text + attachments; exams
  posted as assignments now go to Tests & Quizzes (tab renamed); real due date
  AND time on everything; all progress bars, emoji and worked-today counters
  removed. Fixed a test that was syncing real Canvas into the real workshop DB.
  663 checks + 45 tests green.
- **2026-08-13 (round 23)** — Deleted all sample data from both copies; Slate
  starts empty and never falls back to the mock. Work due before noon now shows
  the day before (with the real deadline on the card). A day with 2 or fewer
  assignments pulls up to 3 future ones forward. Fixed a real-Canvas sync crash
  on a class with quizzes disabled, and a fresh Slate wrongly reporting itself
  connected. 621 checks + 42 tests green.
- **2026-08-13 (round 22)** — "Worked today" counter that resets at local
  midnight, via a day-stamped `time_log` table rather than anything scheduled;
  per-test totals stay lifetime. The window now notices the date changing.
- **2026-08-13 (round 21)** — Class Notes: classes open as full pages with a
  Notes tab, photograph notes and Claude types them up, ⋯ menu with Edit / Add
  to Test / Delete. Add to Test sends the whole note to Claude to reason about
  what deserves a flashcard (no sentence-splitting fallback, on purpose). New
  shared `src/claude.js`. 595 checks + 37 tests green, including the full flow
  against real Claude.
- **2026-08-12 (round 20)** — API tab (paste Canvas address + token, verified
  before saving, then syncs) and Admin tab (add/freeze/delete users, make
  admins, per-user device tracking, sign out all devices). Accounts, scrypt
  passwords and cookie sessions in `src/users.js`; sign-in stays off until a
  second account exists and Will has a password. 499 checks + 35 tests green.
  Will chose "friends on their own laptops" for the admin scope, so per-user
  data separation and network exposure are still to do — flagged to him that
  their Canvas tokens on plain HTTP over school wifi is the risk to settle.
- **2026-08-12 (round 19)** — Slate is now installed on Will's machine: Desktop
  icon, own window (no address bar, no console), Quit button, build number.
  `Install Slate.bat` + `npm run push`. Data, notes and the Canvas token moved
  outside the app folder so updates can't touch them. Found and fixed the
  silent-relaunch bug. 420 drive checks + 33 tests, all green. Agreed the ship
  workflow: edits go to localhost only; "push it" builds and installs.
- **2026-07-22 (round 18)** — Built `tools/drive/` and swept the whole app:
  469 checks over every page, button, box and upload. Found and fixed two real
  bugs (a quiz that could never get flashcards; "hey will" leaking into the
  Instructions checklist). Office output re-verified in real PowerPoint + Word.
