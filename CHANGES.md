# What's been built — plain English

## 2026-08-19 — Ask Claude panel tidied

The two lines of explainer inside the empty chat are gone. An unused panel is
just empty now — the grey text in the box still says what to type.

## 2026-08-19 — Five fixes to the chat

**It stopped saying it can't see Canvas.** It always had the assignment — it
just did not know that block came from Canvas. Ask it what the assignment says
and it now answers straight from it.

**The reply is short again.** It used to list every single change, one line per
slide. Now it says what happened in a sentence and the change list underneath
collapses to "Updated notes on slides 1-4." Grammar fixes still show the exact
before and after, because with those the words *are* the point.

**Notes stopped landing in the bullets.** Asking for "notes for each bullet"
was putting the notes on the slide, under each bullet. They go in the notes box
now — the same words, the right box — and the PowerPoint puts them in the notes
pane where they belong.

**Sources.** When Claude looks something up, its message gets a **Sources** pill.
Click it and a small panel opens in the chat listing each page it used, which
slide or box it backs up, and the phrase it supports. Clicking one opens the
website.

**Hover a source and it lights up the box it belongs to** — the slide bullets or
notes it came from get a sage outline, and the page scrolls to it. The highlight
stays on while you read down the list and goes out when you close the panel.


## 2026-08-19 — Speaker notes on every slide

