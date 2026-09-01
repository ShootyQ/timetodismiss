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
const schoolName = () => window.SD?.schoolName || window.SD?.schoolId || 'School';
const nameList = (students) => (students || []).map((student) => student.studentName || student.name || student.studentId).join(', ') || 'None';
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
  elements.exportSummary.disabled = true; elements.exportAudit.disabled = true; elements.printAll.disabled = true;
  try {
    state.report = await getAftercareReport({ mode: 'monthly', period: month });
    state.reportMonth = month;
    state.expandedAccount = null;
    renderReport();
    renderFamilies();
    elements.exportSummary.disabled = false; elements.exportAudit.disabled = false; elements.printAll.disabled = false;
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
  const accounts = report.familyRows.filter((account) => !search || `${account.familyName} ${nameList(account.billedStudents)}`.toLowerCase().includes(search));
  accounts.sort((left, right) => elements.reportSort.value === 'total-desc' ? right.totalAmountCents - left.totalAmountCents : elements.reportSort.value === 'days-desc' ? right.days - left.days : left.familyName.localeCompare(right.familyName));
  if (!accounts.length) return emptyRow(elements.reportBody, 8, report.familyRows.length ? 'No billing accounts match this search.' : 'No closed aftercare sessions were found for this month.');
  for (const account of accounts) {
    const row = document.createElement('tr'); row.className = 'ac-report-row'; row.tabIndex = 0;
    const accountCell = cell('');
    const primary = document.createElement('div'); primary.className = 'ac-primary'; primary.textContent = account.familyName;
    const secondary = document.createElement('div'); secondary.className = 'ac-secondary'; secondary.textContent = account.accountType === 'family' ? 'Family account' : 'Individual student';
    accountCell.append(primary, secondary);
    row.append(accountCell, cell(nameList(account.billedStudents)), cell(String(account.days), 'number'), cell(account.singleDuration, 'number'), cell(money(account.singleAmountCents), 'number'), cell(account.familyDuration, 'number'), cell(money(account.familyAmountCents), 'number'), cell(money(account.totalAmountCents), 'number'));
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
  for (const [title, value] of [['Students billed this month', nameList(account.billedStudents)], [rosterLabel, account.accountType === 'family' ? nameList(account.configuredStudents) : 'Not applicable']]) {
    const item = document.createElement('div'); const heading = document.createElement('h4'); heading.textContent = title; const text = document.createElement('p'); text.textContent = value; item.append(heading, text); grid.append(item);
  }
  detail.append(grid);
  for (const issue of account.exceptions || []) { const warning = document.createElement('div'); warning.className = 'ac-callout'; warning.textContent = issue; detail.append(warning); }
  const table = document.createElement('table'); table.className = 'ac-table'; table.innerHTML = '<thead><tr><th>Date</th><th>Students</th><th class="number">Solo</th><th class="number">Sibling overlap</th><th class="number">Total</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const day of state.report.dayRows.filter((item) => item.familyKey === account.familyKey)) {
    const dayRow = document.createElement('tr'); dayRow.append(cell(formatDate(day.serviceDate)), cell(nameList(day.billedStudents)), cell(`${day.singleDuration} · ${money(day.singleAmountCents)}`, 'number'), cell(`${day.familyDuration} · ${money(day.familyAmountCents)}`, 'number'), cell(money(day.totalAmountCents), 'number')); body.append(dayRow);
  }
  table.append(body); detail.append(table);
  const auditHeading = document.createElement('h4'); auditHeading.textContent = 'Session audit'; detail.append(auditHeading);
  const auditTable = document.createElement('table'); auditTable.className = 'ac-table'; auditTable.innerHTML = '<thead><tr><th>Date</th><th>Student</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Review note</th></tr></thead>';
  const auditBody = document.createElement('tbody');
  for (const session of state.report.sessionRows.filter((item) => item.familyKey === account.familyKey)) { const auditRow = document.createElement('tr'); auditRow.append(cell(formatDate(session.serviceDate)), cell(session.studentName), cell(formatTime(session.clockInAt)), cell(formatTime(session.clockOutAt)), cell(session.included ? session.status : 'Excluded'), cell(session.exclusionReason || 'Included in totals')); auditBody.append(auditRow); }
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
function exportSummary() {
  const headers = ['School', 'Month', 'Account type', 'Family or student', 'Students billed', 'Attendance days', 'Solo hours', 'Solo charge', 'Sibling overlap hours', 'Sibling charge', 'Total due'];
  const rows = state.report.familyRows.map((row) => [schoolName(), state.report.period, row.accountType, row.familyName, nameList(row.billedStudents), row.days, hours(row.singleDecimalHours), (row.singleAmountCents / 100).toFixed(2), hours(row.familyDecimalHours), (row.familyAmountCents / 100).toFixed(2), (row.totalAmountCents / 100).toFixed(2)]);
  downloadCsv(`aftercare-summary-${state.report.period}.csv`, headers, rows);
}
function exportAudit() {
  const headers = ['School', 'Service date', 'Student', 'Account type', 'Historical family or student', 'Clock in', 'Clock out', 'Duration', 'Single rate', 'Sibling rate', 'Status', 'Close method', 'Included in totals', 'Review note'];
  const rows = state.report.sessionRows.map((row) => [schoolName(), row.serviceDate, row.studentName, row.accountType, row.familyName, row.clockInAt, row.clockOutAt, row.duration || '', (row.singleRateCents / 100).toFixed(2), (row.familyRateCents / 100).toFixed(2), row.status, row.closeMethod || '', row.included ? 'Yes' : 'No', row.exclusionReason || '']);
  downloadCsv(`aftercare-audit-${state.report.period}.csv`, headers, rows);
}

function printStatements(familyKey = null) {
  clear(elements.printStatements);
  const accounts = state.report.familyRows.filter((row) => !familyKey || row.familyKey === familyKey);
  for (const account of accounts) elements.printStatements.append(buildStatement(account));
  document.body.classList.add('printing');
  window.print();
  document.body.classList.remove('printing');
}
function buildStatement(account) {
  const statement = document.createElement('section'); statement.className = 'ac-statement';
  const head = document.createElement('header'); head.className = 'ac-statement-head';
  const identity = document.createElement('div'); const title = document.createElement('h1'); title.textContent = schoolName(); const subtitle = document.createElement('p'); subtitle.textContent = `Aftercare statement · ${formatMonth(state.report.period)} · Prepared ${new Date().toLocaleDateString()}`; identity.append(title, subtitle);
  const total = document.createElement('div'); total.className = 'ac-statement-total'; const label = document.createElement('span'); label.textContent = 'Total due'; const amount = document.createElement('strong'); amount.textContent = money(account.totalAmountCents); total.append(label, amount); head.append(identity, total);
  const meta = document.createElement('div'); meta.className = 'ac-statement-meta';
  for (const [labelText, value] of [['Billing account', account.familyName], ['Students billed', nameList(account.billedStudents)]]) { const block = document.createElement('div'); const labelNode = document.createElement('strong'); labelNode.textContent = labelText; const valueNode = document.createElement('div'); valueNode.textContent = value; block.append(labelNode, valueNode); meta.append(block); }
  const table = document.createElement('table'); table.innerHTML = '<thead><tr><th>Date</th><th>Students</th><th class="number">Solo charge</th><th class="number">Sibling charge</th><th class="number">Total</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const day of state.report.dayRows.filter((row) => row.familyKey === account.familyKey)) { const row = document.createElement('tr'); row.append(cell(formatDate(day.serviceDate)), cell(nameList(day.billedStudents)), cell(money(day.singleAmountCents), 'number'), cell(money(day.familyAmountCents), 'number'), cell(money(day.totalAmountCents), 'number')); body.append(row); }
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
