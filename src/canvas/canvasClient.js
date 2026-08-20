'use strict';

// Chooses between the mock Canvas API and a real Canvas REST client.
//
// Mode is decided by env + settings:
//   CANVAS_MODE=mock  -> always mock
//   CANVAS_MODE=real  -> always real (needs base url + token)
//   CANVAS_MODE=auto  -> real if a token is configured, else mock (default)

const mock = require('./mockCanvas');

function getConfig() {
  // settings table wins over env, but env is a fine fallback for first run.
  let dbToken = null;
  let dbUrl = null;
  try {
    const { getSetting } = require('../db');
    dbToken = getSetting('canvas_api_token');
    dbUrl = getSetting('canvas_base_url');
  } catch {
    /* db not ready yet */
  }
  const token = dbToken || process.env.CANVAS_API_TOKEN || '';
  const baseUrl = (dbUrl || process.env.CANVAS_BASE_URL || '').replace(/\/+$/, '');
  const mode = (process.env.CANVAS_MODE || 'auto').toLowerCase();
  return { token, baseUrl, mode };
}

// 'mock' | 'real' | 'none'.
//
// 'none' is the normal state before Canvas is connected, and it matters: Slate
// must sit empty rather than quietly filling itself with made-up classes. The
// mock is only ever used when something asks for it by name (the tests, the
// drive harness, `npm run seed`), never as a fallback.
function canvasMode() {
  const { token, baseUrl, mode } = getConfig();
  if (mode === 'mock') return 'mock';
  if (mode === 'real') return 'real';
  return token && baseUrl ? 'real' : 'none'; // auto
}

function useMock() {
  return canvasMode() === 'mock';
}

function isConnected() {
  return canvasMode() !== 'none';
}

