const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DateTime } = require('luxon');
const corrections = require('../aftercare-corrections');
const { validateTodayCorrection, sessionRevision, resolveLocalTime } = corrections;
const { calculateFamilyDay } = require('../aftercare-domain');

const serviceDate = '2026-09-10';
const timezone = 'America/Chicago';
const local = (time, date = serviceDate, zone = timezone) =>
  DateTime.fromISO(`${date}T${time}`, { zone }).toJSDate();
const codeIs = (code) => (error) => error.code === code;
const visit = (id = 'visit', extra = {}) => ({
  id, studentId: 'student', serviceDate, timezone, status: 'closed',
  clockInAt: local('14:00:37.123'), clockOutAt: local('15:00:42.456'),
  autoCloseAt: local('18:00'), ...extra,
});
function correctionInput(extra = {}) {
  const session = extra.session || visit();
  return {
    session, sessions: [session], studentId: 'student', sessionId: session.id,
    serviceDate, timezone, now: local('17:00'), clockInLocal: '14:00', clockOutLocal: '15:00',
    attendance: { studentId: 'student', serviceDate, status: 'out', openSessionId: null, lastSessionId: session.id },
    ...extra,
  };
}

test('revision uses seconds and all nine nanosecond digits, not milliseconds', () => {
  assert.equal(sessionRevision({ updateTime: { seconds: 123, nanoseconds: 1 } }), '123:000000001');
  assert.notEqual(sessionRevision({ updateTime: { seconds: 123, nanoseconds: 1 } }),
    sessionRevision({ updateTime: { seconds: 123, nanoseconds: 2 } }));
  assert.throws(() => sessionRevision({}), codeIs('failed-precondition'));
});

test('unchanged minutes are a no-op and preserve original timestamp objects and seconds', () => {
  const input = correctionInput();
  const result = validateTodayCorrection(input);
  assert.equal(result.unchanged, true);
  assert.equal(result.clockInAt, input.session.clockInAt);
  assert.equal(result.clockOutAt, input.session.clockOutAt);
  const precise = { toMillis: () => local('14:00:37.123').getTime(), seconds: 1, nanoseconds: 123456789 };
  assert.equal(resolveLocalTime('14:00', precise, serviceDate, timezone, 'IN'), precise);
});

test('only the changed minute loses seconds and both latest timestamps are available', () => {
  const input = correctionInput({ clockInLocal: '13:59' });
  const result = validateTodayCorrection(input);
  assert.equal(result.clockInAt.getTime(), local('13:59').getTime());
  assert.equal(result.clockOutAt, input.session.clockOutAt);
  assert.equal(result.unchanged, false);
  assert.equal(result.updatesLatest, true);
});

for (const value of ['', '9:00', '24:00', '12:60', ' 14:00', '14:00 ', '14:00:00', '2026-09-10T14:00', 1400, undefined]) {
  test(`strict HH:mm rejects ${JSON.stringify(value)} for IN and OUT`, () => {
    assert.throws(() => validateTodayCorrection(correctionInput({ clockInLocal: value })), codeIs('invalid-argument'));
    assert.throws(() => validateTodayCorrection(correctionInput({ clockOutLocal: value })), codeIs('invalid-argument'));
  });
}

for (const [label, times] of [
  ['future IN', { clockInLocal: '17:01' }],
  ['future OUT', { clockOutLocal: '17:01' }],
  ['equal duration', { clockInLocal: '14:30', clockOutLocal: '14:30' }],
  ['negative duration', { clockInLocal: '15:01' }],
  ['closed reopening', { clockOutLocal: null }],
  ['IN at cutoff', { now: local('19:00'), clockInLocal: '18:00', clockOutLocal: '18:01' }],
  ['OUT after cutoff', { now: local('19:00'), clockOutLocal: '18:01' }],
]) {
  test(`rejects ${label}`, () => assert.throws(() => validateTodayCorrection(correctionInput(times)), codeIs('invalid-argument')));
}

test('OUT at stored cutoff and at server now is allowed', () => {
  const result = validateTodayCorrection(correctionInput({ now: local('18:00'), clockOutLocal: '18:00' }));
  assert.equal(result.clockOutAt.getTime(), local('18:00').getTime());
});

test('open blank OUT stays open and explicit OUT closes', () => {
  const session = visit('open', { status: 'open', clockOutAt: null });
  const input = correctionInput({ session, clockOutLocal: null,
    attendance: { studentId: 'student', serviceDate, status: 'in', openSessionId: 'open' } });
  assert.equal(validateTodayCorrection(input).unchanged, true);
  assert.equal(validateTodayCorrection({ ...input, clockInLocal: '13:59' }).status, 'open');
  assert.equal(validateTodayCorrection({ ...input, clockOutLocal: '16:00' }).status, 'closed');
});

