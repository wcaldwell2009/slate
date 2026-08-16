'use strict';

// All date-only handling uses LOCAL calendar dates, not UTC. Using
// toISOString() would shift the day across the UTC boundary (e.g. 11:59pm
// local becomes the next day in UTC), which would make "due today" wrong.

function ymd(date = new Date()) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayYmd() {
  return ymd(new Date());
}

// Which day you actually have to DO something on.
//
// Anything due before noon is really the night-before's job — an essay due at
// 8am Friday has to be finished on Thursday, so that is the day Slate puts it
// on. Only shifts when Canvas gave a real time of day; a date with no time
// stays where it is.
function workDayFor(dueAt, beforeHour = 12) {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  const day = ymd(d);
  return d.getHours() < beforeHour ? addDaysYmd(day, -1) : day;
}

// True when the above moved it. A thing due Friday showing up on Thursday looks
// like a bug unless the page says why, so this drives that label — and it has to
// agree with workDayFor exactly, or the explanation won't match the behaviour.
function isEarlyMorning(dueAt, beforeHour = 12) {
  if (!dueAt) return false;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.getHours() < beforeHour;
}

// "8:00 AM", for showing the real deadline next to the shifted day.
function timeLabel(dueAt) {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Add days to a YYYY-MM-DD string, returning a YYYY-MM-DD string (local).
function addDaysYmd(ymdStr, days) {
  const d = new Date(ymdStr + 'T12:00:00'); // noon avoids DST edge shifts
  d.setDate(d.getDate() + days);
  return ymd(d);
}

// Whole days between two YYYY-MM-DD strings (local).
function daysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(fromYmd + 'T12:00:00');
  const b = new Date(toYmd + 'T12:00:00');
  return Math.round((b - a) / 86400000);
}

module.exports = { ymd, todayYmd, addDaysYmd, daysBetweenYmd, workDayFor, isEarlyMorning, timeLabel };