// ---- Real Canvas REST client --------------------------------------------
function realClient() {
  const { token, baseUrl } = getConfig();

  async function api(path, params = {}) {
    const url = new URL(baseUrl + '/api/v1' + path);
    for (const [k, v] of Object.entries(params)) {
      // Canvas wants repeated `name[]=` for list parameters. Passing one as a
      // plain `name=` is not merely ignored — /students/submissions answers
      // HTTP 500 to `student_ids=self`, which is what silently cost Will every
      // grade and every "Canvas has it" mark for his whole first week.
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(`${k}[]`, item));
      else url.searchParams.set(k, v);
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Canvas API ${res.status} on ${path}`);
    return res.json();
  }

  // The ONLY writing Slate ever does, and only when the student presses the
  // button on the preview screen. Everything else in this file is read-only.
  async function apiPost(path, form) {
    const res = await fetch(baseUrl + '/api/v1' + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* Canvas sometimes returns HTML on error */ }
    if (!res.ok) {
      const why = (data && (data.message || (data.errors && JSON.stringify(data.errors)))) || `HTTP ${res.status}`;
      const err = new Error(`Canvas refused the submission: ${why}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    isMock: false,
    async listCourses() {
      return api('/courses', { enrollment_state: 'active', per_page: 100 });
    },
    async listAssignments(courseId) {
      return api(`/courses/${courseId}/assignments`, { per_page: 100 });
    },
    async listQuizzes(courseId) {
      return api(`/courses/${courseId}/quizzes`, { per_page: 100 });
    },
    // One assignment, fresh. The chat pulls this at the start of a conversation
    // so it is answering about what Canvas says NOW, not what the last sync
    // happened to catch — a teacher who edits the instructions in the morning
    // would otherwise be invisible until the next hourly sync.
    async getAssignment(courseId, assignmentId) {
      return api(`/courses/${courseId}/assignments/${assignmentId}`);
    },
    async listSubmissions(courseId) {
      return api(`/courses/${courseId}/students/submissions`, { student_ids: ['self'], per_page: 100 });
    },
    async listPastAssignments() {
      return []; // real grades come from submissions + assignments already pulled
    },
    async getEnrollmentGrade(courseId) {
      const enrollments = await api(`/courses/${courseId}/enrollments`, { user_id: 'self' });
      const e = Array.isArray(enrollments) ? enrollments[0] : null;
      return e && e.grades ? e.grades : null;
    },
    // How the teacher has divided the class up — Will's school uses
    // "Formative" and "Summative" at 50-50. Assignments carry the group id.
    async listAssignmentGroups(courseId) {
      return api(`/courses/${courseId}/assignment_groups`, { per_page: 100 });
    },
    async listModules(courseId) {
      return api(`/courses/${courseId}/modules`, { per_page: 100 });
    },
    async listModuleItems(courseId, moduleId) {
      return api(`/courses/${courseId}/modules/${moduleId}/items`, { per_page: 100 });
    },
    async getFileText() {
      return ''; // module-item study guides; assignment attachments go via getFile
    },
    // One attached file. Canvas's own answer carries a fresh, pre-signed `url`
    // — the verifier baked into a description link expires, so always ask.
    async getFile(fileId) {
      return api(`/files/${fileId}`);
    },
    // The bytes of an attached file. Asks the API for a fresh download URL
    // first and only falls back to the link out of the description, which
    // carries a verifier that may well have expired.
    async downloadFile(file) {
      let url = file.url || null;
      if (file.file_id && /^\d+$/.test(String(file.file_id))) {
        try {
          const meta = await api(`/files/${file.file_id}`);
          if (meta && meta.url) url = meta.url;
        } catch { /* the description's link is the fallback */ }
      }
      if (!url) throw new Error('Canvas did not give a download link for that file');
      // A pre-signed Canvas URL carries its own credentials; an /api/v1/ one
      // still needs the token.
      const headers = url.includes('/api/v1/') ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(url, { headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`Canvas returned ${res.status} for that file`);
      return Buffer.from(await res.arrayBuffer());
    },

    // ---- submitting ------------------------------------------------------
    // What Canvas already has for this assignment, so the preview can say
    // "you already handed something in" before anything is sent.
    async getMySubmission(courseId, assignmentId) {
      try {
        const s = await api(`/courses/${courseId}/assignments/${assignmentId}/submissions/self`);
        return {
          submitted_at: s.submitted_at || null,
          attempt: s.attempt || 0,
          workflow_state: s.workflow_state || 'unsubmitted',
          late: !!s.late,
          score: s.score == null ? null : s.score,
        };
      } catch {
        return null; // not fatal — the preview just won't mention past attempts
      }
    },

    async submitText(courseId, assignmentId, body) {
      return apiPost(`/courses/${courseId}/assignments/${assignmentId}/submissions`, {
        'submission[submission_type]': 'online_text_entry',
        'submission[body]': String(body || ''),
      });
    },

    // Canvas file submission is three steps: ask for an upload slot, push the
    // bytes to wherever it points (usually S3), then hand the returned file id
    // to the submissions endpoint.
    async submitFile(courseId, assignmentId, filename, bytes, contentType) {
      const slot = await apiPost(
        `/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
        { name: filename, size: String(bytes.length), content_type: contentType || 'application/octet-stream' }
      );
      if (!slot || !slot.upload_url) throw new Error('Canvas did not offer somewhere to put the file');

      const form = new FormData();
      for (const [k, v] of Object.entries(slot.upload_params || {})) form.append(k, String(v));
      form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename);

      const up = await fetch(slot.upload_url, { method: 'POST', body: form, redirect: 'follow' });
      if (!up.ok) throw new Error(`The file upload failed (HTTP ${up.status})`);
      let uploaded = null;
      try { uploaded = JSON.parse(await up.text()); } catch { /* some hosts 201 with no body */ }
      const fileId = (uploaded && uploaded.id) || slot.id;
      if (!fileId) throw new Error('Canvas took the file but did not say which one it was');

      return apiPost(`/courses/${courseId}/assignments/${assignmentId}/submissions`, {
        'submission[submission_type]': 'online_upload',
        'submission[file_ids][]': String(fileId),
      });
    },
    async listNotifications() {
      const convos = await api('/conversations', { per_page: 50 });
      return (convos || []).map((c) => ({
        id: String(c.id),
        subject: c.subject,
        from_name: c.participants && c.participants[0] ? c.participants[0].name : 'Canvas',
        received: c.last_message_at,
        body: c.last_message,
      }));
    },
    // The list above only carries a preview. Opening a message fetches the
    // conversation itself, which is where the full text and any attachments
    // live. Done on demand rather than for all 50 during sync.
    async getConversation(id) {
      const c = await api(`/conversations/${id}`);
      const messages = Array.isArray(c && c.messages) ? c.messages : [];
      const body = messages.map((m) => m.body || '').filter(Boolean).join('\n\n---\n\n')
        || (c && c.last_message) || '';
      const attachments = [];
      for (const m of messages) {
        for (const f of m.attachments || []) {
          attachments.push({
            display_name: f.display_name || f.filename || 'attachment',
            url: f.url,
            size: f.size || 0,
          });
        }
      }
      return { body, attachments };
    },
  };
}

function getClient() {
  return useMock() ? mock : realClient();
}

// Checks a base URL + token pair against Canvas before we save them, so a typo
// shows up as "that didn't work" on the API page instead of a sync that quietly
// returns nothing. Canvas answers /users/self for any valid token.
async function verifyCredentials(baseUrl, token) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return { ok: false, error: 'Add your school\'s Canvas web address.' };
  if (!/^https?:\/\//i.test(clean)) return { ok: false, error: 'The web address should start with https://' };
  if (!String(token || '').trim()) return { ok: false, error: 'Paste your Canvas access token.' };

  let res;
  try {
    res = await fetch(clean + '/api/v1/users/self', {
      headers: { Authorization: `Bearer ${String(token).trim()}` },
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      error: timedOut
        ? "Canvas didn't answer. Check the web address and that you're online."
        : "Couldn't reach that web address. Check it for typos.",
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Canvas rejected that token. Make a new one and paste it again.' };
  }
  if (!res.ok) return { ok: false, error: `Canvas answered with an error (${res.status}).` };

  let me;
  try { me = await res.json(); } catch { me = null; }
  if (!me || !me.id) return { ok: false, error: 'That address answered, but it does not look like Canvas.' };
  return { ok: true, name: me.name || me.short_name || 'your account', base_url: clean };
}

module.exports = { getClient, useMock, canvasMode, isConnected, verifyCredentials, getConfig };
