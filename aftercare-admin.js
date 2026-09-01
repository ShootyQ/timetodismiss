import {
  init,
  onStudents,
  getAftercareAdminData,
  saveAftercareSettings,
  saveAftercareFamily,
  archiveAftercareFamily,
  getAftercareReport,
  getAftercareDaySessions,
  updateAftercareSession,
  deleteAftercareSession,
} from '/app.js?v=aftercare-3';

await init();

const state = {
  students: [], families: [], settings: null, serviceDate: '', sessions: [],
  report: null, reportMonth: '', expandedAccount: null, editingFamilyId: null,
};
const elements = Object.fromEntries(Array.from(document.querySelectorAll('[id]')).map((element) => [element.id, element]));
const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const hours = (value) => Number(value || 0).toFixed(2);
const durationLabel = (milliseconds) => { const minutes = Math.round(Number(milliseconds || 0) / 60000); return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`; };
const schoolName = () => window.SD?.schoolName || window.SD?.schoolId || 'School';
const nameList = (students) => (students || []).map((student) => student.studentName || student.name || student.studentId).join(', ') || 'None';
const billedStudents = (row) => row.billedStudents || row.students || [];
const billedStudentDetails = (row) => billedStudents(row).map((student) => `${student.studentName || student.name || student.studentId}${student.duration ? ` (${student.duration})` : ''}`).join(', ') || 'None';
const reportDays = () => state.report?.dayRows || [];
const reportSessions = () => state.report?.sessionRows || [];
const daySessions = (day) => reportSessions().filter((session) => session.familyKey === day.familyKey && session.serviceDate === day.serviceDate && session.included !== false);
const dayFirstIn = (day) => day.firstClockInAt || daySessions(day).map((session) => session.clockInAt).filter(Boolean).sort()[0] || null;
const dayBilledOut = (day) => day.firstClockOutAt || daySessions(day).map((session) => session.clockOutAt).filter(Boolean).sort()[0] || null;
const localInputValue = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const formatTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: state.settings?.timezone }) : '—';
const formatDate = (isoDate) => new Date(`${isoDate}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const formatMonth = (month) => new Date(`${month}-01T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' });
const elapsed = (session) => {
  if (!session.clockInAt) return '—';
  const end = session.clockOutAt ? new Date(session.clockOutAt) : new Date();
  const minutes = Math.max(0, Math.round((end - new Date(session.clockInAt)) / 60000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

function setNotice(message = '', error = false) {
  elements.acNotice.textContent = message;
  elements.acNotice.classList.toggle('error', error);
}
function clear(element) { element.replaceChildren(); }
function cell(text, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}
function button(label, action, className = 'secondary small') {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = `ac-button ${className}`;
  control.textContent = label;
  control.addEventListener('click', action);
  return control;
}
function emptyRow(body, columns, message) {
  const row = document.createElement('tr');
  const td = cell(message, 'ac-empty');
  td.colSpan = columns;
  row.append(td);
  body.append(row);
}
function isOverdue(session) {
  return session.status === 'open' && session.autoCloseAt && new Date(session.autoCloseAt) < new Date();
}

function normalizeReport(report) {
  const schemaVersion = Number(report.reportSchemaVersion || 0);
  if (schemaVersion >= 4) {
    return { ...report, dayRows: report.dayRows || [], familyRows: report.familyRows || [], sessionRows: report.sessionRows || [], exceptionCount: report.exceptionCount || 0 };
  }
  if (schemaVersion === 3) {
    const sessionRows = report.sessionRows || [];
    const dayRows = (report.dayRows || []).map((day) => {
      const sessions = sessionRows.filter((session) => session.familyKey === day.familyKey && session.serviceDate === day.serviceDate && session.included !== false);
      const clockIns = sessions.map((session) => session.clockInAt).filter(Boolean).sort();
      const clockOuts = sessions.map((session) => session.clockOutAt).filter(Boolean).sort();
      return { ...day, firstClockInAt: day.firstClockInAt || clockIns[0] || null, firstClockOutAt: day.firstClockOutAt || clockOuts[0] || null };
    });
    return { ...report, dayRows, familyRows: report.familyRows || [], sessionRows, exceptionCount: report.exceptionCount || 0 };
  }
  const familyById = new Map(state.families.map((family) => [family.id, family]));
  const familyByStudentId = new Map();
  const familyByStudentName = new Map();
  const familyByName = new Map();
  for (const family of state.families) {
    familyByName.set(String(family.name || '').trim().toLowerCase(), family);
    const ids = family.studentIds || (family.students || []).map((student) => student.studentId || student.id);
    for (const studentId of ids) if (studentId) familyByStudentId.set(studentId, family);
    for (const student of family.students || []) {
      const studentName = String(student.name || student.studentName || '').trim().toLowerCase();
      if (studentName) familyByStudentName.set(studentName, family);
    }
  }
  const normalizedDays = (report.dayRows || []).map((day) => {
    const students = billedStudents(day);
    const inferredFamily = !day.familyId ? familyByName.get(String(day.familyName || '').trim().toLowerCase()) || (students.length === 1 ? familyByStudentId.get(students[0].studentId) || familyByStudentName.get(String(students[0].studentName || students[0].name || '').trim().toLowerCase()) : null) : null;
    const familyId = day.familyId || inferredFamily?.id || null;
    return {
      ...day,
      sourceFamilyKey: day.familyKey,
      familyId,
      familyKey: familyId || day.familyKey || `student:${students[0]?.studentId || day.familyName}`,
      familyName: day.familyName || inferredFamily?.name || students[0]?.studentName,
      accountType: familyId ? 'family' : 'student',
      billedStudents: students,
    };
  });
  const normalizedFamilies = (report.familyRows || []).map((account) => {
    const matchingDays = normalizedDays.filter((day) => day.sourceFamilyKey === account.familyKey || day.familyKey === account.familyKey || (account.familyId && day.familyId === account.familyId));
    const studentMap = new Map();
    const summaryStudents = billedStudents(account);
    const studentSources = summaryStudents.length ? summaryStudents : matchingDays.flatMap((day) => billedStudents(day));
    for (const student of studentSources) {
      if (!student?.studentId && !student?.studentName) continue;
      const key = student.studentId || student.studentName;
      const existing = studentMap.get(key) || { ...student, milliseconds: 0, days: 0 };
      existing.milliseconds += Number(student.milliseconds || 0);
      existing.days += Number(student.days || (summaryStudents.length ? 0 : 1));
      existing.duration = existing.duration || student.duration;
      studentMap.set(key, existing);
    }
    const inferredStudent = Array.from(studentMap.values())[0];
    const inferredFamily = !account.familyId ? familyByName.get(String(account.familyName || '').trim().toLowerCase()) || (studentMap.size === 1 ? familyByStudentId.get(inferredStudent.studentId) || familyByStudentName.get(String(inferredStudent.studentName || inferredStudent.name || '').trim().toLowerCase()) : null) : null;
    const familyId = account.familyId || inferredFamily?.id || null;
    const configuredFamily = familyId ? familyById.get(familyId) : null;
    return {
      ...account,
      familyId,
      familyKey: familyId || account.familyKey,
      familyName: inferredFamily?.name || account.familyName,
      accountType: familyId ? 'family' : 'student',
      billedStudents: Array.from(studentMap.values()),
      configuredStudents: account.configuredStudents?.length ? account.configuredStudents : (configuredFamily?.students || []).map((student) => ({ studentId: student.studentId || student.id, studentName: student.name || student.studentName || student.studentId || student.id })),
      exceptions: account.exceptions || [],
    };
  });
  const accountsByKey = new Map();
  for (const account of normalizedFamilies) {
    const key = account.familyId || account.familyKey;
    if (!accountsByKey.has(key)) accountsByKey.set(key, {
      ...account,
      singleMilliseconds: 0,
      familyMilliseconds: 0,
      singleAmountCents: 0,
      familyAmountCents: 0,
      totalAmountCents: 0,
      billedStudentsById: new Map(),
      exceptions: [],
    });
    const merged = accountsByKey.get(key);
    merged.singleMilliseconds += Number(account.singleMilliseconds || Number(account.singleDecimalHours || 0) * 3600000);
    merged.familyMilliseconds += Number(account.familyMilliseconds || Number(account.familyDecimalHours || 0) * 3600000);
    merged.singleAmountCents += Number(account.singleAmountCents || 0);
    merged.familyAmountCents += Number(account.familyAmountCents || 0);
    merged.totalAmountCents += Number(account.totalAmountCents || 0);
    merged.exceptions.push(...account.exceptions);
    for (const student of billedStudents(account)) {
      const studentKey = student.studentId || student.studentName;
      const existing = merged.billedStudentsById.get(studentKey) || { ...student, milliseconds: 0, days: 0 };
      existing.milliseconds += Number(student.milliseconds || 0);
      existing.days += Number(student.days || 0);
      merged.billedStudentsById.set(studentKey, existing);
    }
  }
  const familyRows = Array.from(accountsByKey.values()).map(({ billedStudentsById, ...account }) => {
    const attendanceDates = new Set(normalizedDays.filter((day) => day.familyKey === account.familyKey).map((day) => day.serviceDate));
    const students = Array.from(billedStudentsById.values()).map((student) => ({ ...student, duration: durationLabel(student.milliseconds) }));
    return {
      ...account,
      days: attendanceDates.size || account.days,
      students,
      billedStudents: students,
      singleDuration: durationLabel(account.singleMilliseconds),
      singleDecimalHours: account.singleMilliseconds / 3600000,
      familyDuration: durationLabel(account.familyMilliseconds),
      familyDecimalHours: account.familyMilliseconds / 3600000,
      exceptions: Array.from(new Set(account.exceptions)),
    };
  });
  return { ...report, dayRows: normalizedDays, familyRows, sessionRows: report.sessionRows || [], exceptionCount: report.exceptionCount || 0 };
}
function sessionMatches(session, search, status) {
  const haystack = `${session.studentName || ''} ${session.familyName || ''} ${session.classId || ''}`.toLowerCase();
  if (search && !haystack.includes(search.toLowerCase())) return false;
  if (status === 'overdue') return isOverdue(session);
  return !status || status === 'all' || session.status === status;
}

async function loadAdmin() {
  const data = await getAftercareAdminData();
  state.settings = data.settings;
  state.families = data.families || [];
  state.serviceDate = data.serviceDate || new Date().toISOString().slice(0, 10);
  elements.sessionDate.value = state.serviceDate;
  elements.reportMonth.value = data.billingMonth || state.serviceDate.slice(0, 7);
  elements.overviewDate.textContent = `${formatDate(state.serviceDate)} · cutoff ${state.settings.cutoffLocalTime} ${state.settings.timezone}`;
  fillSettings();
  renderStudentOptions();
  renderFamilies();
}

async function loadOverview() {
  setNotice('Refreshing today’s operations…');
  try {
    const [sessionsData, report] = await Promise.all([
      getAftercareDaySessions(state.serviceDate),
      getAftercareReport({ mode: 'daily', period: state.serviceDate }),
    ]);
    state.sessions = sessionsData.sessions || [];
    renderOverview(report);
    renderSessionReview();
    setNotice(`Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  } catch (error) {
    setNotice(error?.message || 'Could not refresh today’s operations.', true);
  }
}

