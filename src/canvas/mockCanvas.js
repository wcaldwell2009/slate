'use strict';

// Mock Canvas API. Returns objects shaped like the real Canvas LMS REST API
// (courses, assignments, quizzes, submissions, modules, module items,
// enrollments, notifications) so the whole app can be built and tested before
// school starts and before a real Canvas token exists.
//
// Real Canvas shapes referenced:
//   Course:      { id, name, course_code, enrollment_term_id }
//   Assignment:  { id, name, description(HTML), due_at, points_possible,
//                  submission_types[], html_url, is_quiz_assignment, course_id }
//   Quiz:        { id, title, quiz_type, due_at, points_possible }
//   Submission:  { assignment_id, score, grade, workflow_state }
//   Enrollment:  { grades: { current_score, current_grade } }
//   Module:      { id, name }
//   ModuleItem:  { id, title, type, html_url, url }
//   Conversation/Notification email: { id, subject, workflow_state, ... }

function iso(date) {
  return date.toISOString();
}
function dayOnly(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

// Anchor everything to "today" at 11:59pm for due times.
const NOW = new Date();
function dueAt(offsetDays, hour = 23, minute = 59) {
  const d = addDays(NOW, offsetDays);
  d.setHours(hour, minute, 0, 0);
  return iso(d);
}

// ---- Courses -------------------------------------------------------------
const COURSES = [
  { id: 101, name: 'English 11: American Literature', course_code: 'ENG11', enrollment_term_id: 1, weight: 1.0 },
  { id: 102, name: 'Algebra II Honors', course_code: 'MATH-A2H', enrollment_term_id: 1, weight: 1.25 },
  { id: 103, name: 'Biology', course_code: 'BIO', enrollment_term_id: 1, weight: 1.0 },
  { id: 104, name: 'U.S. History', course_code: 'USH', enrollment_term_id: 1, weight: 1.0 },
  { id: 105, name: 'Spanish III', course_code: 'SPAN3', enrollment_term_id: 1, weight: 0.75 },
];

// Per-course current grade (enrollment.grades)
const COURSE_GRADES = {
  101: { current_score: 91.4, current_grade: 'A-' },
  102: { current_score: 86.2, current_grade: 'B' },
  103: { current_score: 94.8, current_grade: 'A' },
  104: { current_score: 88.0, current_grade: 'B+' },
  105: { current_score: 97.1, current_grade: 'A' },
};

// ---- Assignments (regular + projects) ------------------------------------
// due_at offsets are days from today.
const ASSIGNMENTS = [
  // English
  {
    id: 5001, course_id: 101, name: 'Reading Response HW: The Great Gatsby Ch. 3 (due 7/19)',
    description: '<p>Write a one-paragraph response to Chapter 3. Focus on how Fitzgerald uses Gatsby\'s party to reveal social class. Submit on paper or here.</p>',
    due_at: dueAt(0), points_possible: 10, submission_types: ['online_text_entry'], is_quiz_assignment: false,
  },
  {
    id: 5002, course_id: 101, name: 'CW: Vocabulary Set 4 Quiz Prep',
    description: '<p>Review vocab words 31-40. Know definitions and be able to use each in a sentence.</p>',
    // Due first thing TOMORROW morning, which means it has to be done TODAY —
    // this is the fixture for the before-noon rule in dates.workDayFor.
    due_at: dueAt(1, 8, 0), points_possible: 5, submission_types: ['none'], is_quiz_assignment: false,
  },
  {
    id: 5003, course_id: 101, name: 'PROJECT: American Dream Essay (Final)',
    description: '<p>Write a 5-paragraph argumentative essay answering: Is the American Dream still achievable? Use at least 3 sources and cite them in MLA format.</p><ul><li>Thesis with a clear claim</li><li>Three body paragraphs, each with evidence</li><li>Works Cited page</li></ul>',
    due_at: dueAt(9), points_possible: 100, submission_types: ['online_upload'], is_quiz_assignment: false,
  },
  // Algebra II
  {
    id: 5101, course_id: 102, name: 'HW 4.2 - Solving Quadratics by Factoring (p. 212 #1-25 odd)',
    description: '<p>Complete problems 1-25 odd on page 212. Show all work. Due at start of class.</p>',
    due_at: dueAt(0), points_possible: 20, submission_types: ['on_paper'], is_quiz_assignment: false,
  },
  {
    id: 5102, course_id: 102, name: 'Delta Math: Completing the Square Practice',
    description: '<p>Finish the Completing the Square module on DeltaMath. Target 100%.</p>',
    due_at: dueAt(2), points_possible: 15, submission_types: ['external_tool'], is_quiz_assignment: false,
  },
  {
    id: 5103, course_id: 102, name: 'PROJECT: Parabola in Real Life Poster',
    description: '<p>Find a real-world parabola (bridge, fountain, etc.), model it with a quadratic equation, and present on a poster.</p><ol><li>Pick and photograph a real parabola</li><li>Find the equation that models it</li><li>Label vertex, axis of symmetry, and roots</li><li>Design the poster</li></ol>',
    due_at: dueAt(12), points_possible: 80, submission_types: ['online_upload'], is_quiz_assignment: false,
  },
  {
    // Never handed in and two days past its date: the fixture for work
    // carrying over instead of vanishing at midnight.
    id: 5105, course_id: 102, name: 'HW 4.1 - Graphing Parabolas',
    description: '<p>Complete the graphing worksheet from Friday.</p>',
    due_at: dueAt(-2), points_possible: 15, submission_types: ['on_paper'], is_quiz_assignment: false,
  },
  // An exam posted as an ordinary Canvas assignment rather than a Canvas quiz.
  // Worth 100 points, so before assessmentKind() existed it was classified as a
  // PROJECT and showed up on the Projects page. It belongs on Tests & Quizzes.
  {
    id: 5104, course_id: 102, name: 'Unit 2 Exam: Polynomials',
    description: '<p>In-class exam covering polynomial operations, factoring, and graphing. Bring a calculator.</p>',
    due_at: dueAt(8), points_possible: 100, submission_types: ['on_paper'], is_quiz_assignment: false,
  },
  // Biology
  {
    id: 5201, course_id: 103, name: 'Cell Organelle Worksheet HW',
    // Shaped like real Canvas: the attached file is a link INSIDE the
    // description, not an `attachments` field — the Assignment object has no
    // such field. See the note at the top of src/attachments.js.
    description: '<p>Label the organelles and describe the function of each. Worksheet attached.</p>'
      + '<p><a class="instructure_file_link instructure_scribd_file" title="organelle_worksheet.docx"'
      + ' href="https://mock.canvas/courses/103/files/9001?verifier=abc&amp;wrap=1"'
      + ' data-api-endpoint="https://mock.canvas/api/v1/courses/103/files/9001"'
      + ' data-api-returntype="File">organelle_worksheet.docx</a></p>',
    due_at: dueAt(0), points_possible: 12, submission_types: ['online_upload'], is_quiz_assignment: false,
  },
  {
    id: 5202, course_id: 103, name: 'Lab Report: Osmosis in Potato Cells',
    description: '<p>Write up the osmosis lab. Include hypothesis, data table, graph, and conclusion.</p>',
    due_at: dueAt(4), points_possible: 40, submission_types: ['online_upload'], is_quiz_assignment: false,
  },
  // US History
  {
    id: 5301, course_id: 104, name: 'CW/HW: Read Chapter 7 & Answer Questions 1-5',
    description: '<p>Read Chapter 7 (The Constitution) and answer questions 1-5 at the end.</p>',
    due_at: dueAt(1), points_possible: 15, submission_types: ['online_text_entry'], is_quiz_assignment: false,
  },
  {
    id: 5302, course_id: 104, name: 'PROJECT: Founding Document Analysis',
    description: '<p>Choose a founding document and analyze its impact. Create a slideshow.</p><ul><li>Summarize the document</li><li>Explain the historical context</li><li>Analyze its lasting impact</li><li>Build 6-8 slides</li></ul>',
    // Inside the 7-day window on purpose: the week only shows a project on the
    // day it is DUE, so something has to fall in range for that to be visible.
    due_at: dueAt(5), points_possible: 60, submission_types: ['online_upload'], is_quiz_assignment: false,
  },
  // Spanish
  {
    id: 5401, course_id: 105, name: 'Tarea: Preterite vs Imperfect Worksheet',
    description: '<p>Complete the preterite vs imperfect worksheet. Conjugate all verbs.</p>',
    due_at: dueAt(0), points_possible: 10, submission_types: ['online_upload'], is_quiz_assignment: false,
  },
  {
    id: 5402, course_id: 105, name: 'Speaking Practice HW: Record 1-min intro',
    description: '<p>Record a 1-minute spoken introduction about your daily routine using reflexive verbs.</p>',
    due_at: dueAt(3), points_possible: 10, submission_types: ['media_recording'], is_quiz_assignment: false,
  },
];

// ---- Quizzes / Tests -----------------------------------------------------
const QUIZZES = [
  { id: 6001, course_id: 101, title: 'Vocabulary Set 4 Quiz', quiz_type: 'assignment', due_at: dueAt(2), points_possible: 20 },
  { id: 6002, course_id: 102, title: 'Unit 4 Test: Quadratic Functions', quiz_type: 'assignment', due_at: dueAt(6), points_possible: 100 },
  { id: 6003, course_id: 103, title: 'Cells & Organelles Test', quiz_type: 'assignment', due_at: dueAt(5), points_possible: 100 },
  { id: 6004, course_id: 104, title: 'Constitution Quiz', quiz_type: 'assignment', due_at: dueAt(3), points_possible: 25 },
  // Deliberately far out, so the Tests page's time-frame windows are actually
  // different from each other in the fixture. Without something past a week,
  // "1 week" and "All" return the same list and a broken filter looks fine.
  { id: 6005, course_id: 101, title: 'Midterm Essay Exam', quiz_type: 'assignment', due_at: dueAt(20), points_possible: 100 },
];

// ---- Submissions (drives grades) -----------------------------------------
// Only some assignments are already graded.
const SUBMISSIONS = {
  101: [
    { assignment_id: 4901, score: 9, grade: '9', workflow_state: 'graded' },
    { assignment_id: 4902, score: 18, grade: '18', workflow_state: 'graded' },
  ],
  102: [
    { assignment_id: 4911, score: 17, grade: '17', workflow_state: 'graded' },
    { assignment_id: 4912, score: 13, grade: '13', workflow_state: 'graded' },
  ],
  103: [
    { assignment_id: 4921, score: 12, grade: '12', workflow_state: 'graded' },
  ],
  104: [
    { assignment_id: 4931, score: 14, grade: '14', workflow_state: 'graded' },
  ],
  105: [
    { assignment_id: 4941, score: 10, grade: '10', workflow_state: 'graded' },
  ],
};

// Past graded assignments (so the Classes/grades page has history).
const PAST_ASSIGNMENTS = [
  { id: 4901, course_id: 101, name: 'Gatsby Ch. 1-2 Reading Quiz', points_possible: 10, due_at: dueAt(-6) },
  { id: 4902, course_id: 101, name: 'Personal Narrative Essay', points_possible: 20, due_at: dueAt(-10) },
  { id: 4911, course_id: 102, name: 'HW 4.1 Intro to Quadratics', points_possible: 20, due_at: dueAt(-5) },
  { id: 4912, course_id: 102, name: 'Quiz 4.1 Factoring', points_possible: 15, due_at: dueAt(-8) },
  { id: 4921, course_id: 103, name: 'Microscope Lab', points_possible: 12, due_at: dueAt(-4) },
  { id: 4931, course_id: 104, name: 'Colonial America Map', points_possible: 15, due_at: dueAt(-7) },
  { id: 4941, course_id: 105, name: 'Vocab Unit 2 Quiz', points_possible: 10, due_at: dueAt(-6) },
];

// ---- Modules & study guides ---------------------------------------------
const MODULES = {
  102: [{ id: 7001, name: 'Unit 4: Quadratic Functions' }],
  103: [{ id: 7002, name: 'Unit: Cell Biology' }],
  104: [{ id: 7003, name: 'Unit 3: Founding the Nation' }],
  101: [{ id: 7004, name: 'Unit: The Jazz Age' }],
};
const MODULE_ITEMS = {
  7001: [
    { id: 8001, title: 'Study Guide - Unit 4 Test', type: 'File', html_url: 'https://mock.canvas/courses/102/files/8001', url: 'https://mock.canvas/files/8001', _content: STUDY_GUIDE_ALGEBRA() },
    { id: 8002, title: 'Notes: Vertex Form', type: 'Page', html_url: 'https://mock.canvas/courses/102/pages/vertex-form' },
  ],
  7002: [
    { id: 8003, title: 'Cells Test Study Guide', type: 'File', html_url: 'https://mock.canvas/courses/103/files/8003', url: 'https://mock.canvas/files/8003', _content: STUDY_GUIDE_BIO() },
  ],
  7003: [
    { id: 8004, title: 'Constitution Quiz Review Sheet', type: 'Page', html_url: 'https://mock.canvas/courses/104/pages/constitution-review', _content: STUDY_GUIDE_HISTORY() },
  ],
  7004: [
    { id: 8005, title: 'Vocabulary Set 4 List', type: 'Page', html_url: 'https://mock.canvas/courses/101/pages/vocab-4', _content: STUDY_GUIDE_VOCAB() },
  ],
};

function STUDY_GUIDE_ALGEBRA() {
  return [
    'Standard form of a quadratic: y = ax^2 + bx + c',
    'Vertex form: y = a(x - h)^2 + k, where (h, k) is the vertex',
    'The axis of symmetry is x = -b / (2a)',
    'The discriminant is b^2 - 4ac; it tells the number of real roots',
    'Factoring: find two numbers that multiply to ac and add to b',
    'The quadratic formula is x = (-b ± sqrt(b^2 - 4ac)) / (2a)',
    'Completing the square turns standard form into vertex form',
  ].join('\n');
}
function STUDY_GUIDE_BIO() {
  return [
    'The nucleus stores DNA and controls cell activities',
    'Mitochondria produce energy (ATP) through cellular respiration',
    'Ribosomes build proteins',
    'The cell membrane controls what enters and exits the cell',
    'Chloroplasts carry out photosynthesis in plant cells',
    'The endoplasmic reticulum transports materials through the cell',
    'Osmosis is the diffusion of water across a membrane',
  ].join('\n');
}
function STUDY_GUIDE_HISTORY() {
  return [
    'The Constitution was signed in 1787 in Philadelphia',
    'The three branches of government are legislative, executive, and judicial',
    'Checks and balances keep any one branch from gaining too much power',
    'The Bill of Rights is the first 10 amendments',
    'Federalism divides power between national and state governments',
    'The Great Compromise created a bicameral legislature',
  ].join('\n');
}
function STUDY_GUIDE_VOCAB() {
  return [
    'ostentatious - characterized by showy display; intended to attract notice',
    'gregarious - fond of company; sociable',
    'meticulous - showing great attention to detail; very careful',
    'ephemeral - lasting for a very short time',
    'ambivalent - having mixed feelings about something',
  ].join('\n');
}

// ---- Notification emails --------------------------------------------------
// `body` is the preview the list endpoint gives back; `body_full` and
// `attachments` are what a real Canvas conversation returns when you open it,
// which is what the email popup asks for.
const EMAILS = [
  {
    id: 'msg-1', subject: 'Assignment Graded: Personal Narrative Essay', from_name: 'Canvas',
    received: dueAt(-9), body: 'Your assignment "Personal Narrative Essay" in English 11 has been graded. Score: 18/20. Great voice — tighten your conclusion next time.',
    body_full: 'Your assignment "Personal Narrative Essay" in English 11 has been graded.\n\nScore: 18/20\n\nComments from Mr. Ortiz:\nGreat voice throughout, and the opening scene does a lot of work. Tighten your conclusion next time — you restate the thesis instead of landing the point. See the marked-up copy attached.\n\nYou can view the full submission and rubric in Canvas.',
    attachments: [{ display_name: 'Personal Narrative - marked up.pdf', url: 'https://example.instructure.com/files/9001/download', size: 184320 }],
  },
  {
    id: 'msg-2', subject: 'Reminder: Unit 4 Test is coming up', from_name: 'Ms. Rivera (Algebra II)',
    received: dueAt(-1), body: 'Reminder that the Unit 4 Test on Quadratic Functions is next week. The study guide is posted in the Unit 4 module. Bring a calculator.',
    body_full: 'Hi everyone,\n\nReminder that the Unit 4 Test on Quadratic Functions is next week. The study guide is posted in the Unit 4 module and I have attached it here too.\n\nIt covers: vertex form, factoring, the quadratic formula, and word problems. Roughly 30 questions, and you get the whole period.\n\nBring a calculator. No notes.\n\n- Ms. Rivera',
    attachments: [
      { display_name: 'Unit 4 Study Guide.pdf', url: 'https://example.instructure.com/files/9002/download', size: 245760 },
      { display_name: 'formula-sheet.png', url: 'https://example.instructure.com/files/9003/download', size: 51200 },
    ],
  },
  {
    id: 'msg-3', subject: 'New Assignment: Lab Report: Osmosis in Potato Cells', from_name: 'Canvas',
    received: dueAt(-2), body: 'A new assignment "Lab Report: Osmosis in Potato Cells" has been posted in Biology. Due in 4 days. 40 points.',
    body_full: 'A new assignment "Lab Report: Osmosis in Potato Cells" has been posted in Biology.\n\nDue in 4 days. 40 points.\n\nWrite up the potato osmosis lab using the standard format: hypothesis, materials, procedure, results table, and conclusion. Your results table should include the mass before and after for all five concentrations.',
    attachments: [],
  },
];

// ---- API surface (mirrors the real client methods) -----------------------
async function listCourses() {
  return COURSES.map((c) => ({ ...c }));
}
// Mirrors the real client so the fresh-pull path is exercised by the harness
// rather than only ever running against Will's live Canvas.
async function getAssignment(courseId, assignmentId) {
  // The fixture keys courses by NUMBER, and Slate stores canvas_class_id as
  // TEXT — so a strict filter inside listAssignments matches nothing when the
  // id arrives straight out of the database. Real Canvas takes either in a URL
  // and never notices; only the mock is fussy, so it is coerced here.
  // Through module.exports, not the local binding: tests stub the mock by
  // reassigning mock.listAssignments, and a direct call would walk straight
  // past the stub and answer from the untouched fixture.
  const all = await module.exports.listAssignments(Number(courseId) || courseId);
  return all.find((x) => String(x.id) === String(assignmentId)) || null;
}
async function listAssignments(courseId) {
  // Real Canvas assignments carry an assignment_group_id. The fixture doesn't
  // spell one out per assignment — big work goes in Summative, everything else
  // in Formative, which is how the real classes are actually laid out.
  const groups = ASSIGNMENT_GROUPS[courseId] || [];
  const formative = groups.find((g) => /formative/i.test(g.name)) || groups[0];
  const summative = groups.find((g) => /summative/i.test(g.name)) || groups[0];
  return ASSIGNMENTS.filter((a) => a.course_id === courseId).map((a) => {
    const home = (a.points_possible || 0) >= 50 ? summative : formative;
    return { ...a, assignment_group_id: a.assignment_group_id || (home ? home.id : null) };
  });
}
async function listQuizzes(courseId) {
  return QUIZZES.filter((q) => q.course_id === courseId).map((q) => ({ ...q }));
}
async function listSubmissions(courseId) {
  return (SUBMISSIONS[courseId] || []).map((s) => ({ ...s }));
}
async function listPastAssignments(courseId) {
  // Already-graded work carries a group id like anything else. A quiz or an
  // essay is summative; day-to-day work is formative.
  const groups = ASSIGNMENT_GROUPS[courseId] || [];
  const formative = groups.find((g) => /formative/i.test(g.name)) || groups[0];
  const summative = groups.find((g) => /summative/i.test(g.name)) || groups[0];
  return PAST_ASSIGNMENTS.filter((a) => a.course_id === courseId).map((a) => {
    const home = /quiz|test|exam|essay/i.test(a.name) ? summative : formative;
    return { ...a, assignment_group_id: a.assignment_group_id || (home ? home.id : null) };
  });
}
async function getEnrollmentGrade(courseId) {
  return COURSE_GRADES[courseId] || null;
}
// Shaped like Will's real school: Formative and Summative at 50-50.
const ASSIGNMENT_GROUPS = {
  101: [{ id: 1011, name: 'Formative', group_weight: 50 }, { id: 1012, name: 'Summative', group_weight: 50 }],
  102: [{ id: 1021, name: 'Formative', group_weight: 50 }, { id: 1022, name: 'Summative', group_weight: 50 }],
  103: [{ id: 1031, name: 'Formative', group_weight: 50 }, { id: 1032, name: 'Summative', group_weight: 50 }],
  104: [{ id: 1041, name: 'Formative', group_weight: 50 }, { id: 1042, name: 'Summative', group_weight: 50 }],
  // One class left on plain Canvas defaults, so the "no formative/summative
  // split" path is exercised too.
  105: [{ id: 1051, name: 'Assignments', group_weight: 0 }],
};

async function listAssignmentGroups(courseId) {
  return (ASSIGNMENT_GROUPS[courseId] || []).map((g) => ({ ...g }));
}

async function listModules(courseId) {
  return (MODULES[courseId] || []).map((m) => ({ ...m }));
}
async function listModuleItems(courseId, moduleId) {
  return (MODULE_ITEMS[moduleId] || []).map((i) => ({ ...i }));
}
async function getFileText(item) {
  // In real Canvas we'd download and parse. Mock returns embedded content.
  return item._content || '';
}

// What a teacher put inside the attached worksheet. Deliberately says something
// the description does NOT, so a test can prove the Instructions box was built
// from the file and not just the description box.
const FILE_CONTENTS = {
  9001: [
    'Cell Organelle Worksheet',
    'Label all eight organelles on the diagram on page 2.',
    'For each one, write one sentence on what it does for the cell.',
    'Answer the three questions at the bottom in complete sentences.',
    'Hand in on paper at the start of class. Use pencil, not pen.',
  ].join('\n'),
};

// The bytes of an attached file, as a REAL .docx — the same zip an Office
// program would write — so the by-hand zip reader is exercised for real
// instead of against a convenient fake.
async function downloadFile(file) {
  const text = FILE_CONTENTS[Number(file.file_id)] || 'Attached file.';
  const { makeZip } = require('../officegen');
  const paras = text.split('\n')
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'word/document.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + `<w:body>${paras}</w:body></w:document>`,
    },
  ]);
}