Every slide in the builder now has a **Notes** box under it. Type what you
want to say for that slide — or tell Claude to write it ("write speaker notes
for slide 2") and it fills that one in and leaves the rest alone.

**They come out in the real PowerPoint notes pane.** Open the .pptx and the
notes are there under each slide, exactly where PowerPoint puts them, so they
show on your screen in Presenter View and not on the projector. Slides you
leave blank get no notes at all rather than an empty notes page.

The HTML version of the slideshow prints them under each slide too.

## 2026-08-19 — Claude shows it is thinking

While Claude is working there is now a small sage star that pulses next to the
word "Thinking", instead of a line of text that just sat there. The explainer
line under the **Ask Claude** heading is gone.


## 2026-08-19 — Ask Claude on slideshows, and much better formatting

**The chat is on project pages now**, not just assignments — the slideshow
builder and the essay editor both get the same corner button.

**On a slideshow it can edit one slide at a time.** Each slide has two boxes
it can name — the header and the bullets — so "put three bullets on slide 3"
changes slide 3 and nothing else. It can change several boxes in one go if you
ask for several. Every change is listed underneath its reply, and now the list
says which slide moved instead of calling everything "your draft".

**Lists come out as real lists.** Before, asking for numbered steps gave you a
single run-on line with "1." and "2." sitting in the middle of it. Now a
numbered list is a numbered list, bullets are bullets, and a heading on its own
line stays on its own line — on screen and in the Word file. Bullets on a slide
go one per line instead of getting glued onto the end of the last one.

**It checks Canvas when a chat starts.** The first message of a conversation
pulls the assignment fresh from Canvas — the instructions, the due date, the
points, and anything the teacher attached — and reads what is inside the files.
So if a teacher rewrote the instructions this morning, the chat knows. If Canvas
is down it just carries on with what it had.

**It talks more plainly and does less.** The instructions now tell it to use
simple everyday words, to do exactly what was asked and nothing more, and when
it changes something to keep the explanation to a sentence or two rather than
repeating the whole thing back at you.

## 2026-08-16 — Fixed: edits were breaking your formatting

If Claude changed a bit of text that had **bold** or *italic* running through
it, the closing tag got deleted — so everything after that point turned bold,
including in the Word file you hand in. A grammar fix on line one could quietly
bold the rest of the assignment.

Fixed. Formatting inside an edited stretch is now kept exactly as it was, and
the corrected text takes on the formatting it started in.

## 2026-08-16 — Ask Claude, on every assignment

Every assignment page has an **Ask Claude** button in the bottom-right corner,
like the support chat on a website. Click it and it opens into a small panel in
the same corner; the page slides over so the panel never sits on top of your
work. The × shuts it again.

Type a question, press Send, and Slate opens a hidden Claude window on your
computer and asks it. No window pops up, no API key, it just uses your Claude
plan.

**It can search the web**, so you can actually ask it to look something up
rather than guess. If it does, it puts the links at the bottom of its answer.

**It knows what it's talking about.** It gets the assignment, the teacher's
instructions, anything inside a file the teacher attached, and whatever you've
typed in the editor — so "is my argument any good so far?" is a real question
you can ask it.

**It will not write the assignment for you**, and it says so if you ask. It
explains, researches, checks your reasoning and tells you what a section is
missing — same line as the Get unstuck coach on essays.

**It can fix your grammar.** Ask it to and it corrects your draft in place —
spelling, punctuation, wrong words, capitals, a doubled word — and lists every
single change it made underneath its reply, so you can always see exactly what
moved. Your wording stays yours.

**It won't "improve" your writing, and that's on purpose.** Ask it to reword a
sentence or make a paragraph sound smarter and it says no and helps you do it
instead. Slate also checks every correction before it touches your draft: if a
change is bigger than a fix — a reworded sentence, a new sentence, anything that
isn't already your text — it gets blocked and told to you, whatever the chat
said it was doing.

The conversation is saved per assignment, so you can leave the page and come
back to it. **Clear** in the panel header wipes it. **Stop** cancels a question
that's taking too long. Enter sends; Shift+Enter starts a new line.

Also fixed while building it: every hidden Claude that Slate runs was picking up
**your personal Claude settings** — the ones that make it say "hey will" and
follow your working rules. That was leaking into what Slate showed you. Slate's
Claude calls now ignore them.

## 2026-08-15 — Slate is backed up on GitHub

The whole project now lives at **github.com/wcaldwell2009/slate**, set to
**private** so only you can see it. That's a proper backup — if the laptop dies,
Slate isn't gone.

Your Canvas token, your `slate.db` and everything you've typed **stay on your
machine**. They're deliberately excluded and never get uploaded.

Say **"save it to github"** any time you want the latest changes pushed up.

## 2026-08-15 — Fill suggestions off, and pushed to your Desktop app

**Fill suggestions is off the page for now.** The research side of it still
works underneath, so switching it back on is a button rather than a rebuild —
say the word whenever.

Everything from today is now on your **Desktop Slate**, not just localhost.

## 2026-08-15 — No more project plan

**The plan is gone from projects.** No "the plan — tick off whatever you get
done", no daily pieces, no "0 of 5 pieces done", no "part 2 of 3", no
compile-when-everything's-ticked button.

A project is now just a project: what it is, what class, when it's due, and the
builder for it (slides or essay). The Projects tab on Today lists your actual
projects rather than slices of them, and the day's 2-hour total counts only what
is genuinely due today.

The slide strip also scrolls **both** ways now — going back to earlier slides
pulls the previous two into view the same way going forward does.

## 2026-08-15 — The slide strip follows you

Click a slide card near the right-hand end and the strip now slides along so the
next two are already on screen and clickable. It only moves when it needs to —
a card sitting comfortably in the middle stays where it is instead of jumping
around under your cursor. The arrows and arrow keys drag it along the same way.

## 2026-08-15 — Fill suggestions, and slide thumbnails

**"Build your slideshow" and the paragraph under it are gone.**

**"Auto-fill outline" is now "Fill suggestions."** Press it and Slate goes and
actually researches your topic on the web — in a hidden window, nothing pops up —
then puts real points into each empty slide for you to work from. It took about
a minute on the sample project and came back with proper specifics: dates, the
delegate counts, who proposed the Great Compromise, when the Bill of Rights was
ratified. Facts you can build on, not filler.

Two things it will never do: touch a slide you've already written on, and touch
the title slide. So you can press it, keep the bits you want, delete the rest,
and press it again later without losing your work.

They're notes to work from, not finished slides — put them in your own words.
That's deliberate, and it's the same line Slate has always held about not doing
your work for you.

**The slide cards in the hand-in popup show a mini version of each slide** now,
labelled Slide 1, Slide 2, Slide 3 rather than repeating the heading. Click any
one to jump to it.

## 2026-08-15 — PowerPoint hand-in

The slideshow button says **Make my PowerPoint** now, and the screen it opens
finally makes sense for a slideshow instead of pretending to be a Word document.

**You get a real slide preview.** A proper 16:9 slide drawn the way the actual
.pptx comes out — dark background, sage heading with a rule under it, a card per
bullet, the dashed "picture goes here" box if you asked for one. Underneath it
there's a strip of every slide in the deck: **click any one to jump to it**, or
use the arrows, or the left and right arrow keys. Same as flicking through
PowerPoint.

Everything else on the screen is unchanged — file name, file type, Save to my
Desktop, Submit to Canvas. The one thing that's gone is the MLA heading editor,
since there's nowhere on a slide to put your name, teacher and date.

It's drawn from the exact same slides that go into the file, so the preview
can't show you one thing and hand in another.

## 2026-08-15 — I can look at Slate now

You were right that I should be looking at the actual website, not just the
code. My existing checks click every button in the app, but they do it against a
fake page with no real layout — they can tell me a button exists and doesn't
crash, and they can never tell me whether the thing looks right.

So Slate now has `npm run shots`, which opens a real browser (invisibly), walks
all 17 screens and saves a picture of each one for me to look at.

**It found two bugs the moment I ran it**, both of which every code check had
happily passed:

- On an assignment with an attachment, your Instructions checklist was listing
  `organelle_worksheet.docx` and a line reading *From the attached file "…":* —
  that second one was Slate's own internal note, printed to you as if it were an
  instruction. Both gone.
- "Slate is reading these to fill in the instructions" stayed on screen forever,
  long after it had finished reading. Removed.

Also tidied a class card that had no formative/summative split — it had a blank
gap where the other cards have two boxes, and now says why.

## 2026-08-15 — Why the tests filter looked broken

The filter itself was fine — the page in your window was talking to a copy of
Slate that had been started before the filter existed, so it kept sending back
everything. **Reloading the page fixes it.**

Two things changed so this can't happen again. Slate now tells your browser
never to hold on to its own files, so a reload always gets the current version
instead of whatever was cached hours ago. And the automatic checks now insist
that "1 week" shows **strictly fewer** tests than "All" — the old check only
said "no more than", which passes happily even when the filter does nothing.
The sample data has also been given a test three weeks out, because everything
in it was inside a week, so a broken filter looked identical to a working one.

Your real numbers, for reference: 3 tests in the next week, 5 in two, 6 in
three, 7 in four, 18 in total.

## 2026-08-15 — Page count while you type, and a time frame for tests

**The editor now tells you how long it'll be in Word.** Under the text box it
says something like "about 2.4 pages in Word" and updates as you write, so you
never have to hit submit just to check. It uses the same page layout the hand-in
preview does, on the same document that becomes the actual Word file, so it
can't tell you one thing and then hand in another.

**While checking it, I found the preview was getting page counts wrong.** It was
fitting 27 lines to a page where real Word fits 23 — "double spaced" in CSS means
twice the point size, but Word means twice the *font's* line height, which for
Times New Roman is bigger. So the preview was under-counting by roughly a page
in six. Fixed and checked against Word itself: 23 lines is one page, 24 lines is
two. The Word file was always right; it was the preview that disagreed with it.

**Tests & Quizzes has a time frame picker** — 1, 2, 3, 4 weeks or All. It opens
on All. A window looks forward from today, so something you've already sat only
shows under All, and a test with no date set stays visible whichever you pick.

## 2026-08-15 — Hourly check, and formative vs summative

**Slate checks Canvas every hour on its own** while it's open. Nothing is
installed and nothing runs in the background when Slate is closed — it's just a
timer inside the app, so shutting Slate off stops it. The Sync now button still
works whenever you want it sooner, and if the timer and the button land at the
same moment they share one sync instead of both running.

**Each class card now shows three numbers**: your overall percent in big, then
Formative and Summative underneath. Your school weights those 50-50 in every
class, so seeing them apart is the useful view.

**Every assignment is filed as formative or summative**, taken straight from
Canvas — it's the group your teacher put the assignment in, not a guess from the
title. On the class page each graded assignment now has a Formative or Summative
tag next to its score.

A category with nothing graded yet shows a dash, not 0% — those mean very
different things and a 0 next to Summative would look like you'd failed
something.

## 2026-08-15 — Grades actually come from Canvas now

**Short answer: it wasn't.** Slate was asking Canvas for your grades in a way
Canvas rejects — one wrong character in the request, and Canvas answered with an
error every single time. Slate quietly stepped over the error and carried on, so
nothing looked broken; you just had an empty grades page and a blank GPA. That's
why there were zero grades in there.

Fixed, and now there are two things instead of one:

**Your class grade is the number Canvas itself shows.** Not a number Slate works
out. That matters, because teachers weight things — tests 40%, homework 20% —
and adding up raw points gives a different answer. Slate would have been quoting
you a grade that doesn't exist anywhere else.

**Each graded assignment shows its score** on the class page, so you can see what
made up the grade.

Right now Canvas has 5 things graded: 100% in AP Cyber, AP Pre-Calc and English
IV, nothing yet in the other four, GPA 4.0. That'll fill in as teachers grade.

**The same bug was breaking something else**: Slate couldn't see what you'd
turned in, so "Canvas says this is handed in" never worked either. It does now —
and work Canvas graded but can't date (anything handed in on paper) is marked
done without pretending you finished it today.

## 2026-08-15 — Attached files

**Files your teacher attached in Canvas now show up on the assignment page**,
as a button with the file's name and type. Click it and it downloads once and
opens in whatever your computer already uses for that kind of file — Word for a
.docx, Excel for a .xlsx, your PDF reader for a PDF. Slate doesn't try to be a
document viewer; Word does that better.

This never worked before, and not in a small way: Canvas doesn't hand over
attachments as a list, it buries them as links inside the assignment text, so
Slate had been finding zero attachments on all 35 of your assignments.

**Slate also reads what's inside the file** and uses it to write the
Instructions box. That matters because your teachers keep doing the thing where
the description just says "worksheet attached" and the actual directions are in
the attachment. Word, PowerPoint, Excel, text and web files are read directly;
PDFs and photos go to Claude, the same way your class notes do.

Nothing is downloaded until you ask for it, and it's only ever fetched once.

## 2026-08-14 — Sync follows your schedule

**Classes you're not in anymore go away.** Sync used to only ever add things, so
when your schedule changed the new classes came in and the old ones just sat
there forever. Now Canvas is the schedule: any class that stops showing up in
Canvas is hidden everywhere in Slate — the classes page, Today, the week,
projects, Tests & Quizzes and your GPA.

**Nothing gets deleted.** The old class and everything attached to it — your
drafts, notes, flashcards, study time — is still in the database, just hidden.
If a class comes back on your schedule, one sync brings it back with everything
exactly as you left it. If Canvas ever answers strangely and sends back no
classes at all, Slate ignores it rather than wiping your schedule.

To clean up the classes you dropped, just hit **Sync now**.

## 2026-08-14 — Week tidied up, days you can open

**Unfinished / Finished is a switcher now**, the same kind of button as
Assignments | Projects and the sort buttons, with the count on each. It's on
Today and on Week, and it remembers which one you're looking at when you move
between the two pages.

**Projects only appear on the day they're due.** They used to show on every day
that had a piece of work scheduled, so the same project sat on five days running
and made the week look far busier than it was.

**Click any day in the week and it opens.** You get a card for each thing due
that day — assignment, project or test, labelled as such, with its points and
deadline — and clicking a card takes you straight to that item's page.

Your week looks a lot calmer now: today has 2, Friday's clear, and nothing else
is above 2 a day.

773 checks and 64 tests green.

## 2026-08-14 — Work carries over, and no more auto-indent

**Nothing falls off the list at midnight any more.** If an assignment wasn't
handed in and wasn't ticked off, it comes back the next day — and the day after
— until it's actually dealt with. Late work sits at the top of Today with how
many days late it is on the card, above everything due today, because that's the
most urgent thing on the page.

Opening Today just now, three things had carried over: your Cyber "What do I
believe" activity from the 11th, and Personal Worldview and the ENG IV Vision
Board from yesterday.

**Canvas gets the final say on what's done.** Every sync, Slate checks what
Canvas has actually received. Anything it's got is marked complete — whether you
handed it in from Slate, from a browser, or on paper and your teacher marked it
— and it's stamped with the day Canvas received it, so it lands in the right
day's Finished list. Whatever Canvas hasn't got is what carries over.

Carried-over work counts toward how busy your day is, so three things left over
from yesterday means Slate won't also pull next week's work forward. And that
count doesn't shrink as you clear them, so a busy day can't turn into a quiet one
halfway through.

**The formatter doesn't indent any more.** Paragraphs start at the margin in the
Word file, the PDF, the plain text and the preview. Lists keep their own indent,
since that's list formatting rather than an automatic first-line indent.

777 checks and 64 tests green.

## 2026-08-14 — Pages that aren't one paragraph each, and a stationary preview

**Every paragraph was getting its own page.** The preview works out when a page
is full by asking the page how tall its contents are — but I'd told that element
to always be exactly one page tall, so it answered "full" whether it held one
line or thirty. Everything after the first line looked like an overflow. It
measures the real content height now.

Worth saying: your actual Word file was always fine. I checked the one you sent
and there isn't a single page break in it — the fault was only ever in the
preview on screen.

**The popup is three fixed bands now.** "Hand it in" centred at the top, the
pages in a box in the middle, and the file name, type and buttons pinned along
the bottom. None of those move. The only thing that scrolls is the paper inside
the middle box, so the title and the buttons are always where you left them.

739 checks and 61 tests green. One of those is new and worth explaining: the
test harness has no layout engine, so it can't see a bug like this one at all.
Instead there's now a check that reads the stylesheet and fails if that page
element is ever given a fixed height again. I broke it on purpose to make sure
it actually fails.

## 2026-08-14 — Your Summer Reading assignment, and two real bugs

**First: I wiped your homework, and I'm sorry.** The file you sent wasn't your
writing — it was filler text I'd typed into that assignment while checking the
page preview worked. My script picked the first typed assignment it found and
overwrote the draft. That was your Summer Reading Assignment.

**It's back.** All 343 words, restored from the version you pasted, and Slate's
own draft history had it too — that feature earned its keep today. I've made it
a rule that nothing I run for testing is allowed to write to your real Slate or
your real database; test writes go to a throwaway copy from now on.

Your file did show two genuine bugs, both now fixed:

**Headings were being swallowed.** You wrote "Big Idea:" on one line and the
paragraph underneath. Slate treated that line break as wrapping and glued them
into one paragraph. A short line ending in a colon now stays on its own line —
"Big Idea:", "Connection:", "Discussion Questions:" all sit where you put them.
A colon in the middle of a sentence still behaves normally.

**Your five questions were all numbered "1."** Because you left a blank line
between them, each one became its own separate list starting over at one. They're
one list now, numbered 1 through 5.

**And the .txt and .pdf were out of step with the .docx** — the Word file had
already been fixed to use the proper document structure and the other two hadn't.
All three now render from the same thing, so they can't disagree.

Checked your actual assignment in real Word: 2 pages, Times New Roman 12, double
spaced, heading on its own line, questions numbered 1 to 5.

735 checks and 60 tests green.

## 2026-08-14 — A real editor, and a real page preview

**The text box is a proper editor now.** A toolbar sits right on top of the
writing surface the way Canvas does it, in Slate's colours: font, size, **B**
*I* U, left/centre/right, bullets, numbers, indent, outdent and clear. Pasting
from Word comes in as plain text so a pasted paragraph can't drag someone else's
formatting into your document.

**It starts as MLA and gets out of your way.** Times New Roman 12, double
spaced, unless you pick a font or a size — then that becomes the document's, and
the file you hand in uses yours instead. Bold and italic inside your writing
survive either way. The hand-in screen tells you which you're on.

**The preview is a real page now.** 8.5 by 11 inches with one-inch margins, at
the same scale Word uses. Write past the bottom of a page and it starts a new
one, stacked below like Word's page view, with the count underneath. The whole
stack scales down to fit whatever room there is, so it always stays in
proportion.

**The popup is sized around it** — centred, 94% of the window tall with 3% above
and below, and exactly as wide as a page needs to be at that height. The pages
are still the only thing that scrolls.

**One thing I did not change.** The essay page still has its old box. Its
paragraph outline, click-to-jump and the Get-unstuck coach all work off where
your cursor is in a plain text box, and switching it over without breaking those
is its own job. It keeps the bullet and number buttons it had. Say the word and
I'll do that page next.

735 checks and 58 tests green, including the formatting reaching a real Word
file and the font override replacing MLA in it.

## 2026-08-14 — Hand-in screen tidied up

**"Use these" now says "Save"** — on the heading boxes and on the essay hand-in
panel, which had the same wording.

**The notes under the heading boxes are gone** — the "shortened from…" line and
the one about the date filling itself in.

**Everything fits again.** The preview was taking so much room that the file
name and the buttons were pushed off the bottom. The document now takes a third
of the window at most and scrolls inside that; the panel itself is tighter —
smaller padding, smaller boxes, less spacing — and the long explainer at the
bottom is gone. On top of that the panel will scroll as a last resort if you're
on a very short window, so nothing can ever be out of reach.

720 checks and 56 tests green, including two new ones that fail if the file name
row or the buttons ever leave the panel again.

## 2026-08-14 — The document preview moved to where you asked

The preview was only on the second screen, after you'd already chosen Submit to
Canvas — so if you were saving to your Desktop you never saw it at all.

It's now the first thing under **Hand it in**, above the file name and type and
the buttons. **Only the document scrolls** — the boxes and buttons hold still
however many pages your work runs to.

The heading boxes (your name, Mr./Mrs., teacher, class) are on that screen too
now, so you can fix them whichever way you're handing in rather than only on the
Canvas route.

It loads in about 25ms because it skips the Canvas lookup for earlier attempts —
that question only matters once you're actually on the Submit screen.

720 checks and 56 tests green.

## 2026-08-14 (fix) — Finishing a full day means you're done

You were right to check — it wasn't doing that. The rule was going off how much
was **left** today, so finishing three assignments dropped the count to zero and
Slate decided you'd earned more work.

It now goes off how many the day **held**. A day with three or more things on it
was a full day: clear it and you get "You're done for the day", not next week's
homework. A day that only ever had one or two on it is genuinely quiet, so that
one still fills up with work to get ahead on — which was the point of the feature.

Finishing things doesn't change what kind of day it was, so it can't flip
halfway through. Checked on your real data: today held 5, and clearing what was
left gave nothing pulled forward.

Project work is unaffected — it's still on the Projects tab if you want it, and
the message says so when there's some there.

715 checks and 56 tests green.

## 2026-08-14 — Headings on everything, and list buttons

**Anything you type now goes out as a proper document.** Name, teacher, class,
date at the top; Times New Roman 12, double spaced. That used to only happen for
essays — now every typed assignment gets it, whether you save it to your Desktop
or send it to Canvas.

**It works the class name out for you.** "AP United States Government and
Politics- Nunes" becomes **AP U.S. Government** with **Nunes** as the teacher.
"12th Grade Bible- MacIntosh Gloetzner" becomes Bible. It only ever drops whole
words, never chops one in half, and if a class name has no teacher in it, it
doesn't invent one.

**There's a Mr./Mrs. dropdown** on the hand-in screen, next to boxes for your
name, the teacher and the class. All four are filled in for you, all four can be
corrected, and the correction is remembered for that class from then on. The date
fills itself in. If you type "Mr. Ortiz" into the teacher box it works that out
too rather than printing "Mr. Mr. Ortiz".

**The preview shows the actual page** — laid out in Times New Roman, double
spaced, heading and all — so what you see on the hand-in screen is what your
teacher gets.

**Admins can edit names.** There's an Edit name button on every account. This one
matters more than it looks: the name at the top of your documents comes from your
account, and yours currently just says "Will" — worth changing to your full name.

**Bullet and number buttons** above every text box: Bullets, 1. 2. 3., Indent,
Outdent and Clear. Press Enter and the list carries on; press it on an empty item
and the list ends. They're real characters in your draft rather than hidden
formatting, and the Word and PDF files indent them properly.

Checked in real Word: opens clean, Times New Roman 12, double spaced, heading on
top, bullets indented.

730 checks and 55 tests green.

## 2026-08-14 (fixes) — Finishing work-ahead, and the missing key box

**Finishing something you pulled forward no longer makes it vanish.** It lands in
Finished today like anything else, whatever day it's actually due. Underneath,
"finished today" now means the day *you* ticked it off, full stop — it used to
also depend on the due date, which is what made work-ahead disappear.

That same fix caught a second problem you hadn't hit yet: the day was worked out
from a UTC timestamp, so anything finished after about 8pm would have jumped to
tomorrow's list. It reads your local day now, same as the rest of Slate.

**The GPTZero key box is back.** It was written into the part of the API page
that only shows when Canvas *isn't* connected — so it appeared while I was
testing and disappeared the moment you had Canvas hooked up. It sits below the
Canvas section either way now.

**Buttons renamed:** "Submit — make my file" is just **Submit**, and "Not done
after all" is **Move to unfinished**.

735 checks and 53 tests green.

## 2026-08-14 (last one) — Optional AI checker

There's a **GPTZero API key** box at the bottom of the API tab. Leave it empty
and nothing changes. Put a key in and the hand-in screen shows one number: how
likely GPTZero reckons your writing reads as AI.

It runs by itself when you open the hand-in screen on written work, and the
result is remembered against that exact draft — reopening without editing
doesn't spend another check. Under about 50 words it says so instead of scoring,
because the number means nothing on two sentences. Slideshows get skipped
entirely, since there's nothing to read.

**It's a number, not a gate.** Whatever it says, handing in works the same. And
it's a number about work you wrote, so a high score means the detector is wrong —
the readout says so, and points you at your draft history, which is the thing
that actually answers an accusation.

What it does **not** do, as we agreed: tell you what tripped the detector. No
list of triggers, no "try changing this". There's a test that reads the source
and fails if that ever creeps in.

Two things worth knowing. Turning it on means your writing gets sent to GPTZero
when you open that screen — the API page says so right next to the box. And I
have not been able to test against the real service, since I don't have a key.
The whole path is verified against a stand-in, and the response parsing handles
both shapes GPTZero has used, but the first real call will be yours. If it comes
back with an error, tell me what it says and I'll fix it.

The key is stored with your Canvas token, server-side. Only the last four
characters ever reach the page.

722 checks and 52 tests green.

## 2026-08-14 (later still) — Finished and unfinished

**Today** is split in two. **Unfinished** is what's still on you — same list as
before. **Finished today** appears underneath once you tick something off, with
the count next to each heading. Finished cards stay readable but dim, with the
title struck through, and every one has a **Not done after all** button if you
tapped it by mistake. The Projects tab splits the same way for project pieces.

Finished only shows up when there's something in it, so a fresh morning looks
exactly like it always did.

**The week** does the same per day. Each day lists what's left, then a
**Finished (n)** block underneath with what's handled. The pill by each date now
says how many are *left* rather than the raw total, and reads "all done" when a
day is clear because you did it rather than because nothing was due.

It counts what you actually finished in Slate. Work Canvas imported as
already-graded from earlier in the year doesn't turn up in either place — only
things you ticked off or handed in.

704 checks and 49 tests green. One of them earned its keep straight away: a
bad edit meant the week's Finished block was never written into the page at all,
and the test caught it before you would have.

## 2026-08-14 (later) — Hand it in, two ways

The Submit button now gives you a choice: **Save to my Desktop** (what it always
did — the file lands on your Desktop and you upload it yourself) or **Submit to
Canvas**.

**The Canvas route always shows you the file first.** You get a screen with how
it's going in, the filename and size, the word count, the real deadline, and the
actual content — the whole thing, not a summary. Nothing has been sent at that
point. There are three ways off that screen: **Go back and edit**, **Save to my
Desktop instead**, or **Send it to Canvas**.

It knows when it can't help. On-paper work, DeltaMath and anything handed in on
another website say so plainly and point you at the download instead. An empty
draft is never sent. If the deadline has passed it tells you Canvas will mark it
late, and if Canvas already has an attempt it tells you when — and if it's been
graded — before you add another. Once it goes through, the assignment is marked
done.

**Slate still never submits on its own.** The only writing it does to Canvas
happens when you press that button on the preview screen; every other Canvas call
in the whole app is a read.

**Worth knowing: the real send has never been fired.** The whole path is tested
against the fake Canvas, which records what it was handed instead of sending it —
that's how I can prove the preview matches what goes, that backing out sends
nothing, and that an empty draft is refused. But I deliberately have not pushed
anything to your actual Canvas account. You'll be the first, so pick something
low-stakes for the first go.

675 checks and 49 tests green.

## 2026-08-14 — Email popup, exams in the right place, no more bars

**Click an email and it opens.** The list still shows a preview; clicking one
opens a popup with the whole message and everything attached to it. Attachments
are listed with their file size and open in your browser. Canvas only hands over
the full text one message at a time, so Slate fetches it when you open it and
keeps it after that.

**Exams are on Tests & Quizzes now, not Projects.** Your teachers post exams as
ordinary Canvas assignments, and Slate was filing anything worth 50+ points as a
project — so "Unit 1 Exam" and "Unit 2 Exam" were sitting on your Projects page.
They're tests now, with flashcards and a study timer like the rest. Work *about*
a test stays where it belongs: a study guide, review sheet, test corrections or
quiz prep is still an assignment. And an essay called "(Final)" is still a
project, because that means the final draft.

**The tab is called Tests & Quizzes.**

**Every assignment shows the real date and time it's due** — "Due Fri, Aug 15 at
8:00 AM" — on the cards, on the work pages, on projects and on tests. That works
*with* the before-noon rule rather than against it: your Unit 1 Exam is really due
4:00 AM on the 28th, so it sits on the 27th where you can actually do something
about it, and the card tells you the true deadline and says "do it today".

**All the progress bars are gone**, replaced by plain lines like "3 of 8 pieces
done" and "45:00 of 2:00:00 goal".

**All the emojis are gone.** I left the plain arrows (← ↗), the ⋯ menu button and
the ✓ in the chunk checkboxes, since those are doing a job rather than decorating
— say the word and they go too.

**The "worked today" counters are gone** from both Today and the test page. Slate
still quietly records the time in the background, so nothing is lost if you want
the number back later.

**A bug in my own tests, which you should know about.** One of the tests I wrote
yesterday called the sync engine directly instead of in a sandbox — which meant
it wiped and re-synced **your real workshop database, against your real Canvas**,
every time the tests ran. That's how your actual classes appeared. No harm was
done (Slate only ever reads from Canvas, and it never touched the Slate on your
Desktop) but it should never have been able to happen. That test now runs in its
own process against a throwaway database, and I proved it: your data and last
sync time are identical before and after a full test run.

The upshot is your real Canvas is loaded in the workshop copy — 7 classes, 26
assignments, 17 tests and quizzes, 50 emails. If you'd rather it were empty,
`npm run clear` takes it back out.

663 checks and 45 tests green.

## 2026-08-13 (later still) — Sample data gone, smarter days

**All the sample data is deleted**, from both the workshop copy and the Slate on
your Desktop. Slate now starts genuinely empty and will never quietly fill itself
with made-up classes again — even pressing Sync now with nothing connected leaves
it empty instead of loading fakes. The fake data still exists for testing, but
only when the test harness asks for it by name.

**Anything due before noon now shows up the day before.** An essay due 8:00 AM
Friday is really Thursday's job, so that's the day Slate puts it on. The card says
"hand in 8:00 AM tomorrow" so it never looks like Slate has the wrong date, and
the real Canvas deadline is kept underneath.

**A quiet day now fills itself.** If you have two things or fewer due today, Slate
pulls the next few assignments forward so there's something to get ahead on —
never more than three, always the soonest ones, always listed under today's own
work with a dashed edge and a "getting ahead" note so you can tell them apart. If
you have three or more due today it leaves you alone.

**Two bugs found while testing this, both fixed.**

The first is the one that matters. Your real Canvas is connected — I tripped a
sync by accident while testing and it **crashed partway through**, on a class
that has quizzes switched off. Canvas answers "not found" for those, and Slate
treated that as fatal, so it stopped and left you with one class and none of the
others. It now steps over anything a class doesn't have — quizzes off, modules
hidden, whatever — and brings in everything else, then tells you how many bits it
skipped. I cleared the half-finished sync out so there's no mess.

The second: a brand-new Slate with no Canvas at all was reporting itself as
*connected* on the API page, because the code only knew "sample data" and "real"
and had nowhere to put "nothing yet".

621 checks and 42 tests green, including a fresh Slate that has to stay empty, a
sync where three different classes fail in three different ways, and the light-day
rule being walked all the way from four assignments down to none.

## 2026-08-13 (later) — "Worked today" that actually resets

You were right, nothing reset. Now there's a real daily number.

**Today page** has a line under the day bar: **"45 min worked today"**, or
"Nothing logged yet today" first thing in the morning. It counts every minute you
log, from study timers and anywhere else, and it starts again from zero at
midnight.

**The test study log** now shows both numbers, because they answer different
questions. The bar is still the whole run-up to that test — "1h 20m of 2h goal" —
because that one *should* keep climbing until you're ready. Underneath it now
says how much of that was today.

**Nothing has to run at midnight for this to work.** Every stretch of time gets
stamped with the day you worked it, so a new day simply has nothing logged
against it yet. That means it can't drift, can't fire twice, and can't miss a day
because the app was closed. It follows your computer's clock, which is set to
Eastern, so it turns over at New York midnight.

**And the window notices when the day changes.** Since Slate stays open in the
background now, a window left up overnight used to sit there showing yesterday's
plan until you clicked something. It now checks every 30 seconds and redraws
itself when the date rolls over — and if a study timer is running at the time, the
minutes you'd already put in get banked against the day you actually worked them,
not tomorrow.

Your existing study totals were left alone. Today just starts at zero, which is
the point.

570 checks and 38 tests green, including one that stuffs yesterday's and today's
hours into the same database and proves only today's get counted.

## 2026-08-13 — Class Notes: photograph your notes, get flashcards

**Classes open as full pages now**, like assignments and projects already did,
instead of that little grades popup. Same grades table as before under a
**Grades** tab, and a new **Notes** tab beside it.

**Add Notes** takes a photo or screenshot of your notes — handwritten or typed —
and Slate types them up for you. The original photo is kept, so you can always go
back and look at it. Reading a page takes about 15 seconds.

Each note has a **⋯ menu** with three things:

**Edit Note** opens the typed-up text so you can fix anything Slate misread, and
retitle it.

**Add to Test** lets you pick any test in that class. This is the part that
matters: the whole note goes to Claude and it *thinks about what's actually worth
studying* before writing a single card. It is not splitting your notes into
lines. Tested on a real page of cell-respiration notes — it produced 14 solid
cards (equations, where each stage happens, an aerobic-vs-anaerobic comparison,
the two kinds of fermentation) and correctly ignored "p. 142-149, do questions
3-11 odd for friday" and "Mrs. Alvarez said the ETC is definitely on the test!!".
That took about 12 seconds. The cards go straight onto the test, and the note
itself shows up on the test's Notes tab with the original photo attached.

**Delete Note** asks first, then removes the note, its photo and any flashcards it
made.

Odds and ends that matter in practice: one note can go on several tests, one test
can hold several notes, and adding the same note twice does nothing rather than
doubling up your cards. You get "reading your notes…" and "working out what is
worth studying…" while it thinks, and the page refreshes itself when it's done.

**If the AI can't read your photo, you don't lose anything.** The note is saved
before any of the thinking starts, so a bad photo leaves you a note you can just
type in yourself. Same with flashcards: if that step fails, your note stays
exactly where it is, on the test, with a Try again button.

Testing is now 595 checks and 37 tests, all green — including the whole flow
against real Claude, and the specific check that it throws the homework reminders
away instead of turning them into flashcards.

## 2026-08-12 (later) — API tab and Admin tab

**API tab.** Two boxes: your school's Canvas web address and your access token.
Hit Connect and Slate checks the token against Canvas *before* saving it, so a
typo tells you what's wrong instead of quietly leaving you on sample data. Once
it's good it saves and pulls everything in straight away. The page then shows who
you're connected as, with Sync now and Disconnect buttons, and there's a short
walkthrough on the page for finding the token in Canvas. The token is stored with
your data, not with the app files, so updating Slate never loses it.

**Admin tab.** Add user opens a popup for a name and password, with a checkbox to
make them an admin. Each person in the list shows how many devices they're signed
in on and when they were last active; Devices opens the full list (what browser,
what computer, when), and Sign out all boots them off everywhere at once. You can
freeze an account — which keeps them and their work but locks them out
immediately, kicking off every device — or delete it outright. Delete asks first
and explains the difference. Your own account can't be frozen, deleted or
demoted, so there's no way to lock yourself out.

**Sign-in stays off until it's actually needed.** While you're the only account,
Slate opens straight to Today exactly like it always has — no password, no login
screen. It switches on by itself once there's a second account *and* you've set
your own password. The Admin page tells you which of those two is still missing.
That ordering is deliberate: adding a friend can't accidentally lock you out of
your own app.

Passwords are salted and hashed (scrypt) — the actual password is never written
down anywhere, and there's a test that proves it. Sessions are random tokens in
an HttpOnly cookie, one row per signed-in device, which is what the device count
is counting.

**What this does NOT do yet.** Slate still only listens to your own computer, so
nobody else can reach it even with an account. And everyone who signs in would
currently see *your* schoolwork — the database has no notion of whose assignment
is whose yet. Both of those are the next pieces of work; until they're done this
is the account system, not the sharing.

API and Admin are pinned to the bottom of the tab list, sitting right on top of
the divider above Sync now, instead of floating up under Email.

Testing is now 499 checks and 35 tests, all green — including that a frozen
account can't sign in, that freezing kicks devices off immediately, that a
non-admin gets turned away from the admin page, and that a stranger with no
session gets a 401 instead of your schoolwork.

## 2026-08-12 — Slate is a real app on your computer now

**There's a Slate icon on your Desktop.** Double-click it and Slate opens in its
own window — no address bar, no tab strip, no black terminal window. It looks and
behaves like an app you installed, because now it is one. There's a **Quit Slate**
button at the bottom of the sidebar that properly shuts it down, and the build
number sits just under it so you always know which version you're looking at.

**How it got there.** `Install Slate.bat` in the project folder. Run it once and
it installs Slate to your computer and makes the Desktop icon. Run it again any
time and it updates — it deletes the old app files and lays down the new ones.

**Your school work is kept somewhere the updater can't reach.** Assignments,
drafts, notes, study history and your Canvas token live in their own folder,
completely outside the app files. Updating Slate wipes and replaces the app and
never so much as opens the data folder. The first install copied your existing
Slate data across, so nothing was lost.

**Two copies, on purpose.** The folder on your Desktop is the workshop — when I
make a change I run it there, on localhost:4173, and send you the link to look
at. Your real Slate carries on running untouched on its own. Changes only reach
the real app when you say "push it", and then the new version is built, the old
app deleted, and the icon points at the new one. Nothing half-finished can end up
in the app you actually use.

**A bug found and fixed while building it.** Quitting Slate and immediately
double-clicking the icon again started a copy that died the instant it launched,
because the old one hadn't finished letting go of its port yet. Since it runs
hidden there was nothing to see — the icon just appeared to do nothing. It now
waits the port out and retries, and if it ever genuinely can't start it says so
in a pop-up instead of failing silently. It also writes a log of every start to
`%LOCALAPPDATA%\Slate\slate-log.txt`.

**Testing.** The sweep is now 420 checks (up from 412) and all green, plus the 33
smoke tests. The new checks cover the parts that could bite: the workshop copy
must refuse to be quit and must not show the Quit button (the harness clicks
every button it can find — one wrong click would shut down the server mid-test),
and the installed copy must show both the button and its build number.

## 2026-07-22 (full sweep) — Tested every button in the app, fixed 2 bugs

I built a test harness that drives the entire app end to end and ran it: 469
checks across every page, button, text box, checkbox, dropdown and file upload.
Two real bugs turned up, both fixed.

**One quiz could never get flashcards.** Slate only recognised study material if
the teacher's file was called a "study guide" or a "review sheet". Your English
teacher posted "Vocabulary Set 4 List" — so that quiz sat there with zero cards
even though the vocab was right there in Canvas. It now recognises notes, lists,
vocab, terms, glossaries, practice and outlines too, and ignores anything that
turns out to be empty. That quiz now has 5 real term/definition cards.

**"hey will" was leaking into your assignment instructions.** The hidden Claude
that simplifies instructions reads the project's notes file, which tells it to
greet me by name — so the greeting was landing in your Instructions checklist as
the first bullet. It now asks for the answer in a structured format and throws
away anything wrapped around it. Verified on all four of today's assignments:
clean checklists, no greeting.

**What got tested.** Every view renders and every sidebar tab navigates; Today's
sort buttons and the Assignments/Projects tabs; opening assignments; typing and
autosave; Submit and the download popup in every file format; mark complete and
reopen; the essay editor (percent, outline labels, Get unstuck, hand-in panel,
MLA download); the slideshow builder (title slide, editing, picture toggles, add
and remove slides, auto-outline, PowerPoint/HTML export); ticking chunks in any
order; dragging notes files onto tests; flashcards flipping and grading; the
study timer; classes, grades, GPA and email; plus deliberately bad input —
missing pages, oversized uploads, binary files, junk filenames, unknown formats.

The generated PowerPoint and Word files were opened in real PowerPoint and real
Word to confirm they're clean, and the four AI features were run against real
Claude Code, not a stand-in.

You can re-run the whole sweep yourself any time with `npm run drive` (or
`npm run drive:all` to include the slower live-Claude checks).

**And there's a loop now: `npm run drive:loop`.** It runs the sweep, then sits
there watching your files. Change any code and save, and the entire sweep re-runs
on its own and tells you whether it's clean. Leave it running in a window while
you work. I proved it out by deliberately breaking two different things — the
2-hour daily target, and the paragraph labels in the essay outline — and both
times it caught the break on its own and went back to green the moment I fixed
it. Ctrl+C stops it.

## 2026-07-22 (two fixes) — Works Cited was throwing off the essay page

Testing with a full sample essay turned up two bugs, both fixed:

**The conclusion was being called "Body 4."** When your Works Cited heading sits
on its own line with a blank line before the sources, the outline treated the
list of sources as a normal paragraph — so the real conclusion wasn't the last
one anymore and lost its label. Now everything after the Works Cited heading is
recognised as citations no matter how it's spaced.

**Your sources were counting as sentences.** Three MLA entries read as about
nine sentences, which pushed the percent-done meter up without you writing
anything. Citations are now excluded, so the percent reflects only the essay.
The same fix means a Works Cited page no longer counts toward "5 of 5
paragraphs" either.

## 2026-07-22 (slide redesign) — Better-looking decks, no more auto pictures

**Slide 1 is always a real title slide, already filled in.** It comes pre-loaded
with the assignment name as the title and your class as the subtitle, and both
are editable — it's the first card in the builder, labelled "Title slide". What
you type there is exactly what shows up on the opening slide. (Before, Slate
quietly added its own title slide on top of yours, so you got two.)

**Pictures are gone.** Slate no longer goes and finds photos off the internet,
and there's no image credits slide anymore. Nothing leaves your computer when
you build a deck now, and exports are instant instead of taking a few seconds.

**Instead, every slide has a "Leave space for a picture" checkbox.** Tick it and
that slide reserves a clean dashed frame on the right that says "Picture goes
here" — your text shifts left to make room, and you drop your own picture in
once you open it in PowerPoint. Leave it unticked and the text uses the full
width.

**The formatting does the heavy lifting now, so slides look good without
photos.** Each bullet becomes its own rounded card in Slate's dark surface
colour with a sage accent tab down the left edge, and the stack is centred so a
short slide doesn't look empty. Each slide gets a small number up top, a sage
title with an accent underline, and a page count in the corner. The title slide
is a big sage headline against a vertical accent rule with a three-dot motif in
the corner. All still Slate's colours: dark background, sage accent, off-white
text.

I opened a five-slide deck in real PowerPoint to check — no repair prompt,
everything landed where it should, and the picture space only appeared on the
one slide I ticked. The .html export got the same redesign.

## 2026-07-22 (even pacing) — Projects spread out evenly, no more focus timers

**Projects are now split into even daily work.** Every single day between now and
the due date gets a piece — no more three big days and a week of nothing. It's
even by how much *work* each step is, not by counting steps, because the steps
aren't the same size. Your American Dream essay went from 3 lumpy days to 9 even
ones: 2 days on the thesis, 6 on the three body paragraphs, 1 on the works cited
page. Multi-day pieces read like "Start: Three body paragraphs (day 1 of 6)" and
"Finish: … (day 6 of 6)".

**You can work on any part, not just today's.** The project page now lists every
piece of the plan with a checkbox. Today's is highlighted, but tick off whatever
you actually got done, in any order, and untick it if you change your mind. All
your writing goes into the same text box no matter which piece you're on.

**The essay screen shows percent done instead of a chunk bar.** It counts the
sentences you've written against roughly how many the assignment needs (it read
"5-paragraph" and worked out about 30 sentences), and updates as you type. Big
number at the top: "23% of your essay written · 7 of about 30 sentences".