test('earlier correction does not update a later open or closed attendance projection', () => {
  const first = visit('first', { clockInAt: local('14:00'), clockOutAt: local('15:00') });
  const latest = visit('latest', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
  const input = correctionInput({ session: first, sessions: [latest, first], clockInLocal: '13:00',
    attendance: { studentId: 'student', serviceDate, status: 'in', openSessionId: 'latest' } });
  assert.equal(validateTodayCorrection(input).updatesLatest, false);
  latest.status = 'closed'; latest.clockOutAt = local('16:30');
  input.attendance = { studentId: 'student', serviceDate, status: 'out', openSessionId: null, lastSessionId: 'latest' };
  assert.equal(validateTodayCorrection(input).updatesLatest, false);
});

for (const [id, clockInLocal, clockOutLocal] of [
  ['first', '16:30', '17:00'], ['latest', '12:00', '13:00'],
]) {
  test(`non-overlapping correction cannot move ${id} across another closed visit`, () => {
    const first = visit('first', { clockInAt: local('14:00'), clockOutAt: local('15:00') });
    const latest = visit('latest', { clockInAt: local('16:00'), clockOutAt: local('16:30') });
    const sessions = [latest, first]; // Query order is not visit order.
    const input = correctionInput({ session: sessions.find((row) => row.id === id), sessions,
      clockInLocal, clockOutLocal,
      attendance: { studentId: 'student', serviceDate, status: 'out', lastSessionId: 'latest' } });
    assert.throws(() => validateTodayCorrection(input),
      (error) => error.code === 'invalid-argument' && /order/.test(error.message));
  });
}

for (const status of ['open', 'closed']) {
  test(`earlier visits cannot swap even with an unchanged ${status} latest visit`, () => {
    const first = visit('first', { clockInAt: local('12:00'), clockOutAt: local('13:00') });
    const middle = visit('middle', { clockInAt: local('14:00'), clockOutAt: local('15:00') });
    const latest = visit('latest', { status, clockInAt: local('16:00'),
      clockOutAt: status === 'open' ? null : local('16:30') });
    const input = correctionInput({ session: first, sessions: [latest, first, middle],
      clockInLocal: '15:00', clockOutLocal: '16:00',
      attendance: { studentId: 'student', serviceDate, status: status === 'open' ? 'in' : 'out',
        openSessionId: status === 'open' ? 'latest' : null, lastSessionId: 'latest' } });
    assert.throws(() => validateTodayCorrection(input),
      (error) => error.code === 'invalid-argument' && /order/.test(error.message));
  });
}

test('order-preserving edits can fill both neighboring boundaries or move freely with no neighbors', () => {
  const first = visit('first', { clockInAt: local('12:00'), clockOutAt: local('13:00') });
  const middle = visit('middle', { clockInAt: local('14:00'), clockOutAt: local('15:00') });
  const latest = visit('latest', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
  const result = validateTodayCorrection(correctionInput({ session: middle, sessions: [latest, middle, first],
    clockInLocal: '13:00', clockOutLocal: '16:00',
    attendance: { studentId: 'student', serviceDate, status: 'in', openSessionId: 'latest' } }));
  assert.equal(result.updatesLatest, false);
  assert.equal(result.clockInAt.getTime(), local('13:00').getTime());
  assert.equal(result.clockOutAt.getTime(), local('16:00').getTime());
  assert.equal(validateTodayCorrection(correctionInput({ clockInLocal: '00:00', clockOutLocal: '01:00' })).updatesLatest, true);
});

test('closing the open visit cannot move it before an existing closed visit', () => {
  const first = visit('first');
  const session = visit('open', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
  assert.throws(() => validateTodayCorrection(correctionInput({ session, sessions: [session, first],
    clockInLocal: '12:00', clockOutLocal: '13:00',
    attendance: { studentId: 'student', serviceDate, status: 'in', openSessionId: 'open' } })),
  (error) => error.code === 'invalid-argument' && /order/.test(error.message));
});

test('touching endpoints allowed, overlaps rejected including an open-ended visit', () => {
  const first = visit('first', { clockInAt: local('13:00'), clockOutAt: local('14:00') });
  const session = visit('visit', { clockInAt: local('14:00'), clockOutAt: local('15:00') });
  const input = correctionInput({ session, sessions: [first, session] });
  assert.equal(validateTodayCorrection(input).unchanged, true);
  assert.throws(() => validateTodayCorrection({ ...input, clockInLocal: '13:59' }), codeIs('invalid-argument'));
  const open = visit('open', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
  const withOpen = { ...input, sessions: [first, session, open],
    attendance: { studentId: 'student', serviceDate, status: 'in', openSessionId: 'open' } };
  assert.equal(validateTodayCorrection({ ...withOpen, clockOutLocal: '16:00' }).status, 'closed');
  assert.throws(() => validateTodayCorrection({ ...withOpen, clockOutLocal: '16:01' }), codeIs('invalid-argument'));
});

test('existing malformed records or overlapping history are not silently repaired', () => {
  for (const extra of [{ autoCloseAt: null }, { status: 'unknown' }, { clockInAt: null },
    { clockOutAt: local('13:00') }, { clockOutAt: local('19:00') }]) {
    assert.throws(() => validateTodayCorrection(correctionInput({ session: visit('visit', extra), clockInLocal: '13:30' })),
      codeIs('failed-precondition'));
  }
  const session = visit();
  assert.throws(() => validateTodayCorrection(correctionInput({ session, clockInLocal: '15:01', clockOutLocal: '16:00',
    sessions: [session, visit('other', { clockInAt: local('14:30'), clockOutAt: local('15:00') })] })),
  codeIs('failed-precondition'));
});

test('missing or inconsistent attendance pointers fail before any correction', () => {
  for (const attendance of [undefined, {}, { studentId: 'other', serviceDate },
    { studentId: 'student', serviceDate, status: 'out', lastSessionId: 'missing' },
    { studentId: 'student', serviceDate, status: 'in', openSessionId: 'visit' }]) {
    assert.throws(() => validateTodayCorrection(correctionInput({ attendance })), codeIs('failed-precondition'));
  }
  const session = visit('open', { status: 'open', clockOutAt: null });
  assert.throws(() => validateTodayCorrection(correctionInput({ session, clockOutLocal: null,
    attendance: { studentId: 'student', serviceDate, status: 'in', openSessionId: 'wrong' } })), codeIs('failed-precondition'));
});

test('wrong student and historical day are rejected by pure validation', () => {
  assert.throws(() => validateTodayCorrection(correctionInput({ studentId: 'other' })), codeIs('permission-denied'));
  assert.throws(() => validateTodayCorrection(correctionInput({ serviceDate: '2026-09-11' })), codeIs('failed-precondition'));
});

test('DST nonexistent and ambiguous changed times are rejected; original ambiguous minute is preserved', () => {
  const zone = 'America/New_York';
  assert.throws(() => resolveLocalTime('02:30', null, '2026-03-08', zone, 'IN'), codeIs('invalid-argument'));
  assert.throws(() => resolveLocalTime('01:30', null, '2026-11-01', zone, 'IN'), codeIs('invalid-argument'));
  for (const offset of ['-04:00', '-05:00']) {
    const original = new Date(`2026-11-01T01:30:37${offset}`);
    assert.equal(resolveLocalTime('01:30', original, '2026-11-01', zone, 'IN'), original);
    assert.throws(() => resolveLocalTime('01:31', original, '2026-11-01', zone, 'IN'), codeIs('invalid-argument'));
  }
  // Lord Howe has a half-hour DST shift, not a full-hour shift.
  assert.throws(() => resolveLocalTime('02:15', null, '2026-10-04', 'Australia/Lord_Howe', 'IN'), codeIs('invalid-argument'));
});

// Execute the actual index.js exports and authorization helpers with an in-memory SDK.
// Transactions stage writes, forbid read-after-write and retry on read-version conflicts.
// Query phantom detection is deliberately absent: race tests must use the attendance lock.
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
class FakeTimestamp {
  constructor(milliseconds, nanoseconds) {
    this.seconds = Math.floor(milliseconds / 1000);
    this.nanoseconds = nanoseconds ?? Math.round((milliseconds - this.seconds * 1000) * 1e6);
  }
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
  toDate() { return new Date(this.toMillis()); }
  static fromDate(date) { return new FakeTimestamp(date.getTime()); }
}
class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const root = 'orgs/org/schools/school';
const sessionPath = (id) => `${root}/aftercareSessions/${id}`;
const attendancePath = `${root}/aftercareAttendance/student`;
function harness() {
  const records = new Map();
  const committed = [];
  let version = 0;
  let nextId = 0;
  let currentNow = local('17:00');
  let nextClock = null;
  let beforeCommit = null;
  let afterRead = null;
  let attempts = 0;
  const clock = () => nextClock ? nextClock() : currentNow;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock().getTime()])); }
    static now() { return clock().getTime(); }
  }
  class ClockTimestamp extends FakeTimestamp {
    static now() { return FakeTimestamp.fromDate(clock()); }
  }
  const seed = (key, data) => records.set(key, { data, version: ++version });
  const data = (key) => records.get(key)?.data;
  const snapshot = (ref) => {
    const record = records.get(ref.path);
    return { ref, id: ref.id, exists: !!record,
      updateTime: record ? { seconds: 100, nanoseconds: record.version } : undefined,
      data: () => record?.data, get: (field) => record?.data[field] };
  };
  const collection = (key) => ({
    path: key,
    doc: (id = `generated-${++nextId}`) => doc(`${key}/${id}`),
    where(field, operator, value) {
      assert.equal(field, 'serviceDate', 'new callables must not require a composite index');
      assert.equal(operator, '==');
      return { query: true, path: key, field, value };
    },
  });
  const doc = (key) => ({ path: key, id: key.split('/').pop(),
    collection: (name) => collection(`${key}/${name}`), get: async () => snapshot(doc(key)) });
  const db = {
    doc, collection,
    collectionGroup(name) {
      assert.equal(name, 'aftercareSessions');
      const filters = [];
      const query = {
        where(field, operator, value) {
          assert.ok((field === 'status' && operator === '==') || (field === 'autoCloseAt' && operator === '<='));
          filters.push({ field, operator, value });
          return query;
        },
        async get() {
          return { docs: [...records.keys()].filter((key) => key.split('/').at(-2) === name &&
            filters.every(({ field, operator, value }) => operator === '=='
              ? data(key)[field] === value : data(key)[field]?.toMillis() <= value.toMillis()))
            .map((key) => snapshot(doc(key))) };
        },
      };
      return query;
    },
    async runTransaction(callback) {
      for (let retry = 0; retry < 5; retry++) {
        attempts++;
        const reads = new Map();
        const writes = [];
        const tx = {
          async get(ref) {
            assert.equal(writes.length, 0, 'all reads must occur before writes');
            if (ref.query) {
              const docs = [...records.keys()].filter((key) => key.startsWith(`${ref.path}/`) &&
                key.split('/').length === ref.path.split('/').length + 1 && data(key)[ref.field] === ref.value)
                .map((key) => { reads.set(key, records.get(key).version); return snapshot(doc(key)); });
              return { docs };
            }
            reads.set(ref.path, records.get(ref.path)?.version);
            const result = snapshot(ref);
            if (afterRead) await afterRead(ref.path);
            return result;
          },
          getAll(...refs) { return Promise.all(refs.map((ref) => tx.get(ref))); },
          update: (ref, patch) => writes.push({ type: 'update', path: ref.path, patch }),
          create: (ref, patch) => writes.push({ type: 'create', path: ref.path, patch }),
          set: (ref, patch, options) => writes.push({ type: options?.merge ? 'merge' : 'set', path: ref.path, patch }),
        };
        const result = await callback(tx);
        if (beforeCommit) { const hook = beforeCommit; beforeCommit = null; await hook(); }
        if ([...reads].some(([key, readVersion]) => records.get(key)?.version !== readVersion)) continue;
        for (const write of writes) {
          if (write.type === 'update') assert.ok(records.has(write.path));
          if (write.type === 'create') assert.ok(!records.has(write.path));
        }
        for (const write of writes) {
          seed(write.path, ['update', 'merge'].includes(write.type) ? { ...data(write.path), ...write.patch } : write.patch);
          committed.push(write);
        }
        return result;
      }
      throw new FakeHttpsError('aborted', 'mock retry limit');
    },
  };
  const exported = {};
  const callable = (_options, handler) => handler;
  const fakeRequire = (name) => {
    switch (name) {
      case 'firebase-functions/v2/https': return { onCall: callable, HttpsError: FakeHttpsError };
      case 'firebase-functions/v2/scheduler': return { onSchedule: callable };
      case 'firebase-functions/v2/firestore': return { onDocumentWritten: callable };
      case 'firebase-functions/v2/identity': return { beforeUserSignedIn: callable };
      case 'firebase-functions/params': return { defineBoolean: () => ({ value: () => false }) };
      case 'firebase-admin/app': return { initializeApp() {} };
      case 'firebase-admin/auth': return { getAuth: () => ({}) };
      case 'firebase-admin/firestore': return { getFirestore: () => db, Timestamp: ClockTimestamp,
        FieldValue: { serverTimestamp: () => FakeTimestamp.fromDate(clock()) } };
      case './aftercare-domain': return require('../aftercare-domain');
      case './aftercare-corrections': return { createAftercareCorrectionHandlers: (deps) =>
        corrections.createAftercareCorrectionHandlers({ ...deps, now: clock }) };
      default: return require(name);
    }
  };
  vm.runInNewContext(indexSource, { exports: exported, require: fakeRequire, console, Date: ClockDate,
    process: { env: { ENABLE_BEFORE_SIGNIN: 'false' } } }, { filename: 'functions/index.js' });
  seed(`${root}/settings/aftercare`, { timezone, cutoffLocalTime: '18:00', singleRateCents: 1000, familyRateCents: 1600 });
  seed(`${root}/students/student`, { name: 'Student' });
  seed(`${root}/members/staff`, { roles: { viewer: true }, status: 'active' });
  const putVisit = (id, extra = {}) => {
    const row = visit(id, extra);
    delete row.id;
    for (const key of ['clockInAt', 'clockOutAt', 'autoCloseAt']) {
      if (row[key] instanceof Date) row[key] = FakeTimestamp.fromDate(row[key]);
    }
    seed(sessionPath(id), { familyId: 'family', familyName: 'Original', singleRateCents: 1000, familyRateCents: 1600,
      openedBy: { uid: 'opener' }, closedBy: { uid: 'closer' }, closeMethod: 'manual', ...row });
  };
  putVisit('visit');
  seed(attendancePath, { studentId: 'student', serviceDate, status: 'out', openSessionId: null,
    lastSessionId: 'visit', clockedInAt: data(sessionPath('visit')).clockInAt,
    clockedOutAt: data(sessionPath('visit')).clockOutAt, intervalCount: 1, updatedBy: { uid: 'closer' } });
  const request = (extra = {}, auth = { uid: 'staff', token: {} }) => ({ auth, data: {
    orgId: 'org', schoolId: 'school', studentId: 'student', sessionId: 'visit',
    expectedServiceDate: serviceDate, expectedRevision: records.has(sessionPath('visit'))
      ? sessionRevision(snapshot(doc(sessionPath('visit')))) : '100:000000000',
    clockInLocal: '13:59', clockOutLocal: '15:00', ...extra,
  } });
  return { exported, records, committed, seed, data, putVisit, request,
    read: (req = request()) => exported.getAftercareStudentTodaySessions(req),
    update: (req = request()) => exported.updateAftercareStudentTodaySession(req),
    setNow: (value) => { currentNow = value; },
    setClock: (value) => { nextClock = value; },
    race: (hook) => { beforeCommit = hook; },
    onRead: (hook) => { afterRead = hook; },
    get attempts() { return attempts; },
  };
}

