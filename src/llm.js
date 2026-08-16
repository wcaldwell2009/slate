'use strict';

// Assignment cleanup + understanding.
//
// Two jobs from the spec:
//   1. Name cleanup: strip dates, "HW", "CW", etc. so the title is just the
//      actual subject.
//   2. Categorize (regular vs project) + simplify the description into a final
//      deliverable + a list of steps.
//
// By default this uses fast local rules so the app works with NO external API.
// If ANTHROPIC_API_KEY is set, understand() upgrades to a real Claude call for
// better categorization/summaries. Never auto-writes or submits anything.

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|ol|ul)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---- 1. Name cleanup -----------------------------------------------------
function cleanTitle(raw) {
  if (!raw) return '';
  let t = raw;
  // Drop leading tags like "PROJECT:", "HW:", "CW/HW:", "Tarea:", "Delta Math:"
  t = t.replace(/^\s*(project|hw|cw|cw\/hw|hw\/cw|homework|classwork|tarea|delta\s*math|assignment)\s*[:\-–]\s*/i, '');
  // Remove "(due 7/19)" / "due 7/19" / bare dates
  t = t.replace(/\(?\s*due[:\s]*\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*\)?/gi, '');
  t = t.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, '');
  // Remove standalone HW/CW tokens anywhere
  t = t.replace(/\b(hw|cw|homework|classwork)\b[:\s]*/gi, '');
  // Remove page/problem refs like "(p. 212 #1-25 odd)" or "#1-25 odd"
  t = t.replace(/\(?\s*p\.?\s*\d+[^)]*\)?/gi, '');
  t = t.replace(/#\s*\d+\s*[-–]\s*\d+(\s*(odd|even))?/gi, '');
  // Collapse leftover separators and whitespace
  t = t.replace(/\s{2,}/g, ' ').replace(/\s*[:\-–]\s*$/,'').replace(/^\s*[:\-–]\s*/,'').trim();
  // Fallback: if we stripped it to nothing, keep original trimmed
  return t || raw.trim();
}

// ---- 2. Categorize + simplify (local rules) ------------------------------
const PROJECT_WORDS = /\b(project|essay|poster|slideshow|slide\s*show|presentation|portfolio|research paper|report|model)\b/i;

// Plenty of teachers post an exam as a normal Canvas assignment rather than a
// Canvas quiz. Those belong on Tests & Quizzes with flashcards and a study
// timer, not on Projects — and they used to land on Projects purely because
// they were worth 50+ points.
const EXAM_WORDS = /\b(exam|midterm|mid-term|final(s)?\s+(exam|test)|test|quiz|quizz?es|assessment|benchmark)\b/i;
// ...unless the title is really about preparing for one.
const ABOUT_AN_EXAM = /\b(study\s+guide|review\s+(sheet|packet|guide)|prep|practice|corrections|retake\s+form)\b/i;

// 'test' | 'quiz' | null. Quizzes are the small ones; exams and midterms are
// tests whatever they are worth.
function assessmentKind(assignment) {
  const name = assignment.raw_title || assignment.name || assignment.title || '';
  const points = Number(assignment.points || assignment.points_possible || 0);
  if (!EXAM_WORDS.test(name)) return null;
  if (ABOUT_AN_EXAM.test(name)) return null;
  if (/\bquiz(z?es)?\b/i.test(name) && !/\b(exam|midterm|final)\b/i.test(name)) return 'quiz';
  if (/\b(exam|midterm|mid-term|final)\b/i.test(name)) return 'test';
  return points >= 50 ? 'test' : 'quiz';
}

function categorizeLocal(assignment) {
  const name = assignment.raw_title || assignment.name || '';
  const desc = assignment.raw_description || assignment.description || '';
  const points = Number(assignment.points || assignment.points_possible || 0);
  if (/^\s*project\b/i.test(name)) return 'project';
  if (PROJECT_WORDS.test(name)) return 'project';
  if (points >= 50) return 'project';
  // Multi-step description with an ordered list is usually a project.
  const listItems = (desc.match(/<li/gi) || []).length;
  if (listItems >= 3 && points >= 30) return 'project';
  return 'regular';
}

function simplifyLocal(assignment) {
  const desc = assignment.raw_description || assignment.description || '';
  const clean = stripHtml(desc);
  // Steps = list items if present, else sentence-ish splits after the first.
  let steps = [];
  const liMatches = desc.match(/<li[^>]*>(.*?)<\/li>/gis);
  if (liMatches && liMatches.length) {
    steps = liMatches.map((li) => stripHtml(li).replace(/^•\s*/, '').trim()).filter(Boolean);
  }
  // Final deliverable = first sentence of the cleaned description.
  const firstSentence = (clean.split(/(?<=[.!?])\s/)[0] || clean).replace(/^•\s*/, '').trim();
  return {
    final_deliverable: firstSentence || 'Complete this assignment.',
    steps,
  };
}

