const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const {
  aggregateAftercareReport,
  calculateFamilyDay,
  decimalHours,
  formatDuration,
  getServiceDay,
} = require('../aftercare-domain');

const rates = { singleRateCents: 1000, familyRateCents: 1600 };
const hour = 60 * 60 * 1000;

test('formats 230 minutes in human and decimal forms', () => {
  const duration = 230 * 60 * 1000;
  assert.equal(formatDuration(duration), '3 hr 50 min');
  assert.equal(decimalHours(duration), 3.83);
});

test('charges solo and sibling overlap once per family', () => {
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: 2 * hour },
    { studentId: 'b', clockInAt: hour, clockOutAt: 3 * hour },
  ], rates);

  assert.equal(result.singleMilliseconds, 2 * hour);
  assert.equal(result.familyMilliseconds, hour);
  assert.equal(result.singleAmountCents, 2000);
  assert.equal(result.familyAmountCents, 1600);
  assert.equal(result.totalAmountCents, 3600);
  assert.deepEqual(result.studentMilliseconds, { a: 2 * hour, b: 2 * hour });
});

test('treats sibling endpoints within five minutes as one family interval', () => {
  const minute = 60 * 1000;
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: 2 * hour },
    { studentId: 'b', clockInAt: 4 * minute, clockOutAt: 2 * hour - 3 * minute },
  ], rates);

  assert.equal(result.singleMilliseconds, 0);
  assert.equal(result.familyMilliseconds, 117 * minute);
  assert.equal(result.familyAmountCents, 3120);
  assert.deepEqual(result.studentMilliseconds, { a: 2 * hour, b: 113 * minute });
});

test('includes an exact five-minute endpoint difference in family billing', () => {
  const minute = 60 * 1000;
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: 2 * hour },
    { studentId: 'b', clockInAt: 5 * minute, clockOutAt: 2 * hour - 5 * minute },
  ], rates);

  assert.equal(result.singleMilliseconds, 0);
  assert.equal(result.familyMilliseconds, 115 * minute);
});

test('keeps solo edge time when sibling endpoints differ by more than five minutes', () => {
  const minute = 60 * 1000;
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: 2 * hour },
    { studentId: 'b', clockInAt: 6 * minute, clockOutAt: 2 * hour - 6 * minute },
  ], rates);

  assert.equal(result.singleMilliseconds, 12 * minute);
  assert.equal(result.familyMilliseconds, 108 * minute);
});

test('counts three simultaneous siblings at one family rate', () => {
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: hour },
    { studentId: 'b', clockInAt: 0, clockOutAt: hour },
    { studentId: 'c', clockInAt: 0, clockOutAt: hour },
  ], rates);
  assert.equal(result.singleMilliseconds, 0);
  assert.equal(result.familyMilliseconds, hour);
  assert.equal(result.totalAmountCents, 1600);
});

test('merges duplicate intervals for one student and supports same-day returns', () => {
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: hour },
    { studentId: 'a', clockInAt: hour / 2, clockOutAt: 2 * hour },
    { studentId: 'a', clockInAt: 3 * hour, clockOutAt: 4 * hour },
  ], rates);
  assert.equal(result.singleMilliseconds, 3 * hour);
  assert.equal(result.familyMilliseconds, 0);
  assert.equal(result.studentMilliseconds.a, 3 * hour);
});

test('touching intervals do not create sibling overlap', () => {
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: hour },
    { studentId: 'b', clockInAt: hour, clockOutAt: 2 * hour },
  ], rates);
  assert.equal(result.singleMilliseconds, 2 * hour);
  assert.equal(result.familyMilliseconds, 0);
});

test('rounds solo and family daily subtotals to cents', () => {
  const sixMinutes = 6 * 60 * 1000;
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: 1 },
    { studentId: 'b', clockInAt: 0, clockOutAt: 1 },
    { studentId: 'a', clockInAt: sixMinutes, clockOutAt: sixMinutes + 1 },
  ], { singleRateCents: 1800000, familyRateCents: 1800000 });
  assert.equal(result.singleAmountCents, 1);
  assert.equal(result.familyAmountCents, 1);
  assert.equal(result.totalAmountCents, 2);
});

test('resolves a school-local service day and cutoff across DST', () => {
  const now = DateTime.fromISO('2026-03-08T17:30:00', { zone: 'America/New_York' }).toJSDate();
  const result = getServiceDay(now, 'America/New_York', '18:00');
  assert.equal(result.serviceDate, '2026-03-08');
  assert.equal(result.billingMonth, '2026-03');
  assert.equal(result.cutoffAt.toISOString(), '2026-03-08T22:00:00.000Z');
  assert.equal(result.isAfterCutoff, false);
});