test('actual read callable returns exact minimal chronological today-only contract and no writes', async () => {
  const h = harness();
  h.putVisit('earlier', { clockInAt: local('12:00'), clockOutAt: local('13:00') });
  h.putVisit('other-student', { studentId: 'other' });
  h.putVisit('yesterday', { serviceDate: '2026-09-09' });
  const result = await h.read();
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'serverNow', 'serviceDate', 'sessions', 'timezone']);
  assert.equal(result.serviceDate, serviceDate);
  assert.equal(result.timezone, timezone);
  assert.equal(result.serverNow, local('17:00').toISOString());
  assert.deepEqual(result.sessions.map((row) => row.id), ['earlier', 'visit']);
  assert.deepEqual(Object.keys(result.sessions[0]).sort(),
    ['autoCloseAt', 'clockInAt', 'clockOutAt', 'id', 'revision', 'serviceDate', 'status', 'studentId']);
  assert.equal(h.committed.length, 0);
});

test('read returns empty sessions and open nullable times without exposing financial fields', async () => {
  const h = harness();
  h.putVisit('visit', { status: 'open', clockOutAt: null, autoCloseAt: null });
  const row = (await h.read()).sessions[0];
  assert.equal(row.clockOutAt, null);
  assert.equal(row.autoCloseAt, null);
  assert.equal(row.familyId, undefined);
  h.setNow(local('12:00', '2026-09-11'));
  assert.deepEqual((await h.read()).sessions, []);
});

