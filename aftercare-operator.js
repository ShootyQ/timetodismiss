import {
  init, onStudents, getClasses, onAftercareAttendance, getAftercareSettings,
  clockInAftercareStudent, clockOutAftercareStudent,
  getAftercareStudentTodaySessions, updateAftercareStudentTodaySession,
} from '/app.js?v=2026-09-10-operator-1';

const $ = (id) => document.getElementById(id);
const grid = $('acGrid');
const notice = $('acNotice');
const dialog = $('acStudentDialog');
const form = $('acTimeForm');
const fields = $('acTimeFields');
const visitSelect = $('acVisit');
const inInput = $('acInTime');
const outInput = $('acOutTime');
const state = {
  students: [], attendance: new Map(), pending: new Map(), classOrder: new Map(),
  query: '', classId: '', view: 'all', sort: 'last', timezone: 'America/Chicago',
  serviceDate: '', clockOffset: 0, attendanceReady: false,
};
let lifecycle = 0;
let activeKey = '';
let subscriptions = [];
let dayTimer;
let editor = null;
let suspended = false;

function nameOf(student) {
  return student.name || [student.firstName, student.lastName].filter(Boolean).join(' ') || student.id;
}
function nameParts(student) {
  const parts = nameOf(student).trim().split(/\s+/);
  return { first: student.firstName || parts[0] || '', last: student.lastName || parts.slice(1).join(' ') || parts[0] || '' };
}
function attendanceOf(student) {
  const row = state.attendance.get(student.id);
  return row?.serviceDate === state.serviceDate ? row : null;
}
function dateOf(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000 + (value.nanoseconds || 0) / 1e6);
  return new Date(value);
}
function timeOf(value, timezone = state.timezone) {
  try {
    const date = dateOf(value);
    return date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat([], { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(date) : '—';
  } catch { return '—'; }
}
function localTime(value, timezone) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(dateOf(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}
function serviceDateIn(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Date.now() + state.clockOffset));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function refreshToday() {
  if (!activeKey) return false;
  const today = serviceDateIn(state.timezone);
  $('acToday').textContent = `${today} · ${state.timezone} · School time`;
  if (today === state.serviceDate) return false;
  const previous = state.serviceDate;
  state.serviceDate = today;
  closeEditor();
  if (previous) notice.textContent = 'A new school day has started. Previous-day times are no longer editable here.';
  render();
  return true;
}
// Include update nanoseconds: earlier-visit corrections may change only updatedAt.
function attendanceFingerprint(student) {
  const row = attendanceOf(student);
  if (!row) return 'none';
  const stamp = (value) => value?.seconds !== undefined
    ? `${value.seconds}:${value.nanoseconds || 0}` : (dateOf(value)?.getTime() ?? null);
  return JSON.stringify([
    row.serviceDate, row.status, row.openSessionId, row.lastSessionId, row.intervalCount,
    stamp(row.clockedInAt), stamp(row.clockedOutAt), stamp(row.updatedAt),
  ]);
}
function compareNames(a, b, primary = 'last') {
  const left = nameParts(a); const right = nameParts(b);
  const first = primary === 'first' ? 'first' : 'last';
  const second = first === 'first' ? 'last' : 'first';
  return left[first].localeCompare(right[first]) || left[second].localeCompare(right[second]) || nameOf(a).localeCompare(nameOf(b));
}
function sortRows(a, b) {
  if (state.view === 'all') {
    const difference = Number(attendanceOf(a)?.status === 'in') - Number(attendanceOf(b)?.status === 'in');
    if (difference) return difference;
  }
  if (state.sort === 'grade') {
    return (state.classOrder.get(a.classId) ?? Number.MAX_SAFE_INTEGER) - (state.classOrder.get(b.classId) ?? Number.MAX_SAFE_INTEGER)
      || (a.className || a.classId || '').localeCompare(b.className || b.classId || '') || compareNames(a, b);
  }
  return compareNames(a, b, state.sort);
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function rosterButton(studentId, kind) {
  return [...grid.querySelectorAll('button')].find((button) => button.dataset.studentId === studentId && button.dataset.kind === kind);
}
function render() {
  if (editor && editor.fingerprint === undefined) updateActions(editor);
  const focused = grid.contains(document.activeElement) ? document.activeElement : null;
  const query = state.query.toLowerCase();
  const rows = state.students.filter((student) =>
    (!state.classId || student.classId === state.classId)
    && (!query || nameOf(student).toLowerCase().includes(query))
    && (attendanceOf(student) || !['picked_up', 'absent', 'dismissed', 'home'].includes(student.status))
    && (state.view !== 'checked-in' || attendanceOf(student)?.status === 'in')
  ).sort(sortRows);
  grid.replaceChildren();
  if (!rows.length) grid.append(element('div', 'ac-empty', 'No students match the current view.'));
  for (const student of rows) {
    const attendance = attendanceOf(student);
    const isIn = attendance?.status === 'in';
    const isOut = attendance?.status === 'out';
    const card = element('article', `ac-card ${isIn ? 'in' : isOut ? 'done' : student.status === 'waiting' ? '' : 'called'}`);
    const times = element('div', 'ac-card-times');
    for (const [label, value] of [['IN', attendance?.clockedInAt], ['OUT', isOut ? attendance.clockedOutAt : null]]) {
      const corner = element('div', 'ac-card-time');
      corner.append(element('small', '', label), element('span', '', timeOf(value)));
      times.append(corner);
    }
    const top = element('div', 'ac-card-top');
    const heading = element('div');
    const title = element('h2', 'ac-name', nameOf(student));
    heading.append(title, element('p', '', student.className || student.classId || ''));
    top.append(heading, element('span', 'ac-status', isIn ? 'Checked in' : isOut ? 'Checked out' : student.status || 'Ready'));
    card.append(times, top);
    if (Number(attendance?.intervalCount) > 1) card.append(element('span', 'ac-visit-count', `Visit ${attendance.intervalCount}`));
    const button = element('button', 'ac-button', state.pending.has(student.id) ? 'Please wait…' : isIn ? 'Clock out' : isOut ? 'Check in again' : 'Clock in');
    button.type = 'button';
    button.dataset.studentId = student.id;
    button.dataset.kind = 'clock';
    button.disabled = state.pending.has(student.id) || !state.attendanceReady;
    button.setAttribute('aria-label', `${button.textContent}: ${nameOf(student)}`);
    button.addEventListener('click', () => openActions(student, button));
    card.append(button);
    grid.append(card);
  }
  if (focused) (rosterButton(focused.dataset.studentId, focused.dataset.kind) || $('acSearch')).focus({ preventScroll: true });
}

async function executeClockAction(student) {
  if (!activeKey || !state.attendanceReady || state.pending.has(student.id)) return;
  if (refreshToday()) return;
  const out = attendanceOf(student)?.status === 'in';
  const expectedSessionId = attendanceOf(student)?.openSessionId;
  const generation = lifecycle;
  const pending = {};
  state.pending.set(student.id, pending);
  render();
  notice.textContent = `${out ? 'Clocking out' : 'Checking in'} ${nameOf(student)}…`;
  try {
    const result = await (out ? clockOutAftercareStudent(student.id, expectedSessionId) : clockInAftercareStudent(student.id));
    if (generation !== lifecycle) return;
    if (!result?.ok) throw new Error('The server did not confirm the action. Check attendance before retrying.');
    notice.textContent = result.alreadyOpen ? `${nameOf(student)} is already checked in. No new visit was created.`
      : result.alreadyClosed ? `${nameOf(student)} is already checked out. No new checkout was recorded.`
        : `${nameOf(student)} was ${out ? 'clocked out' : 'checked in'}.`;
  } catch (error) {
    if (generation === lifecycle) notice.textContent = error?.message || 'The action could not be confirmed. Check attendance before retrying.';
  } finally {
    if (generation === lifecycle && state.pending.get(student.id) === pending) {
      state.pending.delete(student.id);
      render();
    }
  }
}

function current(e) { return editor === e && dialog.open && e.lifecycle === lifecycle; }
function selectedVisit(e) { return e.sessions?.find((visit) => visit.id === e.selectedId); }
function isDirty(e) {
  const visit = selectedVisit(e);
  return !!visit && (inInput.value !== localTime(visit.clockInAt, e.timezone) || outInput.value !== localTime(visit.clockOutAt, e.timezone));
}
function message(text, error = false) {
  $('acEditorMessage').textContent = text;
  $('acEditorMessage').dataset.error = String(error);
}
function editorControls(e) {
  if (!current(e)) return;
  fields.disabled = e.loading || e.saving || e.stale || e.awaitingAttendance || !state.attendanceReady;
  $('acReloadVisits').disabled = e.loading || e.saving || !state.attendanceReady;
  $('acDialogClose').disabled = !!e.saving;
  $('acDialogClose').textContent = e.saving ? 'Saving…' : 'Cancel';
  $('acEditor').setAttribute('aria-busy', String(!!(e.loading || e.saving)));
}
function invalidateEditor(e, text = 'Attendance changed while this editor was open. Your inputs were kept. Reload today’s visits before saving.') {
  if (!current(e)) return;
  e.stale = true;
  message(text, true);
  editorControls(e);
}
function closeEditor() {
  const previous = editor;
  editor = null;
  if (dialog.open) dialog.close();
  if (previous) {
    const target = (previous.returnFocus?.isConnected ? previous.returnFocus : rosterButton(previous.student.id, 'clock')) || $('acSearch');
    target.focus({ preventScroll: true });
  }
}
function updateActions(e) {
  const attendance = attendanceOf(e.student);
  const isIn = attendance?.status === 'in';
  const isOut = attendance?.status === 'out';
  const firstName = nameParts(e.student).first || nameOf(e.student);

  const actionLabel = isIn
    ? `Clock out ${firstName}`
    : isOut
      ? `Check in ${firstName} again`
      : `Clock in ${firstName}`;

  $('acConfirmClock').textContent = actionLabel;
  $('acConfirmClock').disabled = !state.attendanceReady || state.pending.has(e.student.id);
  $('acConfirmClock').onclick = async () => {
    closeEditor();
    await executeClockAction(e.student);
  };

  let statusDesc = `${state.serviceDate} · ${state.timezone} (school time). `;
  if (isIn) {
    statusDesc += `Checked in since ${timeOf(attendance.clockedInAt, e.timezone)}.`;
  } else if (isOut) {
    statusDesc += `Completed visit at ${timeOf(attendance.clockedOutAt, e.timezone)}.`;
  } else {
    statusDesc += `Ready to clock in today.`;
  }
  $('acDialogContext').textContent = statusDesc;
  $('acEditTimes').disabled = !attendance || !state.attendanceReady || state.pending.has(e.student.id);
}
function openActions(student, returnFocus) {
  if (!activeKey || editor?.saving) return;
  refreshToday();
  closeEditor();
  editor = {
    student, returnFocus, lifecycle, serviceDate: state.serviceDate, timezone: state.timezone,
    request: 0, loading: false, saving: false, stale: false, sessions: [],
  };
  $('acDialogTitle').textContent = nameOf(student);
  $('acActionConfirm').hidden = false;
  $('acEditTimes').onclick = () => {
    $('acActionConfirm').hidden = true;
    if (editor) void loadVisits(editor);
  };
  updateActions(editor);
  $('acEditor').hidden = true;
  form.hidden = true;
  $('acDialogClose').disabled = false;
  $('acDialogClose').textContent = 'Cancel';
  message('');
  dialog.showModal();
}
function editorError(error) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  if (['not-found', 'unimplemented', 'unavailable', 'internal'].includes(code)) {
    return 'Time editing is unavailable or could not be reached. Retry loading, or ask an administrator to verify the operator time-editing service is deployed. Normal check-in/out remains available.';
  }
  if (['aborted', 'failed-precondition'].includes(code)) {
    return `${error?.message || 'The visit or school day has changed.'} Reload today’s visits before trying again.`;
  }
  if (['permission-denied', 'unauthenticated'].includes(code)) return 'Time editing was not authorized. Sign in again or ask an administrator to check your aftercare access.';
  return error?.message || 'Could not load or save times. Retry loading; normal check-in/out is still available.';
}
function validateResponse(result, e) {
  if (!result?.ok || !Array.isArray(result.sessions) || !/^\d{4}-\d{2}-\d{2}$/.test(result.serviceDate)
    || !result.timezone || !Number.isFinite(Date.parse(result.serverNow))) throw new Error('The time-editing service returned an unsupported response. Ask an administrator to verify the service version. Normal check-in/out is still available.');
  // Fail closed rather than submit an unversioned or other-student visit.
  if (result.sessions.some((visit) => !visit.id || visit.studentId !== e.student.id || visit.serviceDate !== result.serviceDate
    || !visit.revision || typeof visit.revision !== 'string' || !['open', 'closed'].includes(visit.status)
    || !Number.isFinite(Date.parse(visit.clockInAt))
    || (visit.status === 'closed' && !Number.isFinite(Date.parse(visit.clockOutAt)))
    || (visit.status === 'open' && visit.clockOutAt !== null))) throw new Error('Some visit details are incomplete. Reload, or ask an administrator to review this student’s attendance.');
  serviceDateIn(result.timezone); // Validate the supplied IANA zone before using it.
}
async function loadVisits(e, successMessage = '') {
  if (!current(e) || e.saving || !state.attendanceReady || state.pending.has(e.student.id)) return;
  if (refreshToday() || !current(e)) return;
  const moveFocus = document.activeElement === $('acEditTimes') || document.activeElement === $('acReloadVisits')
    || fields.contains(document.activeElement);
  const request = ++e.request;
  const fingerprint = attendanceFingerprint(e.student);
  e.fingerprint = fingerprint;
  e.loading = true;
  e.stale = false;
  $('acActionConfirm').hidden = true;
  $('acEditTimes').hidden = true;
  $('acEditor').hidden = false;
  message(successMessage ? `${successMessage} Refreshing visits…` : 'Loading today’s visits…');
  editorControls(e);
  if (moveFocus) $('acEditorMessage').focus();
  try {
    const result = await getAftercareStudentTodaySessions(e.student.id);
    if (!current(e) || request !== e.request) return;
    validateResponse(result, e);
    state.clockOffset = Date.parse(result.serverNow) - Date.now();
    state.timezone = result.timezone;
    if (refreshToday() || !current(e)) return;
    if (result.serviceDate !== state.serviceDate || e.serviceDate !== result.serviceDate) {
      invalidateEditor(e, 'The school day changed. Close this dialog and open today’s student actions again.');
      return;
    }
    if (e.stale || attendanceFingerprint(e.student) !== fingerprint) {
      invalidateEditor(e);
      return;
    }
    e.timezone = result.timezone;
    e.sessions = [...result.sessions].sort((a, b) => Date.parse(a.clockInAt) - Date.parse(b.clockInAt) || a.id.localeCompare(b.id));
    $('acDialogContext').textContent = `${result.serviceDate} · ${result.timezone} (school time). Only today’s visits can be corrected.`;
    visitSelect.replaceChildren();
    e.sessions.forEach((visit, index) => {
      const option = element('option', '', `Visit ${index + 1} · ${timeOf(visit.clockInAt, e.timezone)} – ${visit.status === 'open' ? 'Open' : timeOf(visit.clockOutAt, e.timezone)}`);
      option.value = visit.id;
      visitSelect.append(option);
    });
    const selected = e.sessions.find((visit) => visit.id === e.selectedId) || e.sessions.at(-1);
    form.hidden = !selected;
    if (selected) selectVisit(e, selected.id);
    message(e.awaitingAttendance ? 'Saved. Waiting for live attendance to synchronize before another edit. You can also reload today’s visits.'
      : successMessage || (selected ? 'Choose a visit, review the preview, then save.' : 'No visits recorded today. Close this dialog and use Clock in to start a visit.'));
    render(); // Server-supplied school timezone also applies to the cards.
  } catch (error) {
    if (current(e) && request === e.request) invalidateEditor(e, `${successMessage ? `${successMessage} ` : ''}${editorError(error)}`);
  } finally {
    if (current(e) && request === e.request) {
      e.loading = false;
      editorControls(e);
      if (document.activeElement === $('acEditorMessage')) {
        (!fields.disabled && !form.hidden ? visitSelect : $('acReloadVisits')).focus();
      }
    }
  }
}
function selectVisit(e, id) {
  const visit = e.sessions.find((row) => row.id === id);
  if (!visit) return;
  e.selectedId = id;
  visitSelect.value = id;
  inInput.value = localTime(visit.clockInAt, e.timezone);
  outInput.value = localTime(visit.clockOutAt, e.timezone);
  outInput.required = visit.status === 'closed';
  const index = e.sessions.indexOf(visit) + 1;
  $('acVisitContext').textContent = `Visit ${index} · ${visit.status === 'open' ? 'Open / checked in' : 'Closed'} · ${e.serviceDate} · ${e.timezone}${visit.autoCloseAt ? ` · Cutoff ${timeOf(visit.autoCloseAt, e.timezone)}` : ''}`;
  $('acBefore').textContent = `Before: IN ${timeOf(visit.clockInAt, e.timezone)} · OUT ${visit.status === 'open' ? '— (still open)' : timeOf(visit.clockOutAt, e.timezone)}.`;
  $('acTimeHelp').textContent = visit.status === 'open'
    ? 'Use school-local times for the displayed date. Leave OUT blank to keep this visit open. Entering OUT checks the student out.'
    : 'Both IN and OUT are required. A closed visit cannot be reopened: use Check in again on the student card for a new visit.';
  updatePreview();
}
function updatePreview() {
  const e = editor;
  const visit = e && selectedVisit(e);
  if (!visit) return;
  const changed = isDirty(e);
  const effect = visit.status === 'open'
    ? outInput.value ? 'This closes the open visit and checks the student out.' : 'This visit stays open; the student remains checked in.'
    : 'This visit stays closed. Other visits and the student’s current check-in status do not change.';
  $('acSavePreview').textContent = `${e.serviceDate} · ${e.timezone}: IN ${inInput.value || 'required'} → OUT ${outInput.value || (visit.status === 'open' ? 'blank (open)' : 'required')}. ${effect} ${changed ? 'Only this visit’s times will be corrected. Billing will use the corrected times.' : 'No time changes selected; saving unchanged values makes no correction.'}`;
}
async function saveTimes(event) {
  event.preventDefault();
  const e = editor;
  if (!e || !current(e) || e.loading || e.saving || e.stale || e.awaitingAttendance || !state.attendanceReady || state.pending.has(e.student.id)) return;
  if (refreshToday() || !current(e)) return;
  if (attendanceFingerprint(e.student) !== e.fingerprint) { invalidateEditor(e); return; }
  const visit = selectedVisit(e);
  if (!visit || !form.reportValidity()) return;
  const clockInLocal = inInput.value;
  const clockOutLocal = outInput.value || null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clockInLocal)
    || (clockOutLocal !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(clockOutLocal))) {
    message('Enter valid IN and OUT times in hours and minutes.', true); return;
  }
  if (visit.status === 'closed' && !clockOutLocal) { message('A closed visit requires an OUT time. Use Check in again for a new visit.', true); return; }
  // The server validates ordering, future/cutoff, overlap and DST. Comparing
  // displayed minutes here would reject valid unchanged sub-minute visits.
  if (visit.status === 'open' && clockOutLocal
    && !confirm(`Check out ${nameOf(e.student)} by closing this visit at ${clockOutLocal} on ${e.serviceDate} (${e.timezone})? Saving changes attendance and may change billing.`)) return;
  // Native confirmation can stay open across midnight; validate again before sending.
  if (refreshToday() || !current(e)) return;
  if (attendanceFingerprint(e.student) !== e.fingerprint) { invalidateEditor(e); return; }
  const fingerprint = e.fingerprint;
  e.saving = true;
  state.pending.set(e.student.id, e);
  editorControls(e);
  render();
  message('Saving corrected times…');
  $('acEditorMessage').focus();
  let savedMessage = '';
  try {
    const result = await updateAftercareStudentTodaySession({
      studentId: e.student.id, sessionId: visit.id, expectedRevision: visit.revision,
      expectedServiceDate: e.serviceDate, clockInLocal, clockOutLocal,
    });
    if (e.lifecycle !== lifecycle) return;
    if (!result?.ok) throw new Error('The server did not confirm this save. Reload visits to check the result before retrying.');
    savedMessage = result.unchanged ? 'No changes were needed.' : 'Corrected times saved.';
    notice.textContent = `${nameOf(e.student)}: ${savedMessage}`;
    if (!current(e)) return;
    // The response and Firestore snapshot may arrive in either order. Until the
    // projection catches up, do not allow edits based on a pre-save snapshot.
    e.awaitingAttendance = !result.unchanged && attendanceFingerprint(e.student) === fingerprint;
  } catch (error) {
    if (current(e)) {
      const code = String(error?.code || '');
      if (attendanceFingerprint(e.student) !== fingerprint || !code.endsWith('invalid-argument')) {
        invalidateEditor(e, `${editorError(error)} Reload visits before another save.`);
      } else message(editorError(error), true);
    } else if (e.lifecycle === lifecycle) notice.textContent = `${nameOf(e.student)}: ${editorError(error)}`;
  } finally {
    e.saving = false;
    if (state.pending.get(e.student.id) === e) state.pending.delete(e.student.id);
    if (e.lifecycle === lifecycle) render();
    if (current(e)) editorControls(e);
  }
  if (savedMessage && current(e)) await loadVisits(e, savedMessage);
}