**Focus timers are gone everywhere except studying for tests.** Assignment pages
and project pages don't have them anymore. The study timer on the test page —
the one counting toward your 2-hour goal — stays exactly as it was.

Today still works the same way and now has more to pull from: it adds up what's
due today, and if that's under 2 hours it fills the rest with pieces of your
projects.

## 2026-07-22 (finishing an essay) — Fixed the disappearing draft, added hand-in

**Fixed: marking a chunk done was wiping the text box.** The editor saved on a
delay, and finishing a chunk reloaded the page before that save happened, so
whatever you'd just typed got replaced by the older saved copy. Now anything
that reloads the page — finishing a chunk, switching tabs, hitting back, closing
the window — saves your typing first. Nothing you write can be lost that way
again. Same fix applied to the regular assignment editor.

**Fixed: "Compile my work for review" just showed the instructions again.** For
essays that button is gone, replaced with **Put my essay together**.

**New: putting the essay together in MLA format.** Finish your chunks (or hit
Submit in the editor any time) and Slate assembles everything you wrote:

- Your paragraphs, in order, exactly as you wrote them — Slate doesn't touch a
  word of the writing.
- The MLA heading block: your name, teacher, class, date.
- Your own title, centered. Slate asks for one instead of using the Canvas
  assignment name.