for (const roles of [{ viewer: true }, { caller: true }, { admin: true }]) {
  test(`same active staff roles as check-in may correct: ${Object.keys(roles)[0]}`, async () => {
    const h = harness();
    h.seed(`${root}/members/staff`, { roles, status: 'active' });
    assert.deepEqual(await h.update(), { ok: true });
    assert.equal((await h.read()).ok, true);
  });
}

test('actual authorization denies unauthenticated, inactive, unprivileged and other-tenant access', async () => {
  for (const method of ['read', 'update']) {
    const h = harness();
    await assert.rejects(h[method](h.request({}, null)), codeIs('unauthenticated'));
    await assert.rejects(h[method](h.request({ schoolId: 'other-school' })), codeIs('permission-denied'));
    await assert.rejects(h[method](h.request({ orgId: 'other-org' })), codeIs('permission-denied'));
    h.seed(`${root}/members/staff`, { roles: { viewer: true }, status: 'inactive' });
    await assert.rejects(h[method](), codeIs('permission-denied'));
    h.seed(`${root}/members/staff`, { roles: {} });
    await assert.rejects(h[method](), codeIs('permission-denied'));
    assert.equal(h.committed.length, 0);
  }
});

test('tenant path inputs, missing student, missing session, ownership and revision are guarded', async () => {
  const h = harness();
  await assert.rejects(h.update(h.request({ orgId: 'org/schools/injected' })), codeIs('invalid-argument'));
  await assert.rejects(h.update(h.request({ studentId: 'missing' })), codeIs('not-found'));
  await assert.rejects(h.read(h.request({ studentId: 'missing' })), codeIs('not-found'));
  await assert.rejects(h.update(h.request({ sessionId: 'missing' })), codeIs('not-found'));
  h.putVisit('other', { studentId: 'other' });
  await assert.rejects(h.update(h.request({ sessionId: 'other' })), codeIs('permission-denied'));
  await assert.rejects(h.update(h.request({ expectedRevision: '100:000000000' })), codeIs('aborted'));
  await assert.rejects(h.update(h.request({ expectedRevision: undefined })), codeIs('invalid-argument'));
  await assert.rejects(h.update(h.request({ expectedServiceDate: undefined })), codeIs('invalid-argument'));
  assert.equal(h.committed.length, 0);
});