function renderOverview(report) {
  const open = state.sessions.filter((session) => session.status === 'open').length;
  const overdue = state.sessions.filter(isOverdue).length;
  const closed = state.sessions.filter((session) => session.status !== 'open').length;
  const totalDue = (report.familyRows || []).reduce((sum, row) => sum + Number(row.totalAmountCents || 0), 0);
  elements.metricOpen.textContent = open;
  elements.metricClosed.textContent = closed;
  elements.metricOverdue.textContent = overdue;
  elements.metricAutoClosed.textContent = report.autoClosedCount || 0;
  elements.metricSessions.textContent = state.sessions.length;
  elements.metricDue.textContent = money(totalDue);
  elements.metricOverdue.closest('.ac-metric').classList.toggle('alert', overdue > 0);
  renderOverviewRows();
}

function renderOverviewRows() {
  const search = elements.overviewSearch.value.trim();
  const status = elements.overviewStatus.value;
  const rows = state.sessions.filter((session) => sessionMatches(session, search, status))
    .sort((left, right) => Number(isOverdue(right)) - Number(isOverdue(left)) || String(left.clockInAt || '').localeCompare(String(right.clockInAt || '')));
  clear(elements.overviewBody);
  if (!rows.length) return emptyRow(elements.overviewBody, 7, 'No sessions match these filters.');
  for (const session of rows) {
    const row = document.createElement('tr');
    const student = cell('');
    const primary = document.createElement('div'); primary.className = 'ac-primary'; primary.textContent = session.studentName;
    const secondary = document.createElement('div'); secondary.className = 'ac-secondary'; secondary.textContent = session.classId || 'No class';
    student.append(primary, secondary);
    const status = cell('');
    const badge = document.createElement('span');
    badge.className = `ac-badge ${isOverdue(session) ? 'overdue' : session.status}`;
    badge.textContent = isOverdue(session) ? 'Overdue' : session.status === 'open' ? 'Open' : 'Closed';
    status.append(badge);
    const actions = cell(''); actions.append(button('Review', () => openSessionEditor(session)));
    row.append(student, cell(session.familyName || 'Individual student'), cell(formatTime(session.clockInAt)), cell(formatTime(session.clockOutAt)), cell(elapsed(session)), status, actions);
    elements.overviewBody.append(row);
  }
}