- Double spacing, Times New Roman 12, 1-inch margins, and a "Caldwell 1" running
  header in the top right corner.
- Anything you put under a **Works Cited** line at the end of your draft becomes
  a proper Works Cited page — its own page, hanging indents, the works.

Your name and teacher are remembered, so you only type them once per class.

Before you hand it in there's a checklist: name, teacher, title, how many
paragraphs you've written versus how many the assignment asks for, word count,
and whether you have sources. Then **This is done — save it to my Desktop**
gives you Word, PDF, or plain text. The Word file was opened in real Word to
check — Times New Roman 12, double spaced, header, Works Cited on page 2, no
repair prompt.

**New: your writing record.** Slate now quietly keeps a saved version of your
draft every ten minutes while you write. The hand-in screen shows how many
versions there are, over how many days, and how long the focus timer ran. If
anyone ever asks whether you actually wrote it, that history is the answer.

## 2026-07-22 (day planner) — Today now plans your whole 2 hours

**Every assignment gets a time estimate.** Slate works out roughly how long each
one takes from the points, the kind of work it is (writing takes longer than
recording a video), and how many problems it lists — "#1-25 odd" counts as 13
problems, not 25. Today's cards now show "~40 min" next to the points.

**Today fills out your day.** It adds up everything unfinished that's due today.
If that comes to less than 2 hours, it pulls in pieces of your upcoming projects
to fill the rest — the ones scheduled for today first, then whatever's next up if
you're working ahead. A bar at the top shows how the day adds up.