test('owner and superintendent have no yesterday/date-change exception', async () => {
  for (const token of [{ owner: true }, { superintendent: true, orgIds: ['org'] }]) {
    const h = harness();
    const auth = { uid: 'manager', token };
    await assert.rejects(h.update(h.request({ expectedServiceDate: '2026-09-09' }, auth)), codeIs('failed-precondition'));
    h.putVisit('visit', { serviceDate: '2026-09-09' });
    await assert.rejects(h.update(h.request({}, auth)), codeIs('failed-precondition'));
    assert.equal(h.committed.length, 0);
  }
});

test('no-op callable writes nothing, including attendance and audit', async () => {
  const h = harness();
  assert.deepEqual(await h.update(h.request({ clockInLocal: '14:00' })), { ok: true, unchanged: true });
  assert.equal(h.committed.length, 0);
});

test('latest closed edit atomically refreshes both card times, preserves history and audits before/after', async () => {
  const h = harness();
  const before = h.data(sessionPath('visit'));
  const revision = h.request().data.expectedRevision;
  await h.update(h.request({ familyId: 'ATTACK', singleRateCents: 0, autoCloseAt: null }));
  const after = h.data(sessionPath('visit'));
  const attendance = h.data(attendancePath);
  assert.equal(h.committed.length, 3);
  assert.equal(attendance.clockedInAt, after.clockInAt);
  assert.equal(attendance.clockedOutAt, before.clockOutAt);
  assert.equal(attendance.lastSessionId, 'visit');
  assert.equal(attendance.intervalCount, 1);
  for (const key of ['familyId', 'familyName', 'singleRateCents', 'familyRateCents', 'openedBy', 'closedBy',
    'closeMethod', 'autoCloseAt', 'serviceDate', 'timezone']) assert.equal(after[key], before[key]);
  assert.equal(after.correctedBy.uid, 'staff');
  const auditWrite = h.committed.find((write) => write.path.includes('/corrections/'));
  assert.ok(auditWrite.path.startsWith(`${sessionPath('visit')}/corrections/`));
  assert.equal(auditWrite.patch.before.clockInAt, before.clockInAt);
  assert.equal(auditWrite.patch.after.clockInAt, after.clockInAt);
  assert.equal(auditWrite.patch.expectedRevision, revision);
  assert.equal(auditWrite.patch.correctedBy.uid, 'staff');
  assert.equal(auditWrite.patch.correctedAt, attendance.updatedAt);
  assert.notEqual((await h.read()).sessions[0].revision, revision);
});

test('earlier closed correction only touches attendance lock, never latest card fields', async () => {
  const h = harness();
  h.putVisit('latest', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
  const latest = { studentId: 'student', serviceDate, status: 'in', openSessionId: 'latest',
    lastSessionId: 'visit', clockedInAt: local('16:00'), clockedOutAt: null, intervalCount: 2, updatedBy: { uid: 'latest-opener' } };
  h.seed(attendancePath, latest);
  await h.update();
  assert.deepEqual(Object.keys(h.committed.find((write) => write.path === attendancePath).patch), ['updatedAt']);
  const { updatedAt, ...remaining } = h.data(attendancePath);
  assert.ok(updatedAt);
  assert.deepEqual(remaining, latest);
});

test('open edit retains pointer; explicit OUT closes with original opener and correction audit', async () => {
  const h = harness();
  h.putVisit('visit', { status: 'open', clockOutAt: null, closedBy: undefined });
  h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'visit', intervalCount: 1 });
  await h.update(h.request({ clockOutLocal: null }));
  assert.equal(h.data(attendancePath).status, 'in');
  assert.equal(h.data(attendancePath).openSessionId, 'visit');
  assert.equal(h.data(attendancePath).clockedOutAt, null);
  await h.update(h.request({ clockInLocal: '13:59', clockOutLocal: '16:00' }));
  assert.equal(h.data(attendancePath).status, 'out');
  assert.equal(h.data(attendancePath).openSessionId, null);
  assert.equal(h.data(attendancePath).lastSessionId, 'visit');
  assert.equal(h.data(sessionPath('visit')).openedBy.uid, 'opener');
  assert.equal(h.data(sessionPath('visit')).closedBy.uid, 'staff');
  assert.equal(h.data(sessionPath('visit')).closeMethod, 'corrected');
});

test('callable rejects reordering atomically and preserves latest pointer, card times and audit', async () => {
  for (const direction of ['earlier-to-later', 'latest-to-earlier']) {
    const h = harness();
    if (direction === 'earlier-to-later') {
      h.putVisit('peer', { clockInAt: local('16:00'), clockOutAt: local('16:30') });
      h.seed(attendancePath, { ...h.data(attendancePath), lastSessionId: 'peer',
        clockedInAt: h.data(sessionPath('peer')).clockInAt, clockedOutAt: h.data(sessionPath('peer')).clockOutAt });
    } else h.putVisit('peer', { clockInAt: local('12:00'), clockOutAt: local('13:00') });
    const before = h.data(sessionPath('visit'));
    const attendance = h.data(attendancePath);
    await assert.rejects(h.update(h.request(direction === 'earlier-to-later'
      ? { clockInLocal: '16:30', clockOutLocal: '17:00' }
      : { clockInLocal: '10:00', clockOutLocal: '11:00' })),
    (error) => error.code === 'invalid-argument' && /order/.test(error.message));
    assert.equal(h.committed.length, 0);
    assert.equal(h.data(sessionPath('visit')), before);
    assert.equal(h.data(attendancePath), attendance);
  }
});

test('an existing lastSessionId pointing to a non-latest closed visit fails closed, including no-op', async () => {
  const h = harness();
  h.putVisit('later', { clockInAt: local('16:00'), clockOutAt: local('16:30') });
  for (const clockInLocal of ['13:59', '14:00']) {
    await assert.rejects(h.update(h.request({ clockInLocal })), codeIs('failed-precondition'));
  }
  assert.equal(h.committed.length, 0);
});