test('treats the exact local cutoff as closed', () => {
  const now = DateTime.fromISO('2026-07-10T18:00:00', { zone: 'America/Chicago' }).toJSDate();
  assert.equal(getServiceDay(now, 'America/Chicago', '18:00').isAfterCutoff, true);
});

test('reports use stored historical families when no current mapping exists', () => {
  const result = aggregateAftercareReport([{
    id: 'session-1', studentId: 'a', studentName: 'Alex', familyId: 'old', familyName: 'Old Family',
    serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour,
    singleRateCents: 1000, familyRateCents: 1600,
  }], [{ id: 'new', name: 'New Family', students: [{ studentId: 'b', name: 'Blair' }] }], rates);

  assert.equal(result.familyRows.length, 1);
  assert.equal(result.familyRows[0].familyId, 'old');
  assert.equal(result.familyRows[0].familyName, 'Old Family');
  assert.equal(result.familyRows[0].familyStatus, 'missing');
  assert.deepEqual(result.familyRows[0].configuredStudents, []);
  assert.deepEqual(result.familyRows[0].billedStudents.map((student) => student.studentName), ['Alex']);
});

test('uses the current active family for legacy sessions with no stored assignment', () => {
  const result = aggregateAftercareReport([{
    id: 'session-1', studentId: 'a', studentName: 'Alex', serviceDate: '2026-08-04',
    status: 'closed', clockInAt: 0, clockOutAt: hour,
  }], [{ id: 'current', name: 'Current Family', active: true, studentIds: ['a'], students: [{ studentId: 'a', name: 'Alex' }] }], rates);

  assert.equal(result.familyRows[0].accountType, 'family');
  assert.equal(result.familyRows[0].familyKey, 'current');
  assert.equal(result.familyRows[0].familyName, 'Current Family');
  assert.equal(result.sessionRows[0].assignmentSource, 'current-family');
});

test('keeps truly unlinked students as individual billing accounts', () => {
  const result = aggregateAftercareReport([{
    id: 'session-1', studentId: 'a', studentName: 'Alex', serviceDate: '2026-08-04',
    status: 'closed', clockInAt: 0, clockOutAt: hour,
  }], [], rates);

  assert.equal(result.familyRows[0].accountType, 'student');
  assert.equal(result.familyRows[0].familyKey, 'student:a');
  assert.equal(result.familyRows[0].familyName, 'Alex');
});

test('resolves a legacy student to an active family by exact configured name', () => {
  const result = aggregateAftercareReport([{
    id: 'session-1', studentId: 'legacy-a', studentName: 'Aguila, Ethan', serviceDate: '2026-08-04',
    status: 'closed', clockInAt: 0, clockOutAt: hour,
  }], [{ id: 'aguila', name: 'Aguila', active: true, students: [{ studentId: 'current-a', name: 'Aguila, Ethan' }] }], rates);

  assert.equal(result.familyRows[0].familyId, 'aguila');
  assert.equal(result.familyRows[0].familyName, 'Aguila');
  assert.equal(result.familyRows[0].accountType, 'family');
});

test('uses the canonical current mapping for a legacy session without a family', () => {
  const result = aggregateAftercareReport([{
    id: 'session-1', studentId: 'legacy-a', studentName: 'Aguila, Ethan', currentFamilyId: 'aguila', currentFamilyName: 'Aguila',
    serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour,
  }], [{ id: 'aguila', name: 'Aguila', active: true, studentIds: ['current-a'], students: [{ studentId: 'current-a', name: 'Aguila, Ethan' }] }], rates);

  assert.equal(result.familyRows[0].familyId, 'aguila');
  assert.equal(result.familyRows[0].familyName, 'Aguila');
  assert.equal(result.sessionRows[0].assignmentSource, 'current-family');
});

test('canonical current mapping reunites sessions with stale stored family assignments', () => {
  const result = aggregateAftercareReport([
    { id: 'one', studentId: 'a', studentName: 'Aguila, Ethan', familyId: 'old-a', familyName: 'Aguila, Ethan', currentFamilyId: 'aguila', currentFamilyName: 'Aguila', serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour },
    { id: 'two', studentId: 'b', studentName: 'Aguila, Isaac', familyId: 'old-b', familyName: 'Aguila, Isaac', currentFamilyId: 'aguila', currentFamilyName: 'Aguila', serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour },
  ], [{ id: 'aguila', name: 'Aguila', active: true, studentIds: ['a', 'b'], students: [{ studentId: 'a', name: 'Aguila, Ethan' }, { studentId: 'b', name: 'Aguila, Isaac' }] }], rates);

  assert.equal(result.familyRows.length, 1);
  assert.equal(result.familyRows[0].familyId, 'aguila');
  assert.deepEqual(result.familyRows[0].billedStudents.map((student) => student.studentName), ['Aguila, Ethan', 'Aguila, Isaac']);
  assert.equal(result.familyRows[0].familyAmountCents, 1600);
});

