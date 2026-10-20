const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '' });
    return nodes.get(id);
  };
  let resolve, reject;
  const request = new Promise((yes, no) => { resolve = yes; reject = no; });
  let calls = 0;
  const timers = new Map();
  let timerId = 0;
  let source = fs.readFileSync(path.join(__dirname, '../../aftercare-operator.js'), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+';/, '');
  const listener = source.slice(source.indexOf('function attendanceChanged(rows)'), source.indexOf('function stop()'));
  source = source.slice(0, source.indexOf("$('acEditTimes').addEventListener"));
  const context = vm.createContext({
    document: { getElementById: getNode }, console,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    clockOutAftercareStudent() { calls++; return request; },
    clockInAftercareStudent() { calls++; return request; },
  });
  vm.runInContext(source + listener + `
    render = () => {}; refreshToday = () => false;
    activeKey = 'school'; state.attendanceReady = true; state.serviceDate = '2026-10-20';
    const student = { id: 'student', name: 'Example Student' };
    state.attendance.set(student.id, { serviceDate: state.serviceDate, status: 'in', openSessionId: 'visit' });
    globalThis.probe = { state, run: () => executeClockAction(student),
      update: (status, openSessionId) => attendanceChanged([{ id: student.id, serviceDate: state.serviceDate, status, openSessionId }]) };
  `, context);
  return { ...context.probe, resolve, reject, timers, calls: () => calls, notice: getNode('acNotice') };
}

for (const updateFirst of [false, true]) {
  test(`checkout remains pending until both response and attendance arrive (update first: ${updateFirst})`, async () => {
    const h = harness();
    const action = h.run();
    assert.match(h.state.pending.get('student').label, /Clocking out/);
    if (updateFirst) {
      h.update('out', null);
      assert.ok(h.state.pending.has('student'));
    }
    h.resolve({ ok: true, sessionId: 'visit' });
    await action;
    if (!updateFirst) {
      assert.match(h.state.pending.get('student').label, /Saved/);
      await h.run();
      assert.equal(h.calls(), 1, 'a delayed card cannot send a duplicate request');
      h.update('in', 'visit');
      assert.ok(h.state.pending.has('student'), 'unchanged attendance does not unlock the card');
      h.update('out', null);
    }
    assert.equal(h.state.pending.size, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('slow checkout warns without claiming success or resending', async () => {
  const h = harness();
  const action = h.run();
  for (const fn of h.timers.values()) fn();
  assert.match(h.state.pending.get('student').label, /Still waiting/);
  assert.match(h.notice.textContent, /before retrying/);
  await h.run();
  assert.equal(h.calls(), 1);
  h.resolve({ ok: true });
  await action;
  h.update('out', null);
  assert.equal(h.state.pending.size, 0);
});

test('failed checkout reports the error and clears the waiting timer', async () => {
  const h = harness();
  const action = h.run();
  h.reject(new Error('Connection lost. Check attendance before retrying.'));
  await action;
  assert.match(h.notice.textContent, /Connection lost/);
  assert.equal(h.state.pending.size, 0);
  assert.equal(h.timers.size, 0);
});
