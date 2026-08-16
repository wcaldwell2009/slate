# School Tracker App — Spec for Claude Code

**Status:** Personal use app. No payment/store, no website — local install only, all data stored on your computer.

**Excluded on purpose:** Any feature that auto-writes assignments, runs writing through an "AI detector evasion" pass, or auto-submits work. Not building that.

---

## 1. Architecture

- **Local app only.** No website, no remote server. Claude Code builds an installer that sets everything up on your computer.
- **Storage:** Local database file (e.g. SQLite) on your machine — no cloud needed.
- **Daily job:** A local scheduled task on your computer that logs into Canvas via API once a day per class.
- Login/multi-device sync is dropped for now since everything lives locally — can revisit later if you ever want it on more than one device.

Suggested stack: Electron or a local web app (localhost) for the UI + Python or Node backend + SQLite. Claude Code can pick the exact stack.

---

## 2. Canvas Sync Engine

- Connects to Canvas via API token (you generate this in Canvas settings — no password stored).
- Daily: pulls all assignments from every enrolled class.
- For each assignment: saves title, description, attached files.
- **Name cleanup:** strip dates, "HW", "CW", etc. so title is just the assignment's actual subject.
- **Categorize:** Claude reads description/files and sorts into `regular assignment` vs `project`.
- Descriptions get simplified into: final deliverable + step list (stored, not shown raw).

---

## 3. Daily Dashboard

- Cards for each assignment due that day: name (top), class name (smaller, muted), points, progress bar.
- "Mark complete" button on each card (e.g. did it on paper) — removes it from dashboard.
- Clicking a card opens the detail view (simplified description + steps).
- **Grade-impact sort option:** sort by points × class weight instead of just due date, so highest-impact work surfaces first.
- **Focus timer:** built into the assignment detail view — start/stop timer while working on that assignment.

## 4. Projects Dashboard

- Separate tab, same card style.
- Engine auto-paces: splits project into daily chunks based on days-until-due and how much regular work is due that day. Regular assignments get priority; projects fill remaining capacity.
- Clicking a project card shows **only that day's chunk**, not the whole thing.
- When all chunks are done, compiles your work into one file for review (you still write/do the actual work — this just organizes and paces it).

## 5. Tests Dashboard

- Cards: test name, class, progress bar = how much material you've studied.
- Clicking opens a study tool that tracks what you know vs. don't.
- Study tool checks Canvas modules for study guides and surfaces them.
- **Default study time budget:** 1–2 hours allocated per test, 30 minutes per quiz (adjustable).
- **Study timer:** dedicated timer for study sessions, logs time against that test/quiz's budget.
- **Flashcards:** auto-generated from study guides/module content, spaced-repetition review (cards you know less move to shorter/faster review, hard cards repeat sooner).

## 6. Classes Page

- Card per class (same visual style).
- Click into a class → all assignment grades + total grade for that class.
- Bottom of page: overall GPA.

## 7. Email Viewer

- Pulls Canvas notification emails, reformats them into a clean, readable layout.

## 8. Weekly Workload View

- A view showing the whole week at a glance (all assignments/projects/tests across all days), not just today.

---

## 9. Data Model (rough)

- `settings` — canvas_api_token, canvas_base_url
- `classes` — id, name, canvas_class_id, weight
- `assignments` — id, class_id, title, description, files, type (regular/project), points, due_date, status, time_logged
- `project_chunks` — id, assignment_id, day, chunk_description, done
- `tests` — id, class_id, name, type (test/quiz), study_guide_url, mastery_pct, time_budget_minutes, time_logged
- `flashcards` — id, test_id, front, back, confidence_level, next_review_date
- `grades` — id, assignment_id, points_earned, points_possible

---

## 10. Build Order (suggested)

1. Local DB schema + installer scaffold
2. Canvas API sync (read-only pull, no write-back yet)
3. Assignment name/description cleanup + categorization
4. Daily dashboard + mark-complete + grade-impact sort + focus timer
5. Weekly workload view
6. Classes/grades/GPA page
7. Projects dashboard + pacing logic
8. Tests dashboard + study timer + flashcards
9. Email viewer

---

## Before Starting the Build

Do these in order, before writing any code:

1. Read this whole spec file.
2. Check the branding folder in this same directory for: color hex codes, logo files, and the app name. Use these throughout the build (UI colors, logo placement, app name in titles/installer/etc.).
3. Run the skill called "working with will."
4. Then start the build, following the Build Order below and the build/test loop described in "Notes for Claude Code."

**Priority: simplicity.** The dashboard and every page should be dead simple to navigate — minimal clicks, clear layout, no clutter. This matters more than adding extra visual flair.

## Notes for Claude Code

- Ask the user for a Canvas API token and base institution URL before wiring up sync.
- **Store the token in a local `.env` file (not committed to git, not hardcoded in source).** Read it via environment variable at runtime.
- Keep the "simplify description" and "categorize regular vs project" steps as an LLM call (Claude API) per assignment.
- No auto-submission to Canvas anywhere in this build.
- **Build + test loop:** build each feature, then test it, fix issues, and move to the next — don't move on until a feature actually works.
- **School hasn't started yet:** real Canvas data isn't available. Look up what Canvas API responses normally look like (assignment objects, class objects, grade objects, module/study guide objects, etc.) and build a **mock/fake Canvas API** that returns data shaped the same way, so the app can be fully built and tested now.
- **Seed fake test data:** populate the mock API with sample classes, assignments, projects, tests/quizzes, and grades so every feature (dashboard, projects, tests, grades/GPA, flashcards, etc.) has something to display and test against.
- **When everything is built and tested,** tell the user: "The build is done — I can run the program with some sample assignments, projects, and grades for you to test whenever you're ready." Don't say the build is finished unless every feature has actually been built and tested.