$('acEditTimes').addEventListener('click', () => { if (editor) void loadVisits(editor); });
$('acReloadVisits').addEventListener('click', () => {
  if (!editor || editor.loading || editor.saving) return;
  if (isDirty(editor) && !confirm('Discard unsaved time changes and reload today’s visits?')) return;
  void loadVisits(editor);
});
visitSelect.addEventListener('change', () => {
  const e = editor;
  if (!e || e.loading || e.saving || e.stale || e.awaitingAttendance) return;
  const next = visitSelect.value;
  if (isDirty(e) && !confirm('Discard unsaved changes to this visit and select another visit?')) {
    visitSelect.value = e.selectedId;
    return;
  }
  selectVisit(e, next);
});
inInput.addEventListener('input', updatePreview);
outInput.addEventListener('input', updatePreview);
form.addEventListener('submit', saveTimes);
$('acDialogClose').addEventListener('click', () => { if (!editor?.saving) closeEditor(); });
dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (!editor?.saving) closeEditor(); });

function attendanceChanged(rows) {
  state.attendance = new Map(rows.map((row) => [row.id, row]));
  state.attendanceReady = true;
  refreshToday();
  const e = editor;
  if (e && !e.saving && e.fingerprint !== undefined && attendanceFingerprint(e.student) !== e.fingerprint) {
    if (e.awaitingAttendance) {
      e.awaitingAttendance = false;
      void loadVisits(e, 'Corrected times saved.');
    } else invalidateEditor(e);
  }
  render();
}
function stop() {
  lifecycle++;
  activeKey = '';
  subscriptions.forEach((unsubscribe) => unsubscribe());
  subscriptions = [];
  clearInterval(dayTimer);
  closeEditor();
  state.pending.clear();
  state.attendanceReady = false;
}
async function bootstrap(claims) {
  if (suspended) return;
  if (!claims || !(claims.owner || claims.superintendent || claims.admin || claims.caller || claims.viewer)) {
    stop(); location.replace('/index.html#login'); return;
  }
  $('acManage').hidden = !(claims.owner || claims.superintendent || claims.admin);
  const key = JSON.stringify([window.SD?.orgId || claims.orgId, window.SD?.schoolId || claims.schoolId,
    ...['owner', 'superintendent', 'admin', 'caller', 'viewer'].map((role) => !!claims[role])]);
  if (activeKey === key) { refreshToday(); return; }
  stop();
  activeKey = key;
  const generation = lifecycle;
  state.students = [];
  state.attendance.clear();
  state.classOrder.clear();
  state.serviceDate = '';
  state.clockOffset = 0;
  state.classId = '';
  $('acClass').replaceChildren(element('option', '', 'All classes'));
  $('acClass').firstElementChild.value = '';
  notice.textContent = 'Loading aftercare…';
  grid.setAttribute('aria-busy', 'true');
  render();
  try {
    await init();
    if (generation !== lifecycle) return;
    const [classes, settings] = await Promise.all([getClasses(), getAftercareSettings()]);
    if (generation !== lifecycle) return;
    state.timezone = settings.timezone;
    refreshToday();
    classes.forEach((item, index) => {
      state.classOrder.set(item.id, item.order ?? index);
      const option = element('option', '', item.name || item.id);
      option.value = item.id;
      $('acClass').append(option);
    });
    subscriptions.push(onStudents(null, (students) => {
      if (generation !== lifecycle) return;
      state.students = students;
      render();
    }));
    subscriptions.push(onAftercareAttendance((rows) => {
      if (generation !== lifecycle) return;
      const first = !state.attendanceReady;
      attendanceChanged(rows);
      grid.setAttribute('aria-busy', 'false');
      if (first) notice.textContent = 'Ready. All times are shown in the school timezone.';
    }, (error) => {
      if (generation !== lifecycle) return;
      state.attendanceReady = false;
      grid.setAttribute('aria-busy', 'false');
      notice.textContent = `Live attendance is unavailable. Reload this page before making changes. ${error?.message || ''}`;
      if (editor) invalidateEditor(editor, 'Live attendance is unavailable. Reload the page before editing times.');
      render();
    }));
    dayTimer = setInterval(refreshToday, 30000);
  } catch (error) {
    if (generation !== lifecycle) return;
    stop();
    grid.setAttribute('aria-busy', 'false');
    notice.textContent = error?.message || 'Aftercare could not be loaded. Reload this page to retry.';
  }
}
$('acSearch').addEventListener('input', () => { state.query = $('acSearch').value.trim(); render(); });
$('acClass').addEventListener('change', () => { state.classId = $('acClass').value; render(); });
$('acSort').addEventListener('change', () => { state.sort = $('acSort').value; render(); });
for (const [id, view] of [['acViewAll', 'all'], ['acViewCheckedIn', 'checked-in']]) {
  $(id).addEventListener('click', () => {
    state.view = view;
    $('acViewAll').setAttribute('aria-pressed', String(view === 'all'));
    $('acViewCheckedIn').setAttribute('aria-pressed', String(view === 'checked-in'));
    render();
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshToday(); });
document.addEventListener('sd:claims-ready', (event) => {
  const detail = event.detail;
  void bootstrap(detail && Object.hasOwn(detail, 'claims') ? detail.claims : detail);
});
window.addEventListener('pagehide', () => { suspended = true; stop(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { suspended = false; void bootstrap(window.SD?.claims || window.SD?.userClaims); }
});
window.initAppWithClaims = bootstrap;
const claims = window.SD?.claims || window.SD?.userClaims;
if (claims) void bootstrap(claims);