async function loadSessionDate() {
  const serviceDate = elements.sessionDate.value;
  if (!serviceDate) return;
  setNotice('Loading sessions…');
  try {
    const data = await getAftercareDaySessions(serviceDate);
    state.sessions = data.sessions || [];
    renderSessionReview();
    setNotice('');
  } catch (error) { setNotice(error?.message || 'Could not load sessions.', true); }
}

function renderSessionReview() {
  const search = elements.sessionSearch.value.trim();
  const status = elements.sessionStatus.value;
  const rows = state.sessions.filter((session) => sessionMatches(session, search, status));
  clear(elements.sessionBody);
  if (!rows.length) return emptyRow(elements.sessionBody, 7, 'No sessions match this date and filter.');
  for (const session of rows) {
    const row = document.createElement('tr');
    const statusCell = cell('');
    const badge = document.createElement('span'); badge.className = `ac-badge ${isOverdue(session) ? 'overdue' : session.status}`; badge.textContent = isOverdue(session) ? 'Overdue' : session.status;
    statusCell.append(badge);
    const actions = cell(''); actions.append(button('Edit', () => openSessionEditor(session)), button('Delete', () => removeSession(session), 'danger small'));
    row.append(cell(session.studentName, 'ac-primary'), cell(session.familyName || 'Individual student'), cell(formatTime(session.clockInAt)), cell(formatTime(session.clockOutAt)), cell(elapsed(session)), statusCell, actions);
    elements.sessionBody.append(row);
  }
}