test('transaction failures discard all staged writes', async () => {
  const h = harness();
  h.putVisit('peer', { clockInAt: local('15:30'), clockOutAt: local('16:00') });
  h.seed(attendancePath, { ...h.data(attendancePath), lastSessionId: 'peer',
    clockedInAt: h.data(sessionPath('peer')).clockInAt, clockedOutAt: h.data(sessionPath('peer')).clockOutAt });
  await assert.rejects(h.update(h.request({ clockOutLocal: '15:31' })), codeIs('invalid-argument'));
  assert.equal(h.committed.length, 0);
  assert.equal(h.data(sessionPath('visit')).correctedAt, undefined);
  h.race(() => { throw new FakeHttpsError('unavailable', 'Simulated commit failure'); });
  await assert.rejects(h.update(), codeIs('unavailable'));
  assert.equal(h.committed.length, 0);
  assert.equal(h.data(sessionPath('visit')).correctedAt, undefined);
});

test('simultaneous selected-session correction or auto-close invalidates expectedRevision on retry', async () => {
  for (const status of ['closed', 'open']) {
    const h = harness();
    if (status === 'open') {
      h.putVisit('visit', { status, clockOutAt: null });
      h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'visit' });
    }
    h.race(() => {
      h.seed(sessionPath('visit'), { ...h.data(sessionPath('visit')), status: 'closed', clockOutAt: local('16:00') });
      h.seed(attendancePath, { ...h.data(attendancePath), status: 'out', openSessionId: null, lastSessionId: 'visit' });
    });
    await assert.rejects(h.update(h.request({ clockOutLocal: status === 'open' ? null : '15:00' })), codeIs('aborted'));
    assert.equal(h.attempts, 2);
    assert.equal(h.committed.length, 0);
  }
});

test('attendance lock detects new peer phantom on concurrent check-in and revalidates overlap', async () => {
  const h = harness();
  h.race(() => {
    h.putVisit('new-open', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
    h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'new-open', intervalCount: 2 });
  });
  await assert.rejects(h.update(h.request({ clockOutLocal: '16:30' })), codeIs('invalid-argument'));
  assert.equal(h.attempts, 2);
  assert.equal(h.committed.length, 0);
});

test('concurrent latest checkout is preserved when an earlier correction retries', async () => {
  const h = harness();
  h.putVisit('latest', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
  h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'latest', clockedInAt: local('16:00') });
  h.race(() => {
    h.putVisit('latest', { clockInAt: local('16:00'), clockOutAt: local('16:30') });
    h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'out', openSessionId: null,
      lastSessionId: 'latest', clockedInAt: local('16:00'), clockedOutAt: local('16:30') });
  });
  await h.update();
  assert.equal(h.attempts, 2);
  assert.equal(h.data(attendancePath).lastSessionId, 'latest');
  assert.equal(h.data(attendancePath).clockedOutAt.getTime(), local('16:30').getTime());
});

test('actual concurrent check-in forces correction retry without overwriting the new open card', async () => {
  const h = harness();
  h.setNow(local('16:00'));
  let opened;
  h.race(async () => {
    h.setNow(local('16:01'));
    opened = await h.exported.clockInAftercareStudent(h.request());
  });
  await h.update(h.request({ clockOutLocal: '15:30' }));
  assert.equal(h.attempts, 3); // Correction, real clock-in, correction retry.
  assert.equal(h.data(attendancePath).openSessionId, opened.sessionId);
  assert.equal(h.data(attendancePath).clockedInAt.toMillis(), local('16:01').getTime());
  assert.equal(h.data(attendancePath).clockedOutAt, null);
  assert.equal(h.data(sessionPath('visit')).clockOutAt.toMillis(), local('15:30').getTime());
});

for (const method of ['clockOutAftercareStudent', 'autoCloseAftercareSessions']) {
  test(`actual ${method} invalidates a selected open correction revision on retry`, async () => {
    const h = harness();
    h.setNow(local('18:00'));
    h.putVisit('visit', { status: 'open', clockOutAt: null });
    h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'visit' });
    h.race(() => h.exported[method](h.request()));
    await assert.rejects(h.update(h.request({ clockOutLocal: null })), codeIs('aborted'));
    assert.equal(h.attempts, 3);
    assert.equal(h.data(sessionPath('visit')).clockOutAt.toMillis(), local('18:00').getTime());
    assert.equal(h.data(attendancePath).lastSessionId, 'visit');
    assert.equal(h.committed.length, 2); // Only the real close committed; no correction/audit.
  });

  test(`actual ${method} retries after an open IN correction and preserves corrected card IN`, async () => {
    const h = harness();
    h.setNow(local('18:00'));
    h.putVisit('visit', { status: 'open', clockOutAt: null });
    h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'visit' });
    h.race(() => h.update(h.request({ clockOutLocal: null })));
    await h.exported[method](h.request());
    assert.equal(h.attempts, 3);
    const session = h.data(sessionPath('visit'));
    assert.equal(session.clockInAt.toMillis(), local('13:59').getTime());
    assert.equal(session.clockOutAt.toMillis(), local('18:00').getTime());
    assert.equal(h.data(attendancePath).clockedInAt, session.clockInAt);
    assert.equal(h.data(attendancePath).clockedOutAt, session.clockOutAt);
    assert.equal(h.data(attendancePath).lastSessionId, 'visit');
    assert.equal(h.committed.filter((write) => write.path.includes('/corrections/')).length, 1);
  });
}

test('actual scheduler closing a later visit preserves its projection when an earlier correction retries', async () => {
  const h = harness();
  h.setNow(local('18:00'));
  h.putVisit('latest', { status: 'open', clockInAt: local('16:00'), clockOutAt: null });
  h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'latest',
    clockedInAt: h.data(sessionPath('latest')).clockInAt });
  h.race(() => h.exported.autoCloseAftercareSessions());
  await h.update();
  assert.equal(h.attempts, 3);
  assert.equal(h.data(attendancePath).lastSessionId, 'latest');
  assert.equal(h.data(attendancePath).clockedInAt.toMillis(), local('16:00').getTime());
  assert.equal(h.data(attendancePath).clockedOutAt.toMillis(), local('18:00').getTime());
  assert.equal(h.data(attendancePath).updatedBy.uid, 'system');
});

