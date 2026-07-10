const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const {
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
  const result = calculateFamilyDay([
    { studentId: 'a', clockInAt: 0, clockOutAt: 1 },
    { studentId: 'b', clockInAt: 0, clockOutAt: 1 },
    { studentId: 'a', clockInAt: 2, clockOutAt: 3 },
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