function openSessionEditor(session) {
  elements.sessionDialogTitle.textContent = `Review ${session.studentName}`;
  elements.editSessionId.value = session.id;
  elements.editClockIn.value = localInputValue(session.clockInAt);
  elements.editClockOut.value = localInputValue(session.clockOutAt);
  elements.editTimezone.textContent = `Times are shown in your browser timezone. Session timezone: ${session.timezone || state.settings?.timezone || 'not recorded'}. Saving a clock-out closes this session and records it as corrected.`;
  elements.sessionDialog.showModal();
}

async function saveSession(event) {
  event.preventDefault();
  if (!elements.editClockIn.value || !elements.editClockOut.value) return setNotice('Clock-in and clock-out are required.', true);
  try {
    await updateAftercareSession({
      sessionId: elements.editSessionId.value,
      clockInAt: new Date(elements.editClockIn.value).toISOString(),
      clockOutAt: new Date(elements.editClockOut.value).toISOString(),
    });
    elements.sessionDialog.close();
    setNotice('Session corrected.');
    if (elements.sessionDate.value === state.serviceDate) await loadOverview(); else await loadSessionDate();
  } catch (error) { setNotice(error?.message || 'Could not update session.', true); }
}

async function removeSession(session) {
  if (!confirm(`Delete ${session.studentName}’s session? This cannot be undone.`)) return;
  try {
    await deleteAftercareSession(session.id);
    setNotice('Session deleted.');
    if (elements.sessionDate.value === state.serviceDate) await loadOverview(); else await loadSessionDate();
  } catch (error) { setNotice(error?.message || 'Could not delete session.', true); }
}

function renderStudentOptions(selectedIds = []) {
  clear(elements.familyStudents);
  for (const student of state.students.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
    const option = document.createElement('option'); option.value = student.id; option.textContent = student.name || student.id; option.selected = selectedIds.includes(student.id);
    elements.familyStudents.append(option);
  }
}

function renderFamilies() {
  const search = elements.familySearch.value.trim().toLowerCase();
  const monthlyById = new Map((state.report?.familyRows || []).filter((row) => row.familyId).map((row) => [row.familyId, row]));
  clear(elements.familyBody);
  const families = state.families.filter((family) => !search || `${family.name} ${(family.students || []).map((student) => student.name).join(' ')}`.toLowerCase().includes(search));
  if (!families.length) return emptyRow(elements.familyBody, 5, 'No billing families match this search.');
  for (const family of families) {
    const report = monthlyById.get(family.id);
    const actions = cell('');
    actions.append(button('Edit', () => openFamilyEditor(family)), button('Archive', () => archiveFamily(family), 'danger small'));
    const row = document.createElement('tr');
    row.append(cell(family.name, 'ac-primary'), cell((family.students || []).map((student) => student.name || student.studentId).join(', ') || 'No students'), cell(String(report?.days || 0), 'number'), cell(money(report?.totalAmountCents || 0), 'number'), actions);
    elements.familyBody.append(row);
  }
}

function openFamilyEditor(family = null) {
  state.editingFamilyId = family?.id || null;
  elements.familyDialogTitle.textContent = family ? 'Edit billing family' : 'Create billing family';
  elements.familyName.value = family?.name || '';
  renderStudentOptions(family?.studentIds || []);
  elements.familyDialog.showModal();
}

async function saveFamily(event) {
  event.preventDefault();
  try {
    await saveAftercareFamily({
      familyId: state.editingFamilyId,
      name: elements.familyName.value.trim(),
      studentIds: Array.from(elements.familyStudents.selectedOptions).map((option) => option.value),
    });
    elements.familyDialog.close();
    await loadAdmin();
    if (state.report) await runReport();
    setNotice(state.editingFamilyId ? 'Billing family updated.' : 'Billing family created.');
  } catch (error) { setNotice(error?.message || 'Could not save billing family.', true); }
}

async function archiveFamily(family) {
  if (!confirm(`Archive ${family.name}? Historical reports will keep the family name, but its current student links will be removed.`)) return;
  try { await archiveAftercareFamily(family.id); await loadAdmin(); if (state.report) await runReport(); setNotice('Billing family archived.'); }
  catch (error) { setNotice(error?.message || 'Could not archive family.', true); }
}

async function runReport() {
  const month = elements.reportMonth.value;
  if (!month) return;
  setNotice('Building monthly report…');
  elements.exportSummary.disabled = true; elements.exportAudit.disabled = true; elements.downloadStatements.disabled = true; elements.printAll.disabled = true;
  try {
    state.report = normalizeReport(await getAftercareReport({ mode: 'monthly', period: month }));
    state.reportMonth = month;
    state.expandedAccount = null;
    renderReport();
    renderFamilies();
    elements.exportSummary.disabled = false; elements.exportAudit.disabled = false; elements.downloadStatements.disabled = false; elements.printAll.disabled = false;
    setNotice('');
  } catch (error) { setNotice(error?.message || 'Could not build report.', true); }
}