**Today has two tabs now: Assignments and Projects.** Assignments is what's due
today. Projects is the project work Slate pulled in to fill the time — just those
pieces, not the whole project. Mark one done right from the card.

As you finish things, the freed-up time pulls in more project work, so the day
always adds up to about 2 hours. With the sample data, today's four assignments
come to exactly 2 hours, so the Projects tab starts empty — finish one and watch
project work appear.

The Projects page is unchanged: still every project in one place.

## 2026-07-22 (essay outline labels) — Paragraphs are named

The paragraph outline in the essay editor now labels each one: **Intro & thesis**,
**Body 1**, **Body 2**, **Conclusion**, **Works cited**. It's smart about
mid-draft — the paragraph you're working on stays "Body 2" instead of getting
called the conclusion just because it's last. Once the essay is as long as the
assignment asks for, the last one becomes the Conclusion. Start a paragraph with
"In conclusion" and it gets named that right away.

Get Unstuck uses the label too, so instead of "paragraph 3 of 5" it tells the
coach you're stuck on "body paragraph 2" — and the advice comes back sharper.

## 2026-07-22 (essay editor) — A real place to write essays, with a coach

Essay projects now open a proper writing editor instead of a plain box. Slate
spots them on its own (anything that says essay, thesis, paragraphs, lab report,
research paper…), so the American Dream Essay opens straight into it.