test('school-local midnight during reads and settings changes on retry fail without writes', async () => {
  for (const method of ['read', 'update']) {
    const h = harness();
    let calls = 0;
    h.setClock(() => ++calls === 1 ? local('23:59:59') : local('00:00', '2026-09-11'));
    await assert.rejects(h[method](), codeIs('failed-precondition'));
    assert.equal(h.committed.length, 0);
  }
  const h = harness();
  h.race(() => h.seed(`${root}/settings/aftercare`, { timezone: 'Pacific/Auckland', cutoffLocalTime: '18:00' }));
  await assert.rejects(h.update(), codeIs('failed-precondition'));
  assert.equal(h.attempts, 2);
  assert.equal(h.committed.length, 0);
});

test('actual check-in/out still creates separate repeat visits, duplicate taps do not add visits, gaps unbilled', async () => {
  const h = harness();
  h.records.delete(sessionPath('visit'));
  h.records.delete(attendancePath);
  h.setNow(local('14:00'));
  const first = await h.exported.clockInAftercareStudent(h.request());
  const duplicate = await h.exported.clockInAftercareStudent(h.request());
  assert.equal(duplicate.alreadyOpen, true);
  assert.equal(duplicate.sessionId, first.sessionId);
  h.setNow(local('15:00'));
  await h.exported.clockOutAftercareStudent(h.request());
  const preserved = h.data(sessionPath(first.sessionId));
  h.setNow(local('16:00'));
  const second = await h.exported.clockInAftercareStudent(h.request());
  assert.notEqual(second.sessionId, first.sessionId);
  h.setNow(local('17:00'));
  await h.exported.clockOutAftercareStudent(h.request());
  assert.equal(h.data(sessionPath(first.sessionId)), preserved);
  assert.equal(h.data(attendancePath).intervalCount, 2);
  const rows = [preserved, h.data(sessionPath(second.sessionId))];
  const bill = calculateFamilyDay(rows, { singleRateCents: 1000, familyRateCents: 1600 });
  assert.equal(bill.totalMilliseconds, 2 * 60 * 60 * 1000);
  assert.equal(bill.totalAmountCents, 2000);
});

// Regressions from the original clock-handler source probes, using real exports.
function openVisit(h, extra = {}) {
  h.putVisit('visit', { status: 'open', clockOutAt: null, ...extra });
  h.seed(attendancePath, { studentId: 'student', serviceDate, status: 'in', openSessionId: 'visit' });
}
const reloadAborted = (error) => error.code === 'aborted' && /reload/i.test(error.message);

test('clock-in retry refreshes IN after a concurrent correction advances latest OUT', async () => {
  const h = harness();
  h.setNow(local('16:00'));
  h.race(async () => {
    h.setNow(local('16:02'));
    await h.update(h.request({ clockOutLocal: '16:01' }));
  });
  const result = await h.exported.clockInAftercareStudent(h.request());
  assert.equal(h.attempts, 3);
  const next = h.data(sessionPath(result.sessionId));
  assert.equal(next.clockInAt.toMillis(), local('16:02').getTime());
  assert.ok(next.clockInAt.toMillis() >= h.data(sessionPath('visit')).clockOutAt.toMillis());
  assert.equal(h.data(attendancePath).clockedInAt, next.clockInAt);
});

for (const lastRead of ['aftercareServiceDays', 'aftercareFamilies']) {
  test(`clock-in refreshes time after the ${lastRead} read, preserving frozen rates`, async () => {
    const h = harness();
    h.setNow(local('16:00'));
    h.seed(`${root}/aftercareServiceDays/${serviceDate}`, {
      timezone, cutoffLocalTime: '18:00', singleRateCents: 1200, familyRateCents: 1900,
    });
    if (lastRead === 'aftercareFamilies') {
      h.seed(`${root}/aftercareStudentFamilies/student`, { familyId: 'family' });
      h.seed(`${root}/aftercareFamilies/family`, { name: 'Family', active: true });
    }
    h.onRead((key) => { if (key.includes(`/${lastRead}/`)) h.setNow(local('16:01')); });
    const result = await h.exported.clockInAftercareStudent(h.request());
    const row = h.data(sessionPath(result.sessionId));
    assert.equal(row.clockInAt.toMillis(), local('16:01').getTime());
    assert.equal(row.autoCloseAt.toMillis(), local('18:00').getTime());
    assert.equal(row.singleRateCents, 1200);
    assert.equal(row.familyRateCents, 1900);
  });
}

for (const boundary of ['cutoff', 'midnight']) {
  for (const phase of ['last read', 'retry']) {
    test(`clock-in rejects crossing ${boundary} at ${phase} without creating a visit`, async () => {
      const h = harness();
      h.setNow(local('17:59'));
      const advance = () => h.setNow(boundary === 'cutoff' ? local('18:00') : local('00:01', '2026-09-11'));
      if (phase === 'last read') {
        h.seed(`${root}/aftercareStudentFamilies/student`, { familyId: 'family' });
        h.onRead((key) => { if (key.endsWith('/aftercareFamilies/family')) advance(); });
      } else h.race(() => {
        advance();
        h.seed(attendancePath, { ...h.data(attendancePath), updatedAt: FakeTimestamp.fromDate(local('18:00')) });
      });
      await assert.rejects(h.exported.clockInAftercareStudent(h.request()), codeIs('failed-precondition'));
      assert.equal(h.attempts, phase === 'retry' ? 2 : 1);
      assert.equal(h.committed.length, 0);
    });
  }
}

test('clock-in rejects IN before attendance latest OUT but permits an exactly touching endpoint', async () => {
  const h = harness();
  const end = h.data(attendancePath).clockedOutAt.toDate();
  h.setNow(new Date(end.getTime() - 1));
  await assert.rejects(h.exported.clockInAftercareStudent(h.request()), codeIs('failed-precondition'));
  assert.equal(h.committed.length, 0);
  h.setNow(end);
  const result = await h.exported.clockInAftercareStudent(h.request());
  assert.equal(h.data(sessionPath(result.sessionId)).clockInAt.toMillis(), end.getTime());
});

test('checkout retry refreshes OUT after a concurrent correction advances current IN', async () => {
  const h = harness();
  openVisit(h);
  h.setNow(local('16:00'));
  h.race(async () => {
    h.setNow(local('16:02'));
    await h.update(h.request({ clockInLocal: '16:01', clockOutLocal: null }));
  });
  const result = await h.exported.clockOutAftercareStudent(h.request({ expectedSessionId: 'visit' }));
  const row = h.data(sessionPath('visit'));
  assert.equal(h.attempts, 3);
  assert.equal(row.clockOutAt.toMillis(), local('16:02').getTime());
  assert.ok(row.clockOutAt.toMillis() > row.clockInAt.toMillis());
  assert.equal(result.durationMilliseconds, 60000);
  assert.equal(h.data(attendancePath).clockedInAt, row.clockInAt);
});