function renderReport() {
  const report = state.report;
  const total = (report.familyRows || []).reduce((sum, row) => sum + Number(row.totalAmountCents || 0), 0);
  elements.reportTitle.textContent = `${formatMonth(report.period)} billing`;
  elements.reportSchool.textContent = schoolName();
  elements.reportAccounts.textContent = report.familyRows.length;
  elements.reportTotal.textContent = money(total);
  elements.reportOpen.textContent = report.openSessionCount || 0;
  elements.reportIssues.textContent = report.exceptionCount || 0;
  elements.reportWarning.hidden = !report.openSessionCount && !report.exceptionCount;
  elements.reportWarning.textContent = `${report.openSessionCount || 0} open session(s) are excluded from totals. ${report.exceptionCount || 0} reconciliation item(s) need review.`;
  clear(elements.reportBody);
  const search = elements.reportSearch.value.trim().toLowerCase();
  const accounts = report.familyRows.filter((account) => !search || `${account.familyName} ${nameList(billedStudents(account))}`.toLowerCase().includes(search));
  accounts.sort((left, right) => elements.reportSort.value === 'total-desc' ? right.totalAmountCents - left.totalAmountCents : elements.reportSort.value === 'days-desc' ? right.days - left.days : left.familyName.localeCompare(right.familyName));
  if (!accounts.length) return emptyRow(elements.reportBody, 8, report.familyRows.length ? 'No billing accounts match this search.' : 'No closed aftercare sessions were found for this month.');
  for (const account of accounts) {
    const row = document.createElement('tr'); row.className = 'ac-report-row'; row.tabIndex = 0;
    const accountCell = cell('');
    const primary = document.createElement('div'); primary.className = 'ac-primary'; primary.textContent = account.familyName;
    const secondary = document.createElement('div'); secondary.className = 'ac-secondary'; secondary.textContent = `${account.accountType === 'family' ? 'Family account' : 'Individual student'} · Select for statement details`;
    accountCell.append(primary, secondary);
    row.append(accountCell, cell(nameList(billedStudents(account))), cell(String(account.days), 'number'), cell(account.singleDuration, 'number'), cell(money(account.singleAmountCents), 'number'), cell(account.familyDuration, 'number'), cell(money(account.familyAmountCents), 'number'), cell(money(account.totalAmountCents), 'number'));
    const toggle = () => { state.expandedAccount = state.expandedAccount === account.familyKey ? null : account.familyKey; renderReport(); };
    row.addEventListener('click', toggle); row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') toggle(); });
    elements.reportBody.append(row);
    if (state.expandedAccount === account.familyKey) elements.reportBody.append(buildReportDetail(account));
  }
}

function buildReportDetail(account) {
  const row = document.createElement('tr'); row.className = 'ac-detail-row';
  const td = document.createElement('td'); td.colSpan = 8;
  const detail = document.createElement('div'); detail.className = 'ac-detail';
  const grid = document.createElement('div'); grid.className = 'ac-detail-grid';
  const rosterLabel = account.familyStatus === 'archived' ? 'Archived family roster record' : account.familyStatus === 'missing' ? 'Current family roster unavailable' : 'Current family roster';
  const totalBillableHours = hours((Number(account.singleMilliseconds || 0) + Number(account.familyMilliseconds || 0)) / 3600000);
  for (const [title, value] of [['Total billable hours', `${totalBillableHours} hours`], ['Students billed this month', billedStudentDetails(account)], [rosterLabel, account.accountType === 'family' ? nameList(account.configuredStudents) : 'Not applicable']]) {
    const item = document.createElement('div'); const heading = document.createElement('h4'); heading.textContent = title; const text = document.createElement('p'); text.textContent = value; item.append(heading, text); grid.append(item);
  }
  detail.append(grid);
  for (const issue of account.exceptions || []) { const warning = document.createElement('div'); warning.className = 'ac-callout'; warning.textContent = issue; detail.append(warning); }
  const table = document.createElement('table'); table.className = 'ac-table'; table.innerHTML = '<thead><tr><th>Date</th><th>Billed in</th><th>Billed out</th><th>Students</th><th class="number">Solo</th><th class="number">Sibling overlap</th><th class="number">Total</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const day of reportDays().filter((item) => item.familyKey === account.familyKey)) {
    const dayRow = document.createElement('tr'); dayRow.append(cell(formatDate(day.serviceDate)), cell(formatTime(dayFirstIn(day))), cell(formatTime(dayBilledOut(day))), cell(nameList(billedStudents(day))), cell(`${day.singleDuration} · ${money(day.singleAmountCents)}`, 'number'), cell(`${day.familyDuration} · ${money(day.familyAmountCents)}`, 'number'), cell(money(day.totalAmountCents), 'number')); body.append(dayRow);
  }
  table.append(body); detail.append(table);
  const auditHeading = document.createElement('h4'); auditHeading.textContent = 'Session audit'; detail.append(auditHeading);
  const auditTable = document.createElement('table'); auditTable.className = 'ac-table'; auditTable.innerHTML = '<thead><tr><th>Date</th><th>Student</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Review note</th></tr></thead>';
  const auditBody = document.createElement('tbody');
  for (const session of reportSessions().filter((item) => item.familyKey === account.familyKey)) { const auditRow = document.createElement('tr'); auditRow.append(cell(formatDate(session.serviceDate)), cell(session.studentName), cell(formatTime(session.clockInAt)), cell(formatTime(session.clockOutAt)), cell(session.included ? session.status : 'Excluded'), cell(session.exclusionReason || 'Included in totals')); auditBody.append(auditRow); }
  auditTable.append(auditBody); detail.append(auditTable);
  const actions = document.createElement('div'); actions.className = 'ac-actions'; actions.append(button('Print this statement', (event) => { event.stopPropagation(); printStatements(account.familyKey); })); detail.append(actions);
  td.append(detail); row.append(td); return row;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
