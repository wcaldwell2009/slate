# Slate — School Tracker App — Project Handoff

## Last Updated
2026-08-19 (round 54 — sources, short receipts, Canvas wording)

## What this project is
Slate is a **local desktop app** that helps Will keep on top of school work. It
logs into Canvas once a day, pulls every assignment/project/test, cleans them
up, and shows them on dead-simple daily / weekly / projects / tests / grades
pages. Everything runs and stores on Will's own computer — no website, no cloud,
no account. Personal use only.

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
**FIRST THING: the Desktop app has no Canvas connection.** Build 7 is installed
and runs, but `%LOCALAPPDATA%\Slate\data\slate.db` is empty and reports
`canvas_mode: 'none'` — the real token lives in the WORKSHOP database. So
double-clicking the icon opens an empty Slate asking him to connect. He has been
told twice and has not picked: either he pastes the token on the API tab himself
(two minutes), or **he asks for the settings to be copied across** — do not do
that unasked, it is his live data.

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