for (const phase of ['session read', 'retry']) {
  test(`checkout refreshes after ${phase} and caps OUT at cutoff`, async () => {
    const h = harness();
    openVisit(h);
    h.setNow(local('17:59'));
    if (phase === 'session read') h.onRead((key) => { if (key === sessionPath('visit')) h.setNow(local('18:01')); });
    else h.race(() => {
      h.setNow(local('18:01'));
      h.seed(sessionPath('visit'), { ...h.data(sessionPath('visit')), updatedAt: FakeTimestamp.fromDate(local('18:00')) });
    });
    await h.exported.clockOutAftercareStudent(h.request());
    const row = h.data(sessionPath('visit'));
    assert.equal(row.clockOutAt, row.autoCloseAt);
    assert.equal(row.closeMethod, 'cutoff');
    assert.equal(h.attempts, phase === 'retry' ? 2 : 1);
  });
}

test('checkout rejects equal, future, missing IN and nonpositive cutoff-capped duration without writes', async () => {
  for (const [now, clockInAt] of [
    ['16:00', local('16:00')], ['16:00', local('16:01')], ['16:00', null], ['18:01', local('18:00')],
  ]) {
    const h = harness();
    openVisit(h, { clockInAt });
    h.setNow(local(now));
    await assert.rejects(h.exported.clockOutAftercareStudent(h.request()), codeIs('failed-precondition'));
    assert.equal(h.committed.length, 0);
    assert.equal(h.data(sessionPath('visit')).status, 'open');
  }
});

for (const expected of [false, true]) {
  test(`checkout pins the intended visit across replacement on retry (expectedSessionId=${expected})`, async () => {
    const h = harness();
    openVisit(h);
    h.setNow(local('16:00'));
    let replacement;
    h.race(async () => {
      h.setNow(local('16:01'));
      await h.update(h.request({ clockInLocal: '14:00', clockOutLocal: '16:00' }));
      h.setNow(local('16:02'));
      replacement = await h.exported.clockInAftercareStudent(h.request());
    });
    await assert.rejects(h.exported.clockOutAftercareStudent(h.request(expected ? { expectedSessionId: 'visit' } : {})), reloadAborted);
    assert.equal(h.attempts, 4);
    assert.equal(h.data(sessionPath(replacement.sessionId)).status, 'open');
    assert.equal(h.data(attendancePath).openSessionId, replacement.sessionId);
    assert.equal(h.data(sessionPath('visit')).closeMethod, 'corrected');
    assert.equal(h.committed.filter((write) => write.path === sessionPath(replacement.sessionId)).length, 1);
  });
}

test('explicit stale checkout expectation rejects a replacement already present before first attempt', async () => {
  const h = harness();
  h.setNow(local('16:00'));
  const replacement = await h.exported.clockInAftercareStudent(h.request());
  const committed = h.committed.length;
  await assert.rejects(h.exported.clockOutAftercareStudent(h.request({ expectedSessionId: 'visit' })), reloadAborted);
  assert.equal(h.committed.length, committed);
  assert.equal(h.data(sessionPath(replacement.sessionId)).status, 'open');
});

test('optional expectedSessionId validates every supplied value with cleanDocId, even when already out', async () => {
  for (const expectedSessionId of ['', '   ', null, undefined, 'visit/other']) {
    const h = harness();
    await assert.rejects(h.exported.clockOutAftercareStudent(h.request({ expectedSessionId })), codeIs('invalid-argument'));
    assert.equal(h.attempts, 0);
    assert.equal(h.committed.length, 0);
  }
  const h = harness();
  openVisit(h);
  const result = await h.exported.clockOutAftercareStudent(h.request({ expectedSessionId: ' visit ' }));
  assert.equal(result.sessionId, 'visit');
  assert.equal(result.alreadyClosed, false);
});

test('legacy checkout first observing out cannot acquire a newly opened visit on retry', async () => {
  const h = harness();
  h.setNow(local('16:00'));
  let replacement;
  h.race(async () => {
    replacement = await h.exported.clockInAftercareStudent(h.request());
    h.setNow(local('16:01'));
  });
  await assert.rejects(h.exported.clockOutAftercareStudent(h.request()), reloadAborted);
  assert.equal(h.attempts, 3);
  assert.equal(h.data(sessionPath(replacement.sessionId)).status, 'open');
  assert.equal(h.data(attendancePath).openSessionId, replacement.sessionId);
  assert.equal(h.committed.filter((write) => write.path === sessionPath(replacement.sessionId)).length, 1);
});

test('checkout remains idempotent for out attendance with or without an explicit expectation', async () => {
  for (const extra of [{}, { expectedSessionId: 'visit' }, { expectedSessionId: 'older-visit' }]) {
    const h = harness();
    const result = await h.exported.clockOutAftercareStudent(h.request(extra));
    assert.equal(result.ok, true);
    assert.equal(result.alreadyClosed, true);
    assert.equal(h.committed.length, 0);
  }
});

for (const expected of [false, true]) {
  test(`scheduler winning a pending checkout preserves alreadyClosed (expectedSessionId=${expected})`, async () => {
    const h = harness();
    openVisit(h);
    h.setNow(local('17:59'));
    h.race(async () => {
      h.setNow(local('18:01'));
      await h.exported.autoCloseAftercareSessions();
    });
    const result = await h.exported.clockOutAftercareStudent(h.request(expected ? { expectedSessionId: 'visit' } : {}));
    assert.equal(result.alreadyClosed, true);
    assert.equal(h.attempts, 3);
    assert.equal(h.committed.length, 2);
    assert.equal(h.data(sessionPath('visit')).closeMethod, 'auto');
    assert.equal(h.data(sessionPath('visit')).clockOutAt.toMillis(), local('18:00').getTime());
    assert.equal(h.data(attendancePath).updatedBy.uid, 'system');
  });
}