function loadLibrary(globalCheck, source) {
  if (globalCheck()) return Promise.resolve(globalCheck());
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => { script.remove(); reject(new Error('PDF export libraries took too long to load. Check your internet connection and try again.')); }, 15000);
    script.src = source;
    script.crossOrigin = 'anonymous';
    script.onload = () => { clearTimeout(timeout); resolve(globalCheck()); };
    script.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the PDF export library.')); };
    document.head.append(script);
  });
}
const ensureJSPDF = () => loadLibrary(() => window.jspdf?.jsPDF, 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
const ensureJSZip = () => loadLibrary(() => window.JSZip, 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
function safeFileName(account) {
  let name = String(account.familyName || billedStudents(account)[0]?.studentName || 'Statement').trim();
  if (account.accountType === 'student' && name.includes(',')) { const [last, ...given] = name.split(','); name = `${last.trim()} - ${given.join(',').trim()}`; }
  name = name.replace(/^the\s+/i, '').replace(/\s+family$/i, '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/[. ]+$/g, '').trim();
  return name || 'Statement';
}
function pdfText(value) {
  return String(value ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}
function statementPdf(jsPDF, account) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const margin = 42;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const columns = [margin, 106, 154, 202, 362, 432, 502];
  const widths = [64, 48, 48, 160, 70, 70, 68];
  const days = reportDays().filter((day) => day.familyKey === account.familyKey);
  let y = margin;

  function drawHeader(continued = false) {
    doc.setTextColor(23, 33, 43); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text(pdfText(schoolName()), margin, y);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(88, 101, 112);
    doc.text(`Aftercare statement - ${pdfText(formatMonth(state.report.period))}${continued ? ' - continued' : ''}`, margin, y + 18);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(23, 33, 43); doc.setFontSize(9);
    doc.text('TOTAL DUE', pageWidth - margin, y, { align: 'right' });
    doc.setFontSize(18); doc.text(money(account.totalAmountCents), pageWidth - margin, y + 20, { align: 'right' });
    y += 48; doc.setDrawColor(23, 33, 43); doc.setLineWidth(1.5); doc.line(margin, y, pageWidth - margin, y); y += 18;
  }
  function drawTableHeader() {
    doc.setFillColor(240, 244, 243); doc.rect(margin, y, pageWidth - margin * 2, 22, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(76, 90, 100);
    ['DATE', 'IN', 'OUT', 'STUDENTS', 'SOLO', 'SIBLING', 'TOTAL'].forEach((label, index) => doc.text(label, columns[index] + 4, y + 14));
    y += 22;
  }
  function newPage() { doc.addPage('letter', 'portrait'); y = margin; drawHeader(true); drawTableHeader(); }

  drawHeader();
  doc.setFontSize(9); doc.setTextColor(23, 33, 43); doc.setFont('helvetica', 'bold'); doc.text('BILLING ACCOUNT', margin, y);
  doc.setFont('helvetica', 'normal'); doc.text(pdfText(account.familyName), margin, y + 14);
  doc.setFont('helvetica', 'bold'); doc.text('STUDENTS BILLED', 260, y);
  doc.setFont('helvetica', 'normal');
  const studentLines = doc.splitTextToSize(pdfText(nameList(billedStudents(account))), pageWidth - 260 - margin);
  doc.text(studentLines, 260, y + 14);
  const totalHours = hours((Number(account.singleMilliseconds || 0) + Number(account.familyMilliseconds || 0)) / 3600000);
  doc.setFont('helvetica', 'bold'); doc.text('TOTAL HOURS', margin, y + 39);
  doc.setFont('helvetica', 'normal'); doc.text(`${totalHours} hours`, margin, y + 53);
  y += Math.max(70, 34 + studentLines.length * 11);
  drawTableHeader();

  for (const day of days) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(23, 33, 43);
    const values = [formatDate(day.serviceDate), formatTime(dayFirstIn(day)), formatTime(dayBilledOut(day)), nameList(billedStudents(day)), money(day.singleAmountCents), money(day.familyAmountCents), money(day.totalAmountCents)];
    const lines = values.map((value, index) => doc.splitTextToSize(pdfText(value), widths[index] - 8));
    const rowHeight = Math.max(24, Math.max(...lines.map((value) => value.length)) * 10 + 8);
    if (y + rowHeight > pageHeight - 90) newPage();
    lines.forEach((value, index) => doc.text(value, columns[index] + 4, y + 14));
    doc.setDrawColor(220, 226, 230); doc.setLineWidth(.5); doc.line(margin, y + rowHeight, pageWidth - margin, y + rowHeight);
    y += rowHeight;
  }
  if (y + 70 > pageHeight - margin) newPage();
  y += 18; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(23, 33, 43);
  doc.text(`Solo ${money(account.singleAmountCents)}`, pageWidth - margin, y, { align: 'right' });
  doc.text(`Sibling overlap ${money(account.familyAmountCents)}`, pageWidth - margin, y + 16, { align: 'right' });
  doc.setFontSize(13); doc.text(`Total due ${money(account.totalAmountCents)}`, pageWidth - margin, y + 38, { align: 'right' });
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) { doc.setPage(page); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110); doc.text(`Prepared ${new Date().toLocaleDateString()}  |  Page ${page} of ${pages}`, margin, pageHeight - 24); }
  return doc;
}
async function downloadAllStatements() {
  if (!state.report?.familyRows?.length) return;
  const originalLabel = elements.downloadStatements.textContent;
  elements.downloadStatements.disabled = true;
  elements.downloadStatements.textContent = 'Preparing PDFs…';
  setNotice(`Preparing ${state.report.familyRows.length} statement PDF(s)…`);
  try {
    const [jsPDF, JSZip] = await Promise.all([ensureJSPDF(), ensureJSZip()]);
    const zip = new JSZip();
    const names = new Map();
    for (const account of state.report.familyRows) {
      const base = safeFileName(account);
      const count = (names.get(base.toLowerCase()) || 0) + 1;
      names.set(base.toLowerCase(), count);
      const fileName = `${base}${count > 1 ? `-${count}` : ''}.pdf`;
      zip.file(fileName, statementPdf(jsPDF, account).output('arraybuffer'));
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${safeFileName({ familyName: schoolName() })}-aftercare-statements-${state.report.period}.zip`;
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    setNotice(`${state.report.familyRows.length} statement PDF(s) downloaded.`);
  } catch (error) { setNotice(error?.message || 'Could not create statement PDFs.', true); }
  finally { elements.downloadStatements.disabled = false; elements.downloadStatements.textContent = originalLabel; }
}
function exportSummary() {
  const headers = ['School', 'Month', 'Account type', 'Family or student', 'Students billed', 'Attendance days', 'Solo hours', 'Solo charge', 'Sibling overlap hours', 'Sibling charge', 'Total due'];
  const rows = state.report.familyRows.map((row) => [schoolName(), state.report.period, row.accountType, row.familyName, nameList(billedStudents(row)), row.days, hours(row.singleDecimalHours), (row.singleAmountCents / 100).toFixed(2), hours(row.familyDecimalHours), (row.familyAmountCents / 100).toFixed(2), (row.totalAmountCents / 100).toFixed(2)]);
  downloadCsv(`aftercare-summary-${state.report.period}.csv`, headers, rows);
}
function exportAudit() {
  const headers = ['School', 'Service date', 'Student', 'Account type', 'Historical family or student', 'Clock in', 'Clock out', 'Duration', 'Single rate', 'Sibling rate', 'Status', 'Close method', 'Included in totals', 'Review note'];
  const rows = reportSessions().map((row) => [schoolName(), row.serviceDate, row.studentName, row.accountType, row.familyName, row.clockInAt, row.clockOutAt, row.duration || '', (row.singleRateCents / 100).toFixed(2), (row.familyRateCents / 100).toFixed(2), row.status, row.closeMethod || '', row.included ? 'Yes' : 'No', row.exclusionReason || '']);
  downloadCsv(`aftercare-audit-${state.report.period}.csv`, headers, rows);
}

function printStatements(familyKey = null) {
  clear(elements.printStatements);
  const accounts = state.report.familyRows.filter((row) => !familyKey || row.familyKey === familyKey);
  for (const account of accounts) elements.printStatements.append(buildStatement(account));
  document.body.classList.add('printing');
  const finishPrinting = () => document.body.classList.remove('printing');
  window.addEventListener('afterprint', finishPrinting, { once: true });
  window.print();
}
function buildStatement(account) {
  const statement = document.createElement('section'); statement.className = 'ac-statement';
  const head = document.createElement('header'); head.className = 'ac-statement-head';
  const identity = document.createElement('div'); const title = document.createElement('h1'); title.textContent = schoolName(); const subtitle = document.createElement('p'); subtitle.textContent = `Aftercare statement · ${formatMonth(state.report.period)} · Prepared ${new Date().toLocaleDateString()}`; identity.append(title, subtitle);
  const total = document.createElement('div'); total.className = 'ac-statement-total'; const label = document.createElement('span'); label.textContent = 'Total due'; const amount = document.createElement('strong'); amount.textContent = money(account.totalAmountCents); total.append(label, amount); head.append(identity, total);
  const meta = document.createElement('div'); meta.className = 'ac-statement-meta';
  for (const [labelText, value] of [['Billing account', account.familyName], ['Students billed', nameList(billedStudents(account))], ['Total hours', `${hours((Number(account.singleMilliseconds || 0) + Number(account.familyMilliseconds || 0)) / 3600000)} hours`]]) { const block = document.createElement('div'); const labelNode = document.createElement('strong'); labelNode.textContent = labelText; const valueNode = document.createElement('div'); valueNode.textContent = value; block.append(labelNode, valueNode); meta.append(block); }
  const table = document.createElement('table'); table.innerHTML = '<thead><tr><th>Date</th><th>Billed in</th><th>Billed out</th><th>Students</th><th class="number">Solo charge</th><th class="number">Sibling charge</th><th class="number">Total</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const day of reportDays().filter((row) => row.familyKey === account.familyKey)) { const row = document.createElement('tr'); row.append(cell(formatDate(day.serviceDate)), cell(formatTime(dayFirstIn(day))), cell(formatTime(dayBilledOut(day))), cell(nameList(billedStudents(day))), cell(money(day.singleAmountCents), 'number'), cell(money(day.familyAmountCents), 'number'), cell(money(day.totalAmountCents), 'number')); body.append(row); }
  table.append(body);
  const foot = document.createElement('div'); foot.className = 'ac-statement-foot'; foot.textContent = `Solo ${money(account.singleAmountCents)} · Sibling overlap ${money(account.familyAmountCents)} · Total ${money(account.totalAmountCents)}`;
  statement.append(head, meta, table, foot); return statement;
}

function fillSettings() {
  const form = elements.settingsForm;
  form.singleRate.value = (state.settings.singleRateCents / 100).toFixed(2);
  form.familyRate.value = (state.settings.familyRateCents / 100).toFixed(2);
  form.cutoff.value = state.settings.cutoffLocalTime;
  form.timezone.value = state.settings.timezone;
}
async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await saveAftercareSettings({ timezone: form.timezone.value.trim(), cutoffLocalTime: form.cutoff.value, singleRateCents: Math.round(Number(form.singleRate.value) * 100), familyRateCents: Math.round(Number(form.familyRate.value) * 100) });
    await loadAdmin(); setNotice('Aftercare settings saved.');
  } catch (error) { setNotice(error?.message || 'Could not save settings.', true); }
}

function activateView(name) {
  document.querySelectorAll('[data-view-button]').forEach((item) => item.setAttribute('aria-selected', String(item.dataset.viewButton === name)));
  document.querySelectorAll('[data-view]').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  if (name === 'reports' && !state.report) runReport();
  if (name === 'families' && !state.report) runReport();
}

function bindEvents() {
  document.querySelectorAll('[data-view-button]').forEach((item) => item.addEventListener('click', () => activateView(item.dataset.viewButton)));
  elements.refreshOverview.addEventListener('click', loadOverview);
  elements.overviewSearch.addEventListener('input', renderOverviewRows);
  elements.overviewStatus.addEventListener('change', renderOverviewRows);
  elements.loadSessions.addEventListener('click', loadSessionDate);
  elements.sessionSearch.addEventListener('input', renderSessionReview);
  elements.sessionStatus.addEventListener('change', renderSessionReview);
  elements.sessionForm.addEventListener('submit', saveSession);
  elements.closeSessionDialog.addEventListener('click', () => elements.sessionDialog.close());
  elements.cancelSession.addEventListener('click', () => elements.sessionDialog.close());
  elements.newFamily.addEventListener('click', () => openFamilyEditor());
  elements.familySearch.addEventListener('input', renderFamilies);
  elements.familyForm.addEventListener('submit', saveFamily);
  elements.closeFamilyDialog.addEventListener('click', () => elements.familyDialog.close());
  elements.cancelFamily.addEventListener('click', () => elements.familyDialog.close());
  elements.runReport.addEventListener('click', runReport);
  elements.reportSearch.addEventListener('input', () => { if (state.report) renderReport(); });
  elements.reportSort.addEventListener('change', () => { if (state.report) renderReport(); });
  elements.exportSummary.addEventListener('click', exportSummary);
  elements.exportAudit.addEventListener('click', exportAudit);
  elements.downloadStatements.addEventListener('click', downloadAllStatements);
  elements.printAll.addEventListener('click', () => printStatements());
  elements.settingsForm.addEventListener('submit', saveSettings);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.serviceDate) loadOverview(); });
}

let bootstrapped = false;
async function bootstrap(claims) {
  if (bootstrapped) return;
  if (!claims || !(claims.owner || claims.superintendent || claims.admin)) { location.replace('/index.html#login'); return; }
  bootstrapped = true;
  try {
    bindEvents();
    onStudents(null, (students) => { state.students = students; renderStudentOptions(); });
    await loadAdmin();
    await loadOverview();
    setInterval(() => { if (!document.hidden) loadOverview(); }, 60000);
  } catch (error) { setNotice(error?.message || 'Aftercare management could not be loaded.', true); }
}

window.initAppWithClaims = bootstrap;
const claims = window.SD?.claims || window.SD?.userClaims;
if (claims) bootstrap(claims);
else window.addEventListener('sd:claims-ready', (event) => bootstrap(event.detail?.claims || event.detail || window.SD?.claims || {}), { once: true });