// ---- Work mode: type answers in the app vs. follow-a-guide ---------------
// 'text'  -> written work (Canvas text box, or an uploaded doc that is writing):
//            show an editor so the student types their answer in Slate.
// 'guide' -> everything else (worksheets, photos, posters, recordings, paper,
//            external tools): show simplified instructions + a step-by-step guide.
const WRITE_WORDS = /\b(write|essay|paragraph|report|respond|response|summar|reflect|reflection|journal)\b/i;
const NON_TEXT_WORDS = /\b(worksheet|poster|photo|photograph|picture|draw|drawing|diagram|record|recording|video|label|build|model|slideshow|slides|presentation)\b/i;

function workMode(assignment) {
  const st = assignment.submission_types || [];
  if (st.includes('online_text_entry')) return 'text';
  const blob = `${assignment.raw_title || assignment.name || ''} ${stripHtml(assignment.raw_description || assignment.description || '')}`;
  if (st.includes('online_upload') && WRITE_WORDS.test(blob) && !NON_TEXT_WORDS.test(blob)) return 'text';
  return 'guide';
}

// What kind of builder does this project need?
//   'slides' -> the slideshow builder (PowerPoint out)
//   'essay'  -> the essay editor (writing surface + Get Unstuck coach)
//   'none'   -> just the pacing/chunk view
// Checks title, description, and any attached file names for cues.
const SLIDE_WORDS = /\b(powerpoint|power\s*point|ppt|slideshow|slide\s*show|slide\s*deck|slide\s*s?|google\s*slides|presentation)\b/i;
const ESSAY_WORDS = /\b(essay|thesis|argumentative|persuasive|expository|research\s*paper|term\s*paper|lab\s*report|book\s*report|paragraphs?)\b/i;
function buildMode(assignment) {
  const files = (assignment.attachments || []).map((f) => f.display_name || f.filename || '').join(' ');
  const blob = `${assignment.raw_title || assignment.name || ''} ${stripHtml(assignment.raw_description || assignment.description || '')} ${files}`;
  if (/\.pptx?\b/i.test(files)) return 'slides';
  // A poster/flyer/drawing/video is a different deliverable even if it mentions
  // "present" — don't treat those as slideshows.
  if (/\b(poster|flyer|infographic|drawing|painting|video|brochure)\b/i.test(blob)) return 'none';
  if (SLIDE_WORDS.test(blob)) return 'slides';
  if (ESSAY_WORDS.test(blob)) return 'essay';
  return 'none';
}

// ---- Optional Claude upgrade --------------------------------------------
function hasClaude() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function understandWithClaude(assignment) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const raw = stripHtml(assignment.raw_description || assignment.description || '');
  const prompt =
    `You clean up a school assignment. Return ONLY JSON with keys ` +
    `"clean_title" (string, the subject with dates/HW/CW removed), ` +
    `"type" ("regular" or "project"), ` +
    `"final_deliverable" (one short sentence: what to hand in), ` +
    `"steps" (array of short step strings).\n\n` +
    `Title: ${assignment.raw_title || assignment.name}\n` +
    `Points: ${assignment.points || assignment.points_possible || 0}\n` +
    `Description: ${raw}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '{}';
  const jsonStr = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(jsonStr);
}

// Main entry: returns { title, type, final_deliverable, steps }.
async function understand(assignment) {
  const localTitle = cleanTitle(assignment.raw_title || assignment.name || '');
  if (hasClaude()) {
    try {
      const c = await understandWithClaude(assignment);
      return {
        title: (c.clean_title || localTitle).trim(),
        type: c.type === 'project' ? 'project' : 'regular',
        final_deliverable: c.final_deliverable || simplifyLocal(assignment).final_deliverable,
        steps: Array.isArray(c.steps) ? c.steps : simplifyLocal(assignment).steps,
      };
    } catch (err) {
      // Fall through to local rules if the API call fails for any reason.
      console.warn('[llm] Claude call failed, using local rules:', err.message);
    }
  }
  const simple = simplifyLocal(assignment);
  return {
    title: localTitle,
    type: categorizeLocal(assignment),
    final_deliverable: simple.final_deliverable,
    steps: simple.steps,
  };
}

module.exports = { cleanTitle, categorizeLocal, simplifyLocal, understand, stripHtml, hasClaude, workMode, buildMode, assessmentKind };
