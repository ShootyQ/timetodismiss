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
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return Date.parse(value);
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

function aggregateAftercareReport(sessions, families, defaultRates) {
  const familyById = new Map((families || []).map((family) => [family.id, family]));
  const currentFamilyByStudentId = new Map();
  const currentFamilyByStudentName = new Map();
  const currentFamilyByName = new Map();
  for (const family of families || []) {
    if (family.active === false) continue;
    currentFamilyByName.set(String(family.name || '').trim().toLowerCase(), family);
    const studentIds = family.studentIds || (family.students || []).map((student) => student.studentId || student.id);
    for (const studentId of studentIds) if (studentId) currentFamilyByStudentId.set(studentId, family);
    for (const student of family.students || []) {
      const studentName = String(student.name || student.studentName || '').trim().toLowerCase();
      if (studentName) currentFamilyByStudentName.set(studentName, family);
    }
  }
  const groups = new Map();
  const sessionRows = [];
  let openSessionCount = 0;
  let autoClosedCount = 0;

  for (const source of sessions || []) {
    const mappedFamily = source.currentFamilyId ? familyById.get(source.currentFamilyId) || { id: source.currentFamilyId, name: source.currentFamilyName || source.currentFamilyId, active: true, students: [] } : null;
    const currentFamily = !source.familyId ? mappedFamily || currentFamilyByStudentId.get(source.studentId) || currentFamilyByStudentName.get(String(source.studentName || '').trim().toLowerCase()) || currentFamilyByName.get(String(source.familyName || '').trim().toLowerCase()) : null;
    const familyId = source.familyId || currentFamily?.id || null;
    const accountType = familyId ? 'family' : 'student';
    const family = familyId ? familyById.get(familyId) : null;
    const familyKey = familyId || `student:${source.studentId}`;
    const familyName = source.familyName || currentFamily?.name || family?.name || source.studentName || source.studentId;
    const audit = {
      id: source.id,
      serviceDate: source.serviceDate,
      studentId: source.studentId,
      studentName: source.studentName || source.studentId,
      familyId,
      familyKey,
      familyName,
      accountType,
      assignmentSource: source.familyId ? 'historical' : currentFamily ? 'current-family-fallback' : 'individual',
      clockInAt: source.clockInAt ?? null,
      clockOutAt: source.clockOutAt ?? null,
      singleRateCents: Number(source.singleRateCents ?? defaultRates.singleRateCents),
      familyRateCents: Number(source.familyRateCents ?? defaultRates.familyRateCents),
      classId: source.classId || null,
      timezone: source.timezone || null,
      status: source.status || 'closed',
      closeMethod: source.closeMethod || null,
      closedAt: source.closedAt || null,
      included: false,
      exclusionReason: null,
    };

    if (source.status === 'open' || source.clockOutAt == null) {
      openSessionCount++;
      audit.exclusionReason = 'Open session';
      sessionRows.push(audit);
      continue;
    }

    let start;
    let end;
    try {
      start = asMillis(source.clockInAt, 'clockInAt');
      end = asMillis(source.clockOutAt, 'clockOutAt');
    } catch (_) {
      audit.exclusionReason = 'Invalid session time';
      sessionRows.push(audit);
      continue;
    }
    if (end <= start) {
      audit.exclusionReason = 'Clock-out must be after clock-in';
      sessionRows.push(audit);
      continue;
    }

    audit.included = true;
    audit.durationMilliseconds = end - start;
    audit.duration = formatDuration(end - start);
    sessionRows.push(audit);
    if (source.closeMethod === 'auto') autoClosedCount++;

    const key = `${source.serviceDate}|${familyKey}`;
    if (!groups.has(key)) groups.set(key, {
      serviceDate: source.serviceDate,
      familyId,
      familyKey,
      familyName,
      accountType,
      familyStatus: !familyId ? null : !family ? 'missing' : family.active === false ? 'archived' : 'active',
      assignmentSource: source.familyId ? 'historical' : currentFamily ? 'current-family-fallback' : 'individual',
      singleRateCents: audit.singleRateCents,
      familyRateCents: audit.familyRateCents,
      sessions: [],
      studentNames: {},
      sessionIds: [],
    });
    const group = groups.get(key);
    group.sessions.push(source);
    group.sessionIds.push(source.id);
    group.studentNames[source.studentId] = source.studentName || source.studentId;
  }

  const dayRows = Array.from(groups.values()).map((group) => {
    const calculation = calculateFamilyDay(group.sessions, group);
    const students = Object.entries(calculation.studentMilliseconds).map(([studentId, milliseconds]) => ({
      studentId,
      studentName: group.studentNames[studentId] || studentId,
      milliseconds,
      duration: formatDuration(milliseconds),
      decimalHours: decimalHours(milliseconds),
    })).sort((left, right) => left.studentName.localeCompare(right.studentName));
    return {
      serviceDate: group.serviceDate,
      familyId: group.familyId,
      familyKey: group.familyKey,
      familyName: group.familyName,
      accountType: group.accountType,
      familyStatus: group.familyStatus,
      assignmentSource: group.assignmentSource,
      singleRateCents: group.singleRateCents,
      familyRateCents: group.familyRateCents,
      singleMilliseconds: calculation.singleMilliseconds,
      singleDuration: formatDuration(calculation.singleMilliseconds),
      singleDecimalHours: decimalHours(calculation.singleMilliseconds),
      familyMilliseconds: calculation.familyMilliseconds,
      familyDuration: formatDuration(calculation.familyMilliseconds),
      familyDecimalHours: decimalHours(calculation.familyMilliseconds),
      totalAmountCents: calculation.totalAmountCents,
      singleAmountCents: calculation.singleAmountCents,
      familyAmountCents: calculation.familyAmountCents,
      students,
      billedStudents: students,
      sessionIds: group.sessionIds,
    };
  }).sort((left, right) => left.serviceDate.localeCompare(right.serviceDate) || left.familyName.localeCompare(right.familyName));

  const totals = new Map();
  for (const row of dayRows) {
    if (!totals.has(row.familyKey)) totals.set(row.familyKey, {
      familyId: row.familyId,
      familyKey: row.familyKey,
      familyName: row.familyName,
      accountType: row.accountType,
      familyStatus: row.familyStatus,
      assignmentSource: row.assignmentSource,
      singleMilliseconds: 0,
      familyMilliseconds: 0,
      singleAmountCents: 0,
      familyAmountCents: 0,
      totalAmountCents: 0,
      days: 0,
      studentsById: new Map(),
    });
    const total = totals.get(row.familyKey);
    total.singleMilliseconds += row.singleMilliseconds;
    total.familyMilliseconds += row.familyMilliseconds;
    total.singleAmountCents += row.singleAmountCents;
    total.familyAmountCents += row.familyAmountCents;
    total.totalAmountCents += row.totalAmountCents;
    total.days++;
    for (const student of row.students) {
      const existing = total.studentsById.get(student.studentId) || { ...student, milliseconds: 0, days: 0 };
      existing.milliseconds += student.milliseconds;
      existing.days++;
      total.studentsById.set(student.studentId, existing);
    }
  }

  const familyRows = Array.from(totals.values()).map(({ studentsById, ...row }) => {
    const billedStudents = Array.from(studentsById.values()).map((student) => ({
      ...student,
      duration: formatDuration(student.milliseconds),
      decimalHours: decimalHours(student.milliseconds),
    })).sort((left, right) => left.studentName.localeCompare(right.studentName));
    const configuredFamily = row.familyId ? familyById.get(row.familyId) : null;
    const configuredStudents = (configuredFamily?.students || []).map((student) => ({
      studentId: student.studentId,
      studentName: student.name || student.studentName || student.studentId,
    })).sort((left, right) => left.studentName.localeCompare(right.studentName));
    const exceptions = [];
    if (row.familyStatus === 'archived') exceptions.push('Historical family is archived');
    if (row.familyStatus === 'missing') exceptions.push('Historical family record is missing');
    return {
      ...row,
      students: billedStudents,
      billedStudents,
      configuredStudents,
      exceptions,
      singleDuration: formatDuration(row.singleMilliseconds),
      singleDecimalHours: decimalHours(row.singleMilliseconds),
      familyDuration: formatDuration(row.familyMilliseconds),
      familyDecimalHours: decimalHours(row.familyMilliseconds),
    };
  }).sort((left, right) => left.familyName.localeCompare(right.familyName));

  return {
    openSessionCount,
    autoClosedCount,
    exceptionCount: sessionRows.filter((row) => !row.included).length + familyRows.reduce((sum, row) => sum + row.exceptions.length, 0),
    sessionRows,
    dayRows,
    familyRows,
  };
}

module.exports = {
  aggregateAftercareReport,
  calculateFamilyDay,
  decimalHours,
  formatDuration,
  getServiceDay,
  parseCutoff,
  validateTimezone,
};