What you get that a normal text box doesn't have:

- A big, calm writing surface that saves as you type.
- Live word count, character count, and reading time. If the assignment asks for
  a word count or "5 paragraphs," it shows how close you are.
- A **paragraph outline** down the right side — every paragraph you've written,
  with its word count. Click one to jump straight to it. The one your cursor is
  in is highlighted.
- **Submit — make my file** turns the essay into a .txt, .docx, or .pdf on your
  Desktop, same popup as everywhere else.

### The "Get unstuck" button

Stuck mid-paragraph? Put your cursor there (or highlight the bit you're fighting
with) and hit **✨ Get unstuck**. Slate quietly sends your draft into Claude in a
hidden terminal — no window pops up, nothing to set up — and a few seconds later
a panel appears on the right with:

- **Where you are** — what your draft is actually arguing so far, so you can pick
  your train of thought back up.
- **What this part has to do** — the job of the section you're stuck on.
- **Hit these** — three or four short notes on what belongs in it.
- **Answer this first** — one question that gets you moving again.

The notes appear in their own panel and never touch your draft. Slate doesn't
write any of your essay — that's the whole point, and it's the one thing it won't
do. It tells you what the paragraph needs to accomplish; you write the words.

Takes about 15–20 seconds the first time. There's a Cancel button if you change
your mind, and if Claude Code isn't available it falls back to built-in coaching
that still works with no internet. Your draft is never changed either way.