test('separates configured roster from students billed in the period', () => {
  const result = aggregateAftercareReport([{
    id: 'session-1', studentId: 'a', studentName: 'Alex', familyId: 'family', familyName: 'Example Family',
    serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour,
  }], [{ id: 'family', name: 'Example Family', active: true, students: [
    { studentId: 'a', name: 'Alex' }, { studentId: 'b', name: 'Blair' },
  ] }], rates);

  assert.deepEqual(result.familyRows[0].billedStudents.map((student) => student.studentName), ['Alex']);
  assert.deepEqual(result.familyRows[0].configuredStudents.map((student) => student.studentName), ['Alex', 'Blair']);
});

test('excludes and flags open or invalid sessions without changing valid totals', () => {
  const result = aggregateAftercareReport([
    { id: 'valid', studentId: 'a', studentName: 'Alex', serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour },
    { id: 'open', studentId: 'b', studentName: 'Blair', serviceDate: '2026-08-04', status: 'open', clockInAt: 0, clockOutAt: null },
    { id: 'invalid', studentId: 'c', studentName: 'Casey', serviceDate: '2026-08-04', status: 'closed', clockInAt: hour, clockOutAt: 0 },
  ], [], rates);

  assert.equal(result.openSessionCount, 1);
  assert.equal(result.exceptionCount, 2);
  assert.equal(result.familyRows.length, 1);
  assert.equal(result.familyRows[0].totalAmountCents, 1000);
  assert.deepEqual(result.sessionRows.map((row) => row.included), [true, false, false]);
});

test('preserves archived family names and roster records for historical reports', () => {
  const result = aggregateAftercareReport([{
    id: 'session-1', studentId: 'a', studentName: 'Alex', familyId: 'archived', familyName: 'Former Family',
    serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour,
  }], [{ id: 'archived', name: 'Renamed Family', active: false, students: [{ studentId: 'a', name: 'Alex' }] }], rates);

  assert.equal(result.familyRows[0].familyName, 'Former Family');
  assert.equal(result.familyRows[0].familyStatus, 'archived');
  assert.deepEqual(result.familyRows[0].exceptions, ['Historical family is archived']);
  assert.deepEqual(result.familyRows[0].configuredStudents.map((student) => student.studentName), ['Alex']);
});

test('monthly account totals reconcile exactly to their daily rows', () => {
  const result = aggregateAftercareReport([
    { id: 'one', studentId: 'a', studentName: 'Alex', familyId: 'family', familyName: 'Example Family', serviceDate: '2026-08-04', status: 'closed', clockInAt: 0, clockOutAt: hour },
    { id: 'two', studentId: 'a', studentName: 'Alex', familyId: 'family', familyName: 'Example Family', serviceDate: '2026-08-05', status: 'closed', clockInAt: 0, clockOutAt: 2 * hour },
  ], [{ id: 'family', name: 'Example Family', active: true, students: [{ studentId: 'a', name: 'Alex' }] }], rates);

  const dailyTotal = result.dayRows.reduce((sum, row) => sum + row.totalAmountCents, 0);
  assert.equal(result.familyRows[0].days, 2);
  assert.equal(result.familyRows[0].totalAmountCents, dailyTotal);
  assert.equal(dailyTotal, 3000);
});

test('report days expose actual earliest check-in and earliest check-out', () => {
  const result = aggregateAftercareReport([
    { id: 'one', studentId: 'a', studentName: 'Alex', familyId: 'family', familyName: 'Example Family', serviceDate: '2026-08-04', status: 'closed', clockInAt: '2026-08-04T20:00:00.000Z', clockOutAt: '2026-08-04T22:00:00.000Z' },
    { id: 'two', studentId: 'b', studentName: 'Blair', familyId: 'family', familyName: 'Example Family', serviceDate: '2026-08-04', status: 'closed', clockInAt: '2026-08-04T20:04:00.000Z', clockOutAt: '2026-08-04T21:57:00.000Z' },
  ], [{ id: 'family', name: 'Example Family', active: true, studentIds: ['a', 'b'] }], rates);

  assert.equal(result.dayRows[0].firstClockInAt, '2026-08-04T20:00:00.000Z');
  assert.equal(result.dayRows[0].firstClockOutAt, '2026-08-04T21:57:00.000Z');
  assert.equal(result.dayRows[0].lastClockOutAt, '2026-08-04T22:00:00.000Z');
});