async function getFile(fileId) {
  return { id: Number(fileId), display_name: `file-${fileId}.docx`, url: `https://mock.canvas/files/${fileId}`, size: 2048 };
}
async function listNotifications() {
  // The list endpoint gives previews only — same as real Canvas.
  return EMAILS.map(({ body_full, attachments, ...e }) => ({ ...e }));
}

// ---- submitting (mock) ---------------------------------------------------
// Records what WOULD have been sent so the tests can check it, and never talks
// to anything. `submitted` is readable by the harness.
const submitted = [];

async function getMySubmission(courseId, assignmentId) {
  const prior = submitted.filter((s) => String(s.assignmentId) === String(assignmentId));
  if (!prior.length) return { submitted_at: null, attempt: 0, workflow_state: 'unsubmitted', late: false, score: null };
  return {
    submitted_at: prior[prior.length - 1].at,
    attempt: prior.length,
    workflow_state: 'submitted',
    late: false,
    score: null,
  };
}

async function submitText(courseId, assignmentId, body) {
  if (!String(body || '').trim()) throw new Error('Canvas refused the submission: body is required');
  const rec = { kind: 'text', courseId, assignmentId, body, at: new Date().toISOString() };
  submitted.push(rec);
  return { id: submitted.length, attempt: submitted.length, submitted_at: rec.at, workflow_state: 'submitted' };
}

async function submitFile(courseId, assignmentId, filename, bytes) {
  if (!bytes || !bytes.length) throw new Error('Canvas refused the submission: empty file');
  const rec = { kind: 'file', courseId, assignmentId, filename, size: bytes.length, at: new Date().toISOString() };
  submitted.push(rec);
  return { id: submitted.length, attempt: submitted.length, submitted_at: rec.at, workflow_state: 'submitted' };
}

// Opening one message: the whole body and its attachments.
async function getConversation(id) {
  const e = EMAILS.find((m) => String(m.id) === String(id));
  if (!e) throw new Error(`Canvas API 404 on /conversations/${id}`);
  return { body: e.body_full || e.body, attachments: (e.attachments || []).map((a) => ({ ...a })) };
}

module.exports = {
  isMock: true,
  listCourses,
  listAssignments,
  getAssignment,
  listQuizzes,
  listSubmissions,
  listPastAssignments,
  getEnrollmentGrade,
  listAssignmentGroups,
  listModules,
  listModuleItems,
  getFileText,
  getFile,
  downloadFile,
  listNotifications,
  getConversation,
  getMySubmission,
  submitText,
  submitFile,
  submitted,
};
