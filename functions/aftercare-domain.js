const { DateTime, IANAZone } = require('luxon');

const HOUR_MS = 60 * 60 * 1000;

function validateTimezone(timezone) {
  if (!IANAZone.isValidZone(timezone)) {
    throw new Error('timezone must be a valid IANA timezone');
  }
  return timezone;
}

function parseCutoff(cutoffLocalTime) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(cutoffLocalTime || ''));
  if (!match) throw new Error('cutoffLocalTime must use HH:mm');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('cutoffLocalTime must be a valid time');
  return { hour, minute };
}

function getServiceDay(now, timezone, cutoffLocalTime) {
  validateTimezone(timezone);
  const { hour, minute } = parseCutoff(cutoffLocalTime);
  const localNow = DateTime.fromJSDate(now, { zone: timezone });
  if (!localNow.isValid) throw new Error('now must be a valid Date');

  const cutoff = DateTime.fromObject({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
    hour,
    minute,
  }, { zone: timezone });

  if (!cutoff.isValid) throw new Error('Could not resolve the local cutoff time');
  return {
    serviceDate: localNow.toISODate(),
    billingMonth: localNow.toFormat('yyyy-MM'),
    cutoffAt: cutoff.toJSDate(),
    isAfterCutoff: localNow.toMillis() >= cutoff.toMillis(),
  };
}

function asMillis(value, fieldName) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  throw new Error(`${fieldName} must be a timestamp`);
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}

function calculateFamilyDay(sessions, rates) {
  const singleRateCents = Number(rates?.singleRateCents);
  const familyRateCents = Number(rates?.familyRateCents);
  if (!Number.isInteger(singleRateCents) || singleRateCents < 0 ||
      !Number.isInteger(familyRateCents) || familyRateCents < 0) {
    throw new Error('rates must be nonnegative integer cents');
  }

  const eventsByTime = new Map();
  const intervalsByStudent = new Map();
  for (const session of sessions || []) {
    const studentId = String(session.studentId || '').trim();
    if (!studentId) throw new Error('studentId is required');
    const start = asMillis(session.clockInAt, 'clockInAt');
    const end = asMillis(session.clockOutAt, 'clockOutAt');
    if (end <= start) continue;

    const intervals = intervalsByStudent.get(studentId) || [];
    intervals.push({ start, end });
    intervalsByStudent.set(studentId, intervals);
  }

  const studentMilliseconds = {};
  for (const [studentId, intervals] of intervalsByStudent) {
    const merged = mergeIntervals(intervals);
    studentMilliseconds[studentId] = merged.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    for (const interval of merged) {
      const starts = eventsByTime.get(interval.start) || { start: [], end: [] };
      starts.start.push(studentId);
      eventsByTime.set(interval.start, starts);
      const ends = eventsByTime.get(interval.end) || { start: [], end: [] };
      ends.end.push(studentId);
      eventsByTime.set(interval.end, ends);
    }
  }

  const activeStudents = new Set();
  const times = Array.from(eventsByTime.keys()).sort((left, right) => left - right);
  let previousTime = null;
  let singleMilliseconds = 0;
  let familyMilliseconds = 0;

  for (const time of times) {
    if (previousTime !== null && activeStudents.size > 0) {
      const elapsed = time - previousTime;
      if (activeStudents.size === 1) singleMilliseconds += elapsed;
      else familyMilliseconds += elapsed;
    }
    const events = eventsByTime.get(time);
    for (const studentId of events.end) activeStudents.delete(studentId);
    for (const studentId of events.start) activeStudents.add(studentId);
    previousTime = time;
  }

  const singleAmountCents = Math.round(singleMilliseconds * singleRateCents / HOUR_MS);
  const familyAmountCents = Math.round(familyMilliseconds * familyRateCents / HOUR_MS);
  return {
    singleMilliseconds,
    familyMilliseconds,
    totalMilliseconds: singleMilliseconds + familyMilliseconds,
    singleAmountCents,
    familyAmountCents,
    totalAmountCents: singleAmountCents + familyAmountCents,
    studentMilliseconds,
  };
}

function decimalHours(milliseconds) {
  return Math.round((milliseconds / HOUR_MS) * 100) / 100;
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.round(milliseconds / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours} hr ${minutes} min`;
  if (hours) return `${hours} hr`;
  return `${minutes} min`;
}

module.exports = {
  calculateFamilyDay,
  decimalHours,
  formatDuration,
  getServiceDay,
  parseCutoff,
  validateTimezone,
};