const { DateTime, IANAZone } = require('luxon');

// Kept separate from billing: corrections never recapture rates, families or cutoff.
class CorrectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) { throw new CorrectionError(code, message); }
function inconsistent() {
  fail('failed-precondition', 'Aftercare records are inconsistent. Ask a manager to review them.');
}

function timestampMillis(value) {
  const milliseconds = value instanceof Date ? value.getTime() : value?.toMillis?.();
  if (!Number.isFinite(milliseconds)) inconsistent();
  return milliseconds;
}

function sessionRevision(snapshot) {
  const time = snapshot.updateTime;
  if (!Number.isInteger(time?.seconds) || !Number.isInteger(time?.nanoseconds)) inconsistent();
  return `${time.seconds}:${String(time.nanoseconds).padStart(9, '0')}`;
}

function validateLocalInput(value, field) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    fail('invalid-argument', `${field} must be a valid HH:mm time.`);
  }
}

function resolveLocalTime(value, original, serviceDate, timezone, field) {
  validateLocalInput(value, field);
  if (original != null) {
    const local = DateTime.fromMillis(timestampMillis(original), { zone: timezone });
    // Return the original Timestamp object, including its sub-millisecond precision.
    if (local.toISODate() === serviceDate && local.toFormat('HH:mm') === value) return original;
  }
  const resolved = DateTime.fromISO(`${serviceDate}T${value}:00`, { zone: timezone });
  if (!resolved.isValid || resolved.toISODate() !== serviceDate || resolved.toFormat('HH:mm') !== value) {
    fail('invalid-argument', `${field} does not exist in the school timezone on this date.`);
  }
  if (resolved.getPossibleOffsets().length !== 1) {
    fail('invalid-argument', `${field} is ambiguous due to daylight saving time. Choose another time.`);
  }
  return resolved.toJSDate();
}

function intervalOf(session, serviceDate, timezone, nowMillis) {
  if (session.serviceDate !== serviceDate || !['open', 'closed'].includes(session.status)) inconsistent();
  const start = timestampMillis(session.clockInAt);
  const cutoff = timestampMillis(session.autoCloseAt);
  const end = session.clockOutAt == null ? null : timestampMillis(session.clockOutAt);
  if (DateTime.fromMillis(start, { zone: timezone }).toISODate() !== serviceDate ||
      start >= cutoff || start > nowMillis ||
      (session.status === 'open' ? end !== null : end === null)) inconsistent();
  if (end !== null && (end <= start || end > cutoff || end > nowMillis ||
      DateTime.fromMillis(end, { zone: timezone }).toISODate() !== serviceDate)) inconsistent();
  return { start, end: end ?? Infinity };
}

function requireNoOverlaps(intervals, existing = false) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].start < sorted[index - 1].end) {
      if (existing) inconsistent();
      fail('invalid-argument', 'This correction overlaps another visit. Touching endpoints are allowed.');
    }
  }
}

// Pure validation returns original Timestamp objects for unchanged displayed minutes.
function validateTodayCorrection({ session, sessions, attendance, studentId, sessionId,
  serviceDate, timezone, now, clockInLocal, clockOutLocal }) {
  if (!IANAZone.isValidZone(timezone)) inconsistent();
  const nowMillis = timestampMillis(now);
  if (session.studentId !== studentId) fail('permission-denied', 'Session does not belong to this student.');
  if (session.serviceDate !== serviceDate) fail('failed-precondition', 'Only today’s visits can be corrected. Reload today’s visits.');
  validateLocalInput(clockInLocal, 'IN');
  if (clockOutLocal !== null) validateLocalInput(clockOutLocal, 'OUT');
  if (session.status === 'closed' && clockOutLocal === null) {
    fail('invalid-argument', 'Closed visits cannot be reopened. Use Check in again.');
  }

  if (!sessions.some((peer) => peer.id === sessionId) ||
      sessions.some((peer) => peer.studentId !== studentId)) inconsistent();
  const originalIntervals = sessions.map((peer) => intervalOf(peer, serviceDate, timezone, nowMillis));
  requireNoOverlaps(originalIntervals, true);
  const originalOrder = sessions.map((peer, index) => ({ id: peer.id, ...originalIntervals[index] }))
    .sort((a, b) => a.start - b.start);
  const open = sessions.filter((peer) => peer.status === 'open');
  if (!attendance || attendance.studentId !== studentId || attendance.serviceDate !== serviceDate) inconsistent();
  if (open.length) {
    if (open.length !== 1 || attendance.status !== 'in' || attendance.openSessionId !== open[0].id) inconsistent();
  } else if (attendance.status !== 'out' || attendance.openSessionId ||
      attendance.lastSessionId !== originalOrder.at(-1).id) inconsistent();
  if (session.status === 'open' && attendance.openSessionId !== sessionId) inconsistent();

  const clockInAt = resolveLocalTime(clockInLocal, session.clockInAt, serviceDate, timezone, 'IN');
  const clockOutAt = clockOutLocal === null ? null
    : resolveLocalTime(clockOutLocal, session.clockOutAt, serviceDate, timezone, 'OUT');
  const start = timestampMillis(clockInAt);
  const end = clockOutAt === null ? null : timestampMillis(clockOutAt);
  const cutoff = timestampMillis(session.autoCloseAt);
  if (start > nowMillis || (end !== null && end > nowMillis)) {
    fail('invalid-argument', 'IN and OUT cannot be in the future.');
  }
  if (start >= cutoff || (end !== null && end > cutoff)) {
    fail('invalid-argument', 'IN must be before the stored cutoff; OUT cannot be after it.');
  }
  if (end !== null && end <= start) fail('invalid-argument', 'OUT must be strictly after IN.');
  const correctedOrder = originalOrder.map((interval) => interval.id === sessionId
    ? { id: sessionId, start, end: end ?? Infinity } : interval).sort((a, b) => a.start - b.start);
  requireNoOverlaps(correctedOrder);
  // Visit identity/order and the current open/latest pointer must remain stable.
  // Non-overlap alone allows moving an entire visit across another visit.
  if (correctedOrder.some((interval, index) => interval.id !== originalOrder[index].id)) {
    fail('invalid-argument', 'This correction changes visit order. Keep this visit between its original neighboring visits.');
  }
  return {
    clockInAt,
    clockOutAt,
    status: clockOutAt === null ? 'open' : 'closed',
    unchanged: clockInAt === session.clockInAt && clockOutAt === (session.clockOutAt ?? null),
    updatesLatest: attendance.openSessionId === sessionId ||
      (attendance.status === 'out' && attendance.lastSessionId === sessionId),
  };
}