## 2026-07-22 (instructions cleanup) — Easier-to-read instructions

The Instructions section no longer sits in a shaded box — it's now just clean
text on the page. And it's written as a short checklist: one thing to do per
line, with the fewest, simplest words, cutting anything that isn't a direct
action. Example: "Write one paragraph about Chapter 3 / Explain how Gatsby's
party shows social class / Turn it in on paper or online." Applies to every
assignment, project, and slideshow.

## 2026-07-22 (even later) — Slideshows auto-build their outline

Open a slideshow project now and Slate fills in the slides for you automatically:
it reads the assignment, and if the instructions ask for a certain number of
slides (like "6-8 slides") it makes that many. If the assignment says to pick a
subject — e.g. "choose a founding document" — it picks a good specific one (it
chose the U.S. Constitution in my test) and titles every slide to cover what's
required (summary, background, key ideas, impact, conclusion). You just fill in
the content under each header. There's also an "✨ Auto-fill outline" button to
regenerate a fresh outline anytime. First build takes a few seconds; you'll see
"Building your slide outline…" while it works.

## 2026-07-22 (later) — Simplified instructions on every assignment

Every assignment, project, and slideshow page now has an **Instructions** box at
the top that rewrites the Canvas instructions into 2–4 short, plain-English
sentences — just what you actually need to do, in easy words. It shows a quick
version instantly, then swaps in the smarter Claude-written one a moment later
(and remembers it so it's instant next time).

Also fixed the slideshow builder: it no longer turns a step like "make 6–8
slides" into a slide title. That kind of instruction now lives in the
Instructions box instead, and the builder just starts you with a title slide and
one blank slide.

## 2026-07-22 — Good-looking PowerPoints with real pictures

Slideshows now come out looking sharp: a Slate-styled title slide, sage-green
headings with an accent underline, clean bullets, and a **relevant picture on
each slide** pulled automatically. Pictures come from Wikimedia Commons (real
diagrams, NASA photos, etc.) with a backup source, and there's a tidy "Image
credits" slide at the end so everything's properly attributed. I checked the
result by opening it in real PowerPoint and looking at the actual slides — the
title slide, a content slide with its diagram, and the credits page all look
right and open with no repair warning.

How the pictures work: when you export a slideshow, Slate looks up one image per
slide based on the slide's title. It needs the internet for that step only, and
if you're offline it just skips the pictures and still makes the file. Images
are cached so re-exporting is quick. (Set the off-switch SLATE_NO_IMAGES=1 if you
ever want text-only.)

## 2026-07-19 (round 7) — PowerPoint builder + smarter downloads

**Slideshow projects.** If a project is meant to be a PowerPoint/slideshow
(Slate reads the assignment and its attached files to figure this out), the
project page now shows a **slide builder**: add a slide per idea, type a title
and bullet points for each, and it autosaves as you go. Hit "Submit — make my
PowerPoint" and it builds a real .pptx and saves it to your Desktop. I tested
it by opening the generated file in actual PowerPoint — it opens clean, no
"repair" warning, with your exact titles and bullets. (Real Office files, built
with zero installs, all on your machine.)

**Better downloads, everywhere.** Every download now opens a popup with:
- a text box showing the default file name that you can edit to anything, and
- a dropdown of file types.

Pick a type (or hit Download) and it saves that file to your Desktop. Written
assignments can save as Text, Word (.docx), or PDF. Slideshows can save as
PowerPoint, a web page, or a text outline. If you save the same name twice it
adds a number instead of overwriting.

All 15 automated tests pass, including checks that the PowerPoint, Word, and PDF
files are valid.

## 2026-07-19 (round 6) — Test page tidy-up

Removed the "% studied / cards known" bar from the top of the test page. Moved
the study-log timer down to the very bottom, with just the centered words
"Study log" above it. Centered the Flashcards / Notes buttons too.


## 2026-07-19 (round 5) — Drag notes onto a test; AI turns them into study material

On the Tests page you can now **drag a notes file straight onto a test's card**.
Slate quietly opens Claude Code in a hidden background window, has it read your
file, and turns it into flashcards for that test plus a written notes summary
for the stuff that doesn't fit on flashcards (big-picture ideas, formulas,
themes). The card shows "Reading your notes…" while it works and "Notes added ✓"
when it's done. If Claude Code isn't available or the file can't be read, it
falls back to a built-in reader so a drop always does something. Tested it live
with a real file — it made 7 clean flashcards and a tidy summary.

Inside a test page there are now two buttons under the header, **Flashcards**
and **Notes** — click to flip between reviewing cards and reading the notes.

The **study log** is now separate from the focus timer: it counts up your total
study time across every session and fills toward a goal of **2 hours for a test,
30 minutes for a quiz**. (The old per-test study budget got bumped from 90 min
to 2 hours to match.)

## 2026-07-19 (round 4) — Projects and tests open full pages too

Clicking a project or a test now opens a whole page (with a Back button), just
like assignments — no more popups. The project page shows your progress, what
you'll hand in at the end, and just today's chunk with its done button — and it
now has the same 30/10 looping focus timer at the bottom. The test page is the
full study tool: study timer with its budget, study guide link, and flashcards,
all with more room to breathe. All 12 automated tests still pass.


## 2026-07-19 (round 3) — Sidebar navigation

The section bar (Today, Week, Projects, Tests, Classes, Email) now runs down
the **left side** of the app instead of across the top. The Slate logo sits at
the top of the sidebar and the sync status + "Sync now" button live at the
bottom of it. If the window gets really narrow, it folds back into a top bar so
nothing breaks.


## 2026-07-19 (later) — Full-page assignments, typing your work in Slate, pomodoro timer

**Assignments now open a full page, not a popup.** Click a card on Today and
you get a whole page for that assignment, with a Back button.

**The page matches the kind of assignment:**
- If it's written work (a Canvas text box, or a doc you'd upload): you get a
  big text box right in Slate. It saves your draft automatically as you type.
  When you're done, hit "Submit — make my file" and Slate turns exactly what
  you typed into a .txt file **saved straight to your Desktop** (a popup
  confirms it, with a backup download button). You write every word — Slate
  just packages it. Nothing is ever sent to Canvas.
- If it's a worksheet / photo / poster / recording type of assignment: the page
  shows simplified instructions plus a numbered step-by-step guide instead.

**New focus timer (bottom of the work page):** runs 30 minutes of focus, then
automatically gives you a 10-minute break, then starts the next focus round on
its own — looping until you pause. Only focus minutes count toward your logged
time.

**Checked everything else:** wrote an automated test suite that boots the app
and walks all 12 feature areas (sync, today, both work-page types, drafts,
submit-to-file, download, timers, week, projects/chunks/compile, tests/
flashcards, grades/GPA, emails). All 12 pass. Syncing twice doesn't duplicate
anything, and re-syncing never overwrites a draft you've typed.


## 2026-07-19 — First working build of Slate

Built the whole app end to end and tested every page in a real browser.

**The foundation**
- A local database (built into Node, nothing to install) that holds classes,
  assignments, projects, tests, flashcards, grades, and emails.
- A fake "Canvas" that returns realistic sample data (5 classes, homework,
  projects, tests/quizzes, past grades, study guides, notification emails) so
  everything works before school starts. When you add a real Canvas token, it
  switches to your real Canvas automatically.

**The smarts**
- Cleans up messy assignment names (drops "HW", "CW", dates, page numbers).
- Sorts each assignment into a regular assignment or a project.
- Summarizes each one into "what to hand in" plus a step list.
- These use simple built-in rules now; add a Claude API key later for smarter
  results.

**The pages (all working and tested)**
- Today: cards for what's due, mark-complete, focus timer, and a "by grade
  impact" sort.
- Week: the next 7 days at a glance.
- Projects: auto-paced into daily chunks that get lighter on your busy days;
  when all chunks are done it compiles your work into one review sheet.
- Tests: study progress bar, study timer against a time budget (90 min per
  test, 30 per quiz), auto-made flashcards with spaced repetition, and study
  guides pulled from Canvas modules.
- Classes: grades per class and an overall GPA.
- Email: Canvas notifications, reformatted to read cleanly.

**Launcher**
- `Start Slate.bat` starts the app and opens your browser.
- `setup-daily-sync.ps1` (optional) makes it sync every morning.

**A bug I caught and fixed**
- Dates were off by a day in some time zones (UTC vs. local). Fixed so "due
  today" is always correct.
- Switching tabs right as a popup closed could blank the screen. Fixed.