// Dependency injection lets transaction/authorization behavior be tested without Admin SDK writes.
function createAftercareCorrectionHandlers({ db, Timestamp, HttpsError, assertAuthed, cleanDocId,
  aftercarePath, actorFrom, requireAftercareOperator, normalizeAftercareSettings, getServiceDay,
  ts, now = () => new Date() }) {
  const translateErrors = (handler) => async (req) => {
    try { return await handler(req); }
    catch (error) {
      if (error instanceof CorrectionError) throw new HttpsError(error.code, error.message);
      throw error;
    }
  };
  const scopeOf = async (req) => {
    assertAuthed(req);
    const orgId = cleanDocId(req.data?.orgId, 'orgId');
    const schoolId = cleanDocId(req.data?.schoolId, 'schoolId');
    const studentId = cleanDocId(req.data?.studentId, 'studentId');
    await requireAftercareOperator(req, orgId, schoolId);
    return { orgId, schoolId, studentId };
  };
  const dayQuery = (orgId, schoolId, serviceDate) => db.collection(
    `orgs/${orgId}/schools/${schoolId}/aftercareSessions`
  ).where('serviceDate', '==', serviceDate);
  const dayFrom = (settingsSnap, serverNow) => {
    const settings = normalizeAftercareSettings(settingsSnap.data() || {});
    return { ...getServiceDay(serverNow, settings.timezone, settings.cutoffLocalTime), timezone: settings.timezone };
  };
  const iso = (value) => value == null ? null : new Date(timestampMillis(value)).toISOString();
  const timeFields = (session) => ({
    clockInAt: session.clockInAt,
    clockOutAt: session.clockOutAt ?? null,
    status: session.status,
  });

  const getAftercareStudentTodaySessions = translateErrors(async (req) => {
    const { orgId, schoolId, studentId } = await scopeOf(req);
    return db.runTransaction(async (tx) => {
      const [settingsSnap, studentSnap] = await tx.getAll(
        aftercarePath(orgId, schoolId, 'settings', 'aftercare'),
        aftercarePath(orgId, schoolId, 'students', studentId)
      );
      if (!studentSnap.exists) throw new HttpsError('not-found', 'Student not found.');
      const serverNow = now();
      const { serviceDate, timezone } = dayFrom(settingsSnap, serverNow);
      const snapshot = await tx.get(dayQuery(orgId, schoolId, serviceDate));
      const sessions = snapshot.docs.filter((doc) => doc.get('studentId') === studentId).map((doc) => {
        const session = doc.data();
        if (!session.clockInAt) inconsistent();
        return {
          id: doc.id, studentId, serviceDate, status: session.status,
          clockInAt: iso(session.clockInAt), clockOutAt: iso(session.clockOutAt),
          autoCloseAt: iso(session.autoCloseAt), revision: sessionRevision(doc),
        };
      }).sort((a, b) => a.clockInAt.localeCompare(b.clockInAt) || a.id.localeCompare(b.id));
      if (dayFrom(settingsSnap, now()).serviceDate !== serviceDate) {
        fail('failed-precondition', 'The school date changed. Reload today’s visits.');
      }
      return { ok: true, serviceDate, timezone, serverNow: serverNow.toISOString(), sessions };
    });
  });

  const updateAftercareStudentTodaySession = translateErrors(async (req) => {
    const { orgId, schoolId, studentId } = await scopeOf(req);
    const sessionId = cleanDocId(req.data?.sessionId, 'sessionId');
    const { expectedRevision, expectedServiceDate, clockInLocal, clockOutLocal } = req.data;
    if (typeof expectedRevision !== 'string' || !expectedRevision ||
        typeof expectedServiceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expectedServiceDate)) {
      fail('invalid-argument', 'expectedRevision and expectedServiceDate are required. Reload today’s visits.');
    }
    const settingsRef = aftercarePath(orgId, schoolId, 'settings', 'aftercare');
    const sessionRef = aftercarePath(orgId, schoolId, 'aftercareSessions', sessionId);
    const attendanceRef = aftercarePath(orgId, schoolId, 'aftercareAttendance', studentId);
    return db.runTransaction(async (tx) => {
      const [settingsSnap, sessionSnap, attendanceSnap, studentSnap] = await tx.getAll(
        settingsRef, sessionRef, attendanceRef, aftercarePath(orgId, schoolId, 'students', studentId)
      );
      if (!studentSnap.exists) throw new HttpsError('not-found', 'Student not found.');
      if (!sessionSnap.exists) throw new HttpsError('not-found', 'Aftercare session not found.');
      const session = sessionSnap.data();
      if (session.studentId !== studentId) fail('permission-denied', 'Session does not belong to this student.');
      const { serviceDate, timezone } = dayFrom(settingsSnap, now());
      if (expectedServiceDate !== serviceDate || session.serviceDate !== serviceDate) {
        fail('failed-precondition', 'Only today’s visits can be corrected. Reload today’s visits.');
      }
      if (sessionRevision(sessionSnap) !== expectedRevision) {
        fail('aborted', 'This visit changed. Reload today’s visits before saving.');
      }
      const peerSnapshot = await tx.get(dayQuery(orgId, schoolId, serviceDate));
      const sessions = peerSnapshot.docs.filter((doc) => doc.get('studentId') === studentId)
        .map((doc) => ({ ...doc.data(), id: doc.id }));
      // Read the clock again after all reads (and on every transaction retry).
      const serverNow = now();
      if (dayFrom(settingsSnap, serverNow).serviceDate !== serviceDate) {
        fail('failed-precondition', 'The school date changed. Reload today’s visits.');
      }
      const result = validateTodayCorrection({ session, sessions, attendance: attendanceSnap.data(),
        studentId, sessionId, serviceDate, timezone, now: serverNow, clockInLocal, clockOutLocal });
      if (result.unchanged) return { ok: true, unchanged: true };

      const actor = actorFrom(req);
      const clockInAt = result.clockInAt instanceof Date ? Timestamp.fromDate(result.clockInAt) : result.clockInAt;
      const clockOutAt = result.clockOutAt instanceof Date ? Timestamp.fromDate(result.clockOutAt) : result.clockOutAt;
      const after = { clockInAt, clockOutAt, status: result.status };
      const correctionTime = ts();
      const patch = { ...after, correctedAt: correctionTime, correctedBy: actor, updatedAt: correctionTime };
      // Preserve all original opened/closed actors and close metadata on closed visits.
      if (session.status === 'open' && result.status === 'closed') {
        patch.closedAt = correctionTime;
        patch.closedBy = actor;
        patch.closeMethod = 'corrected';
      }
      tx.update(sessionRef, patch);
      const attendancePatch = { updatedAt: correctionTime };
      if (result.updatesLatest) {
        Object.assign(attendancePatch, { clockedInAt: clockInAt, clockedOutAt: clockOutAt, updatedBy: actor });
        if (result.status === 'closed') {
          Object.assign(attendancePatch, { status: 'out', openSessionId: null, lastSessionId: sessionId });
        }
      }
      // This shared lock serializes even earlier-visit edits against check-in/out and auto-close.
      tx.update(attendanceRef, attendancePatch);
      tx.create(sessionRef.collection('corrections').doc(), {
        studentId, sessionId, serviceDate, timezone, expectedRevision,
        before: timeFields(session), after,
        correctedAt: correctionTime, correctedBy: actor,
      });
      return { ok: true };
    });
  });
  return { getAftercareStudentTodaySessions, updateAftercareStudentTodaySession };
}

module.exports = { CorrectionError, sessionRevision, resolveLocalTime, validateTodayCorrection,
  createAftercareCorrectionHandlers };