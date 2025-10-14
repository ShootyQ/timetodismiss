// Firebase-powered realtime helpers shared by all pages.
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc,
  serverTimestamp, onSnapshot, query, where, orderBy, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';

let app, db, auth;
let ACTIVE_SESSION_ID = null; // optional: set by caller UI; used for analytics event tagging

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */
export async function init() {
  if (app) return;
  const firebaseConfig = {
    apiKey: "AIzaSyD3bCzCSGN2s-rBcevStOGfhTOKDSmmbCU",
    authDomain: "dismissalcaller.firebaseapp.com",
    projectId: "dismissalcaller",
    storageBucket: "dismissalcaller.appspot.com",
    messagingSenderId: "942492177246",
    appId: "1:942492177246:web:f4fb6ea6af42b9bde975cf",
    measurementId: "G-279958XEND"
  };
  // Make accessible for diagnostics (roles.html debug panel, etc.)
  try { if (!window.firebaseConfig) window.firebaseConfig = firebaseConfig; } catch {}

  // Reuse existing app if compat (site-header.js) already initialized it
  try {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  } catch (e) {
    // Fallback: try to grab default app if initialization raced
    try { app = getApp(); } catch { app = initializeApp(firebaseConfig); }
  }
  db   = getFirestore(app);
  auth = getAuth(app);
}

// Optional: set the current active session id so events can be tagged for session analytics
export function setActiveSession(sessionId){
  try {
    const id = (sessionId || '').toString().trim();
    ACTIVE_SESSION_ID = id || null;
  } catch { ACTIVE_SESSION_ID = null; }
}

/* Tenant readiness waiter (event-driven + timeout) */
async function waitForTenant(maxMs = 15000) {
  // Fast path
  if (globalThis.SD?.schoolId && globalThis.SD?.orgId) return;

  // Try claims-first fallback if header hasn't set SD yet
  try {
    const user = (await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js')).getAuth?.() ? auth : getAuth();
    const u = user?.currentUser;
    if (u) {
      const idt = await u.getIdTokenResult(true);
      const c = idt?.claims || {};
      if (c.schoolId) {
        globalThis.SD = globalThis.SD || {};
        if (!globalThis.SD.schoolId) globalThis.SD.schoolId = c.schoolId;
        if (c.orgId && !globalThis.SD.orgId) globalThis.SD.orgId = c.orgId; // only set if present in claims
        if (globalThis.SD.schoolId && globalThis.SD.orgId) return; // ready when both present
      }
    }
  } catch {}

  let resolved = false;
  const start = Date.now();

  await new Promise((resolve, reject) => {
  const onReady = () => {
      if (resolved) return;
      if (globalThis.SD?.schoolId && globalThis.SD?.orgId) {
        resolved = true;
        cleanup();
        resolve();
      }
    };

    function cleanup() {
      try { document.removeEventListener('sd:claims-ready', onReady); } catch {}
      try { clearInterval(iv); } catch {}
      try { clearTimeout(to); } catch {}
    }

    // Listen for claims-ready event from site-header.js
    document.addEventListener('sd:claims-ready', onReady, { once: true });
    // Also poll briefly in case the event already fired
    const iv = setInterval(onReady, 50);
    const to = setTimeout(() => {
      if (resolved) return;
      cleanup();
  reject(new Error('tenant context not ready (missing orgId/schoolId)'));
    }, Math.max(1000, maxMs));
  });
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
export function onAuthChanged(cb)          { return onAuthStateChanged(auth, cb); }
export function signIn(email, password)    { return signInWithEmailAndPassword(auth, email, password); }
export function signOutUser()              { return signOut(auth); }

/* ------------------------------------------------------------------ */
/* Tenant helpers (per-school paths)                                   */
/* ------------------------------------------------------------------ */
export function colPath(name) {
  if (!app || !db) throw new Error('Firebase not initialized. Call init() first.');
  const sid = globalThis.SD?.schoolId;
  const oid = globalThis.SD?.orgId;
  if (!oid) throw new Error('No orgId set');
  if (!sid) throw new Error('No schoolId set');
  return collection(db, 'orgs', oid, 'schools', sid, name);
}
export function docPath(name, id) {
  if (!app || !db) throw new Error('Firebase not initialized. Call init() first.');
  const sid = globalThis.SD?.schoolId;
  const oid = globalThis.SD?.orgId;
  if (!oid) throw new Error('No orgId set');
  if (!sid) throw new Error('No schoolId set');
  return doc(db, 'orgs', oid, 'schools', sid, name, id);
}

/* ------------------------------------------------------------------ */
/* Classes                                                             */
/* ------------------------------------------------------------------ */
export async function getClasses() {
  await waitForTenant();
  const classesCol = colPath('classes');
  // Helper to normalize row shape and guarantee a display name
  const norm = (d) => {
    const data = d.data() || {};
    const name = data.name || data.title || d.id;
    const order = typeof data.order === 'number' ? data.order : undefined;
    return { ...data, id: d.id, name, ...(order !== undefined ? { order } : {}) };
  };
  // Try by explicit order field first
  try {
    const s1 = await getDocs(query(classesCol, orderBy('order', 'asc')));
    const rows = s1.docs.map(norm);
    // If empty, fall back to name
    if (rows.length) return rows;
  } catch (e) {
    console.warn('[getClasses] orderBy(order) failed; falling back to name:', e?.message || e);
  }
  // Fallback: order by name
  try {
    const s2 = await getDocs(query(classesCol, orderBy('name', 'asc')));
    const rows = s2.docs.map(norm);
    if (rows.length) return rows;
  } catch (e) {
    console.warn('[getClasses] orderBy(name) failed; falling back to unsorted:', e?.message || e);
  }
  // Final fallback: no Firestore order, sort client-side
  const s3 = await getDocs(classesCol);
  return s3.docs.map(norm).sort((a,b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));
}
export async function getClassById(classId) {
  await waitForTenant();
  const d = await getDoc(docPath('classes', classId));
  return d.exists() ? { ...d.data(), id: d.id } : null;
}

// Fetch classes explicitly for a provided school (does not mutate global SD context)
export async function getClassesForSchool(schoolId, orgIdOverride){
  await waitForTenant();
  const oid = orgIdOverride || globalThis.SD?.orgId;
  const sid = schoolId || globalThis.SD?.schoolId;
  if (!oid) throw new Error('No orgId for getClassesForSchool');
  if (!sid) throw new Error('No schoolId for getClassesForSchool');
  // Build manual collection ref (cannot reuse colPath because it always uses current SD values)
  const classesCol = collection(db, 'orgs', oid, 'schools', sid, 'classes');
  const norm = (d) => { const data = d.data() || {}; const name = data.name || data.title || d.id; const order = typeof data.order === 'number' ? data.order : undefined; return { ...data, id: d.id, name, ...(order !== undefined ? { order } : {}) }; };
  try {
    const s1 = await getDocs(query(classesCol, orderBy('order','asc')));
    const rows = s1.docs.map(norm);
    if (rows.length) return rows;
  } catch {}
  try {
    const s2 = await getDocs(query(classesCol, orderBy('name','asc')));
    const rows = s2.docs.map(norm);
    if (rows.length) return rows;
  } catch {}
  const s3 = await getDocs(classesCol);
  return s3.docs.map(norm).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
}

/* ------------------------------------------------------------------ */
/* Students                                                            */
/* ------------------------------------------------------------------ */

// Realtime list for a single class.
// NOTE: requires composite index on (classId asc, name asc).
export function onClassStudents(classId, cb) {
  let unsub = () => {};
  (async () => {
    try {
      await waitForTenant();
      const qy = query(
        colPath('students'),
        where('classId', '==', classId),
        orderBy('name', 'asc')
      );
      unsub = onSnapshot(qy,
  (snap) => cb(snap.docs.map(d => ({ ...d.data(), id: d.id })) ),
        (err) => console.error('[onClassStudents] listener error:', err)
      );
    } catch (e) { console.error('[onClassStudents] init failed:', e); }
  })();
  return () => { try { unsub(); } catch {} };
}

// Realtime list for Master view (optionally filtered by class).
export function onStudents(classIdOrNull, cb) {
  let unsub = () => {};
  (async () => {
    try {
      await waitForTenant();
      const base = colPath('students');
      let classesCache = null;
      getClasses().then(c => classesCache = c).catch(() => {});

      const handle = (snap) => {
        const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        try {
          if (rows.length && !rows[0].id) console.warn('[onStudents] first row missing id; check data.id overriding doc.id');
        } catch {}
        cb(rows.map(r => ({ ...r, className: classesCache?.find(c => c.id === r.classId)?.name || '' })));
      };

      function startPrimary() {
        try {
          const qy = classIdOrNull
            ? query(base, where('classId', '==', classIdOrNull), orderBy('name', 'asc'))
            : query(base, orderBy('name', 'asc'));
          unsub = onSnapshot(qy, handle, (err) => {
            console.warn('[onStudents] primary listener failed; falling back without order:', err?.message || err);
            startFallback();
          });
        } catch (e) {
          console.warn('[onStudents] startPrimary threw; falling back:', e?.message || e);
          startFallback();
        }
      }

      function startFallback() {
        try { unsub(); } catch {}
        try {
          const qy = classIdOrNull ? query(base, where('classId', '==', classIdOrNull)) : base;
          unsub = onSnapshot(qy, handle, (err2) => console.error('[onStudents] fallback listener error:', err2));
        } catch (e2) {
          console.error('[onStudents] fallback failed:', e2);
        }
      }

      startPrimary();
    } catch (e) { console.error('[onStudents] init failed:', e); }
  })();
  return () => { try { unsub(); } catch {} };
}

// Single-student status update.
export async function setStudentStatus(studentId, status) {
  await waitForTenant();
  const studentRef = docPath('students', studentId);
  await updateDoc(studentRef, { status, updatedAt: serverTimestamp() });
  try {
    // Event logging: orgs/{org}/schools/{school}/students/{id}/events
    const evtCol = collection(studentRef, 'events');
    // Tag with tenant, student context, and optional session id for collectionGroup analytics
    const ctx = { orgId: globalThis.SD?.orgId || null, schoolId: globalThis.SD?.schoolId || null };
    let classId = null; let studentName = '';
    try {
      const sSnap = await getDoc(studentRef);
      if (sSnap.exists()) { const sd = sSnap.data()||{}; classId = sd.classId || null; studentName = sd.name || ''; }
    } catch {}
    await addDoc(evtCol, {
      status,
      at: serverTimestamp(),
      sessionId: ACTIVE_SESSION_ID || null,
      orgId: ctx.orgId,
      schoolId: ctx.schoolId,
      studentId,
      classId: classId || null,
      studentName: studentName || ''
    });
  } catch(e){ console.warn('[analytics] event log failed', e); }
  try {
    // Update per-day per-student stats (day key in UTC) at orgs/{org}/schools/{school}/studentStats/{YYYY-MM-DD}:{studentId}
    const now = new Date();
    const day = now.toISOString().slice(0,10); // YYYY-MM-DD
    const statsId = day + ':' + studentId;
    const statsRef = docPath('studentStats', statsId);
    const snap = await getDoc(statsRef);
    const data = snap.exists() ? (snap.data()||{}) : { firstStatus: status };
    // Record first times for each milestone if not already set
    // We'll store server-side markers and let UI compute durations on read
    const update = { lastStatus: status, updatedAt: serverTimestamp() };
    if (!data.calledAt && status === 'called') update.calledAt = serverTimestamp();
    if (!data.enRouteAt && (status === 'en_route' || status === 'enroute')) update.enRouteAt = serverTimestamp();
    if (!data.pickedUpAt && status === 'picked_up') update.pickedUpAt = serverTimestamp();
    // Also persist classId for lookup (fetch once from student doc when needed)
    try {
      if (!data.classId) {
        const sSnap = await getDoc(studentRef);
        if (sSnap.exists()) { const sd = sSnap.data()||{}; if(sd.classId) update.classId = sd.classId; if(sd.name) update.studentName = sd.name; }
      }
    } catch {}
    await setDoc(statsRef, update, { merge:true });
  } catch(e){ console.warn('[analytics] stats update failed', e); }
}

/* ------------------------------------------------------------------ */
/* Student Daily Stats Retrieval                                       */
/* ------------------------------------------------------------------ */

// Fetch all studentStats docs for a given date (YYYY-MM-DD).
export async function getStudentStatsForDay(day){
  await waitForTenant();
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) throw new Error('Day must be YYYY-MM-DD');
  const statsCol = colPath('studentStats');
  // We stored docs as {day}:{studentId}; use a client filter until an index/alternate schema is added.
  const snap = await getDocs(statsCol);
  const rows = [];
  snap.docs.forEach(d=>{ if(d.id.startsWith(day+':')) rows.push({ id:d.id, ...d.data() }); });
  return rows;
}

// Compute durations (ms) from stats doc server timestamps (serverTimestamp fields become Timestamp objects when read).
export function computeStudentDurations(stat){
  const out = { calledToEnRoute:null, enRouteToPickup:null, calledToPickup:null };
  try {
    const c = stat.calledAt?.toDate?.();
    const e = stat.enRouteAt?.toDate?.();
    const p = stat.pickedUpAt?.toDate?.();
    if(c && e) out.calledToEnRoute = e - c;
    if(e && p) out.enRouteToPickup = p - e;
    if(c && p) out.calledToPickup = p - c;
  } catch {}
  return out;
}

export function summarizeDayStats(stats){
  const agg = { count:0, calledToEnRoute:0, enRouteToPickup:0, calledToPickup:0, samples:{ calledToEnRoute:0, enRouteToPickup:0, calledToPickup:0 } };
  stats.forEach(s=>{
    const d = computeStudentDurations(s);
    agg.count++;
    if(typeof d.calledToEnRoute==='number'){ agg.calledToEnRoute += d.calledToEnRoute; agg.samples.calledToEnRoute++; }
    if(typeof d.enRouteToPickup==='number'){ agg.enRouteToPickup += d.enRouteToPickup; agg.samples.enRouteToPickup++; }
    if(typeof d.calledToPickup==='number'){ agg.calledToPickup += d.calledToPickup; agg.samples.calledToPickup++; }
  });
  function avg(total,samples){ return samples? Math.round(total/samples): null; }
  return {
    total: agg.count,
    avgCalledToEnRoute: avg(agg.calledToEnRoute, agg.samples.calledToEnRoute),
    avgEnRouteToPickup: avg(agg.enRouteToPickup, agg.samples.enRouteToPickup),
    avgCalledToPickup: avg(agg.calledToPickup, agg.samples.calledToPickup)
  };
}

/* ------------------------------------------------------------------ */
/* Car groups (families) — multiple tags per group + legacy support    */
/* ------------------------------------------------------------------ */

function normTag(s){
  return (s || '').toString().toUpperCase().trim();
}
// Compressed normalization used by scanner.js (removes internal whitespace & non A-Z0-9-/ except dash)
function tightTag(s){
  return (s || '')
    .toString()
    .toUpperCase()
    .replace(/\s+/g,'')
    .replace(/[^A-Z0-9\-]/g,'')
    .trim();
}

// Live map of tag -> name (legacy cars + multi-tag groups). Groups take precedence.
export function onCars(cb) {
  let unsubLegacy = () => {};
  let unsubGroups = () => {};
  (async () => {
    try {
      await waitForTenant();
      const carsCol = colPath('cars');          // legacy: one doc per tag
      const groupsCol = colPath('carGroups');   // new: one doc per family, tags: []

      let legacy = {};
      let groups = {};

      function emit(){ cb({ ...legacy, ...groups }); }

      unsubLegacy = onSnapshot(carsCol, (snap) => {
        const map = {};
        snap.docs.forEach(d => { map[normTag(d.id)] = (d.data().name || '').trim(); });
        legacy = map; emit();
      }, (err) => console.error('[onCars] legacy listener error:', err));

  unsubGroups = onSnapshot(groupsCol, (snap) => {
        const map = {};
        snap.docs.forEach(d => {
          const data = d.data() || {};
          const name = (data.name || '').trim();
          const tags = Array.isArray(data.tags) ? data.tags : [];
          tags.forEach(t => { map[normTag(t)] = name; });
        });
        groups = map; emit();
      }, (err) => console.error('[onCars] groups listener error:', err));
    } catch (e) { console.error('[onCars] init failed:', e); }
  })();
  return () => { try { unsubLegacy(); } catch {} try { unsubGroups(); } catch {} };
}

// New: live list of car groups { id, name, tags[] }
export function onCarGroups(cb){
  let unsub = () => {};
  (async () => {
    try {
      await waitForTenant();
      const groupsCol = colPath('carGroups');
      unsub = onSnapshot(groupsCol, (snap) => {
        const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        cb(rows);
      }, (err) => console.error('[onCarGroups] listener error:', err));
    } catch (e) { console.error('[onCarGroups] init failed:', e); }
  })();
  return () => { try { unsub(); } catch {} };
}

// Resolve a group by any of its tags (array-contains). If none, return null.
export async function getGroupByTag(tag){
  await waitForTenant();
  const t = normTag(tag);
  let snap;
  try {
    const qy = query(colPath('carGroups'), where('tags', 'array-contains', t));
    snap = await getDocs(qy);
    if (!snap.empty){
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
  } catch(e){ /* fall through to tight */ }
  // Retry with tight/whitespace-stripped variant if different (scanner emits this form)
  const tight = tightTag(tag);
  if (tight && tight !== t){
    try {
      const qy2 = query(colPath('carGroups'), where('tags', 'array-contains', tight));
      const snap2 = await getDocs(qy2);
      if (!snap2.empty){
        const d2 = snap2.docs[0];
        return { id: d2.id, ...d2.data() };
      }
    } catch(e2){ /* ignore */ }
  }
  return null;
}

// Utility: chunk an array (for Firestore 'in' queries limit of 10)
function chunk(arr, size=10){
  const out = []; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size)); return out;
}

// Update status for all students in a group (by id) or by a single tag fallback
export async function setStatusForGroup(groupId, status){
  await waitForTenant();
  const d = await getDoc(docPath('carGroups', groupId));
  if (!d.exists()) return;
  const tags = (d.data().tags || []).map(normTag).filter(Boolean);
  if (tags.length === 0) return 0;

  // Firestore 'in' supports up to 10 items
  const batches = chunk(tags, 10);
  let total = 0;
  for (const batchTags of batches){
    const qy = query(colPath('students'), where('carTag', 'in', batchTags));
    const snap = await getDocs(qy);
    if (snap.empty) continue;
    const wb = writeBatch(db);
    const toLog = [];
    snap.forEach(d => {
      wb.update(d.ref, { status, updatedAt: serverTimestamp() });
      total++;
      toLog.push({ ref: d.ref, data: d.data() });
    });
    await wb.commit();
    // Log analytics events for each updated student
    try {
      const oid = globalThis.SD?.orgId || null;
      const sid = globalThis.SD?.schoolId || null;
      for (const it of toLog){
        try {
          const evtCol = collection(it.ref, 'events');
          const data = it.data || {};
          await addDoc(evtCol, {
            status,
            at: serverTimestamp(),
            sessionId: ACTIVE_SESSION_ID || null,
            orgId: oid,
            schoolId: sid,
            studentId: it.ref.id,
            classId: data.classId || null,
            studentName: data.name || ''
          });
        } catch(e){ /* ignore per-doc failures */ }
      }
    } catch {}
  }
  try { console.debug('[setStatusForGroup] applied', { groupId, status, total }); } catch {}
  return total;
}

// Set status for all students that share a given carTag (now resolves group)
export async function setStatusForTag(tag, status) {
  await waitForTenant();
  const grp = await getGroupByTag(tag);
  if (grp && Array.isArray(grp.tags) && grp.tags.length){
    try { console.debug('[setStatusForTag] resolved group', { tag, groupId: grp.id, tags: grp.tags }); } catch {}
    return await setStatusForGroup(grp.id, status);
  }
  // Fallback to single-tag behavior (attempt original & tight variants)
  const original = normTag(tag);
  const compressed = tightTag(tag);
  try { console.debug('[setStatusForTag] fallback single tag path', { original, compressed, status }); } catch {}
  // Try original first
  let snap;
  try {
    const qy = query(colPath('students'), where('carTag', '==', original));
    snap = await getDocs(qy);
    if (!snap.empty){
      const batch = writeBatch(db);
      const toLog = [];
      snap.forEach(d => { batch.update(d.ref, { status, updatedAt: serverTimestamp() }); toLog.push({ ref: d.ref, data: d.data() }); });
      await batch.commit();
      // Log events
      try {
        const oid = globalThis.SD?.orgId || null;
        const sid = globalThis.SD?.schoolId || null;
        for (const it of toLog){
          try {
            const evtCol = collection(it.ref, 'events');
            const data = it.data || {};
            await addDoc(evtCol, { status, at: serverTimestamp(), sessionId: ACTIVE_SESSION_ID || null, orgId: oid, schoolId: sid, studentId: it.ref.id, classId: data.classId || null, studentName: data.name || '' });
          } catch {}
        }
      } catch {}
      try { console.debug('[setStatusForTag] updated original tag students', { tag: original, count: snap.size }); } catch {}
      return snap.size;
    }
  } catch(e){ /* ignore & retry compressed */ }
  if (compressed && compressed !== original){
    try {
      const qy2 = query(colPath('students'), where('carTag', '==', compressed));
      const snap2 = await getDocs(qy2);
      if (!snap2.empty){
        const batch2 = writeBatch(db);
        const toLog2 = [];
        snap2.forEach(d => { batch2.update(d.ref, { status, updatedAt: serverTimestamp() }); toLog2.push({ ref: d.ref, data: d.data() }); });
        await batch2.commit();
        // Log events
        try {
          const oid = globalThis.SD?.orgId || null;
          const sid = globalThis.SD?.schoolId || null;
          for (const it of toLog2){
            try {
              const evtCol = collection(it.ref, 'events');
              const data = it.data || {};
              await addDoc(evtCol, { status, at: serverTimestamp(), sessionId: ACTIVE_SESSION_ID || null, orgId: oid, schoolId: sid, studentId: it.ref.id, classId: data.classId || null, studentName: data.name || '' });
            } catch {}
          }
        } catch {}
        try { console.debug('[setStatusForTag] updated compressed tag students', { tag: compressed, count: snap2.size }); } catch {}
        return snap2.size;
      }
    } catch(e2){ /* final fallback: no-op */ }
  }
  try { console.debug('[setStatusForTag] no matches', { tag: original }); } catch {}
  return 0;
}

// Strict: update status only for students whose carTag exactly matches the provided tag.
// Does not resolve families or ride-share; useful when you want to target a single tag value only.
export async function setStatusForExactTag(tag, status) {
  await waitForTenant();
  const t = normTag(tag);
  if (!t) return;
  const qy = query(colPath('students'), where('carTag', '==', t));
  const snap = await getDocs(qy);
  if (snap.empty) return;
  const batch = writeBatch(db);
  const toLog = [];
  snap.forEach(d => { batch.update(d.ref, { status, updatedAt: serverTimestamp() }); toLog.push({ ref: d.ref, data: d.data() }); });
  await batch.commit();
  try {
    const oid = globalThis.SD?.orgId || null;
    const sid = globalThis.SD?.schoolId || null;
    for (const it of toLog){
      try {
        const evtCol = collection(it.ref, 'events');
        const data = it.data || {};
        await addDoc(evtCol, { status, at: serverTimestamp(), sessionId: ACTIVE_SESSION_ID || null, orgId: oid, schoolId: sid, studentId: it.ref.id, classId: data.classId || null, studentName: data.name || '' });
      } catch {}
    }
  } catch {}
}

// Set status for all students in all families that share the same rideShare key
export async function setStatusForRideShare(rideShare, status){
  await waitForTenant();
  const key = String(rideShare || '').trim();
  if (!key) return 0;
  const qy = query(colPath('carGroups'), where('rideShare', '==', key));
  const snap = await getDocs(qy);
  if (snap.empty) return 0;
  const allTags = [];
  snap.forEach(d => {
    const tags = (d.data().tags || []).map(normTag).filter(Boolean);
    allTags.push(...tags);
  });
  const uniq = Array.from(new Set(allTags));
  if (!uniq.length) return 0;
  // chunk into 10s for 'in' query
  const batches = chunk(uniq, 10);
  let total = 0;
  for (const batchTags of batches){
    const q2 = query(colPath('students'), where('carTag', 'in', batchTags));
    const s2 = await getDocs(q2);
    if (s2.empty) continue;
    const wb = writeBatch(db);
    const toLog = [];
    s2.forEach(d => { wb.update(d.ref, { status, updatedAt: serverTimestamp() }); total++; toLog.push({ ref: d.ref, data: d.data() }); });
    await wb.commit();
    try {
      const oid = globalThis.SD?.orgId || null;
      const sid = globalThis.SD?.schoolId || null;
      for (const it of toLog){
        try {
          const evtCol = collection(it.ref, 'events');
          const data = it.data || {};
          await addDoc(evtCol, { status, at: serverTimestamp(), sessionId: ACTIVE_SESSION_ID || null, orgId: oid, schoolId: sid, studentId: it.ref.id, classId: data.classId || null, studentName: data.name || '' });
        } catch {}
      }
    } catch {}
  }
  try { console.debug('[setStatusForRideShare] applied', { rideShare: key, status, total }); } catch {}
  return total;
}

/* ------------------------------------------------------------------ */
/* Car group pages helpers                                             */
/* ------------------------------------------------------------------ */

// Get a car entity by tag — prefers multi-tag group; falls back to legacy car doc.
export async function getCarByTag(tag) {
  await waitForTenant();
  const grp = await getGroupByTag(tag);
  if (grp) return grp;
  const t = normTag(tag);
  const d = await getDoc(docPath('cars', t));
  if (!d.exists()) return null;
  const data = d.data();
  return { id: t, name: data?.name || '', tags: [t] };
}

// Realtime students for a given carTag (now resolves groups and merges streams)
export function onTagStudents(tag, cb) {
  let unsubs = [];
  let stopped = false;
  const cleanup = () => { unsubs.forEach(u => { try { u(); } catch {} }); unsubs = []; };
  (async () => {
    try {
      await waitForTenant();
      if (stopped) return;
      const t = normTag(tag);
      const agg = new Map(); // id -> student
      // Resolve group
      let tags = [t];
      try {
        const grp = await getGroupByTag(t);
        if (grp && Array.isArray(grp.tags) && grp.tags.length) tags = grp.tags.map(normTag);
      } catch {}
      const chunksArr = chunk(tags, 10);
      cleanup();
      chunksArr.forEach(batch => {
        const qy = batch.length === 1
          ? query(colPath('students'), where('carTag', '==', batch[0]))
          : query(colPath('students'), where('carTag', 'in', batch));
        const u = onSnapshot(qy, (snap) => {
          snap.docChanges().forEach(ch => {
            const id = ch.doc.id;
            if (ch.type === 'removed') agg.delete(id);
            else agg.set(id, { ...ch.doc.data(), id });
          });
          const rows = Array.from(agg.values()).sort((a,b) => a.name.localeCompare(b.name));
          cb(rows);
        }, (err) => console.error('[onTagStudents] listener error:', err));
        unsubs.push(u);
      });
    } catch (e) { console.error('[onTagStudents] init failed:', e); }
  })();
  return () => { stopped = true; cleanup(); };
}

// Realtime students for a given groupId
export function onGroupStudents(groupId, cb){
  let unsubs = [];
  let stopped = false;
  const cleanup = () => { unsubs.forEach(u => { try { u(); } catch {} }); unsubs = []; };
  (async () => {
    try {
      await waitForTenant();
      if (stopped) return;
      const d = await getDoc(docPath('carGroups', groupId));
      const tags = (d.exists() ? (d.data().tags || []) : []).map(normTag);
      const chunksArr = chunk(tags, 10);
      const agg = new Map();
      cleanup();
      chunksArr.forEach(batch => {
        const qy = batch.length === 1
          ? query(colPath('students'), where('carTag', '==', batch[0]))
          : query(colPath('students'), where('carTag', 'in', batch));
        const u = onSnapshot(qy, (snap) => {
          snap.docChanges().forEach(ch => {
            const id = ch.doc.id;
            if (ch.type === 'removed') agg.delete(id);
            else agg.set(id, { ...ch.doc.data(), id });
          });
          const rows = Array.from(agg.values()).sort((a,b) => a.name.localeCompare(b.name));
          cb(rows);
        }, (err) => console.error('[onGroupStudents] listener error:', err));
        unsubs.push(u);
      });
    } catch (e) { console.error('[onGroupStudents] init failed:', e); }
  })();
  return () => { stopped = true; cleanup(); };
}

/* ------------------------------------------------------------------ */
/* (Optional) Demo seeding                                             */
/* ------------------------------------------------------------------ */
export async function seedDemo() {
  await waitForTenant();
  const existing = await getClasses();
  if (existing.length === 0) {
    const cls = [
      { id: 'K1',   name: 'Kindergarten 1', order: 1 },
      { id: 'G1-A', name: 'Grade 1 - A',    order: 2 },
      { id: 'G2-A', name: 'Grade 2 - A',    order: 3 }
    ];
    for (const c of cls) await setDoc(docPath('classes', c.id), c, { merge: true });
  }
  const sSnap = await getDocs(colPath('students'));
  if (sSnap.empty) {
    const sample = [
      { name: 'Alex Kim',  classId: 'K1',   carTag: 'A12', status: 'waiting' },
      { name: 'Bri Jones', classId: 'K1',   carTag: 'B34', status: 'waiting' },
      { name: 'Chris Lee', classId: 'G1-A', carTag: 'C56', status: 'waiting' },
      { name: 'Dana Wu',   classId: 'G2-A', carTag: 'D78', status: 'waiting' }
    ];
    for (const s of sample)
      await addDoc(colPath('students'), { ...s, updatedAt: serverTimestamp() });
  }
}

/* ------------------------------------------------------------------ */
/* Admin: per-school user membership writer (canonical: members/)      */
/* ------------------------------------------------------------------ */

// Write/update at orgs/{orgId}/schools/{schoolId}/members/{uid}
// payload may include roles as array OR map (e.g., { admin:true, caller:true })
export async function setSchoolUser(uid, payload = {}) {
  await waitForTenant();
  if (!uid) throw new Error('setSchoolUser requires uid');

  const me = (typeof auth !== 'undefined') ? auth.currentUser : null;

  // Normalize roles -> array
  let rolesArr = [];
  if (Array.isArray(payload.roles)) {
    rolesArr = payload.roles;
  } else if (Array.isArray(payload.roleList)) {
    rolesArr = payload.roleList;
  } else if (payload.roles && typeof payload.roles === 'object') {
    rolesArr = Object.entries(payload.roles).filter(([, v]) => !!v).map(([k]) => k);
  }
  rolesArr = Array.from(new Set(rolesArr.map(r => String(r || '').toLowerCase()).filter(Boolean)));

  // Layering: admin implies caller+viewer; caller implies viewer
  const rl = new Set(rolesArr);
  if (rl.has('admin')) { rl.add('caller'); rl.add('viewer'); }
  if (rl.has('caller')) rl.add('viewer');
  rolesArr = Array.from(rl);

  const body = {
    uid,
    email: payload.email || '',
    displayName: payload.displayName || '',
    roles: rolesArr,                  // canonical storage
    status: payload.status || 'active',
    source: 'admin-ui',
    updatedBy: me?.uid || null,
    updatedByEmail: me?.email || null,
    updatedAt: serverTimestamp()
  };

  // Canonical path only (no legacy mirror)
  await setDoc(docPath('members', uid), body, { merge: true });
}

/* ------------------------------------------------------------------ */
/* User Preferences (per-member)                                      */
/* ------------------------------------------------------------------ */
// Stored (new) at members/{uid}.prefs.bySchool[schoolId].favoriteClasses = []
// Backward compat: accept legacy members/{uid}.prefs.favoriteClasses (school-agnostic)
// Local fallback per school: key TTD_FAV_CLASSES_LOCAL__<schoolId>
const LOCAL_PREF_KEY_PREFIX = 'TTD_FAV_CLASSES_LOCAL__';
const LOCAL_SOUND_KEY = 'TTD_SOUND_PREF';

function currentUser() {
  try { return (typeof auth !== 'undefined') ? auth.currentUser : null; } catch { return null; }
}

export async function getMyPrefs(schoolIdOverride) {
  await waitForTenant();
  const u = currentUser();
  if (!u) return { favoriteClasses: [] };
  const sid = schoolIdOverride || globalThis.SD?.schoolId;
  try {
    const snap = await getDoc(docPath('members', u.uid));
    if (!snap.exists()) return { favoriteClasses: [] };
    const data = snap.data() || {};
    const prefs = data.prefs || {};
    // New structure
    const bySchool = prefs.bySchool && typeof prefs.bySchool === 'object' ? prefs.bySchool : {};
    let fav = [];
    if (sid && bySchool[sid] && Array.isArray(bySchool[sid].favoriteClasses)) {
      fav = bySchool[sid].favoriteClasses.filter(Boolean);
    } else if (Array.isArray(prefs.favoriteClasses)) { // legacy
      fav = prefs.favoriteClasses.filter(Boolean);
    }
    let sound = '';
    if (typeof prefs.sound === 'string' && prefs.sound.trim()) sound = prefs.sound.trim();
    // Local fallback for sound (global, not per-school)
    if (!sound) {
      try { const ls = localStorage.getItem(LOCAL_SOUND_KEY); if (ls) sound = ls; } catch {}
    }
    return { favoriteClasses: fav, sound };
  } catch (e) {
    try {
      const raw = localStorage.getItem(LOCAL_PREF_KEY_PREFIX + (sid || 'default'));
      if (raw) {
        const obj = JSON.parse(raw);
        const fav = Array.isArray(obj.favoriteClasses) ? obj.favoriteClasses.filter(Boolean) : [];
        // Sound fallback (stored separately)
        let sound = '';
        try { const ls = localStorage.getItem(LOCAL_SOUND_KEY); if (ls) sound = ls; } catch {}
        return { favoriteClasses: fav, sound, _local: true };
      }
    } catch {}
    let sound = '';
    try { const ls = localStorage.getItem(LOCAL_SOUND_KEY); if (ls) sound = ls; } catch {}
    return { favoriteClasses: [], sound, _error: true };
  }
}

export async function setMyPrefs(patch = {}, schoolIdOverride) {
  await waitForTenant();
  const u = currentUser();
  if (!u) return { ok: false, reason: 'no-user' };
  const sid = schoolIdOverride || globalThis.SD?.schoolId;
  const fav = Array.isArray(patch.favoriteClasses) ? Array.from(new Set(patch.favoriteClasses.filter(Boolean))) : undefined;
  const sound = (typeof patch.sound === 'string' && patch.sound.trim()) ? patch.sound.trim() : undefined;
  try {
    const ref = docPath('members', u.uid);
    const snap = await getDoc(ref).catch(()=>null);
    let existing = {};
    if (snap && snap.exists()) existing = snap.data() || {};
    const prevPrefs = existing.prefs || {};
    const bySchool = (prevPrefs.bySchool && typeof prevPrefs.bySchool === 'object') ? { ...prevPrefs.bySchool } : {};
    if (sid) {
      const prevEntry = bySchool[sid] || {};
      bySchool[sid] = { ...prevEntry };
      if (fav) bySchool[sid].favoriteClasses = fav;
    } else if (fav) {
      // No school context (edge) – store at legacy root for safety
      prevPrefs.favoriteClasses = fav;
    }
    if (sound) {
      prevPrefs.sound = sound; // global sound preference
    }
    const nextPrefs = { ...prevPrefs, bySchool };
    await setDoc(ref, { prefs: nextPrefs }, { merge: true });
    try { localStorage.setItem(LOCAL_PREF_KEY_PREFIX + (sid || 'default'), JSON.stringify({ favoriteClasses: fav || [] })); } catch {}
    if (sound) { try { localStorage.setItem(LOCAL_SOUND_KEY, sound); } catch {} }
    return { ok: true };
  } catch (e) {
    try {
      if (fav) localStorage.setItem(LOCAL_PREF_KEY_PREFIX + (sid || 'default'), JSON.stringify({ favoriteClasses: fav, _ts: Date.now() }));
      if (sound) localStorage.setItem(LOCAL_SOUND_KEY, sound);
      return { ok: true, localOnly: true };
    } catch {}
    return { ok: false, reason: e?.message || 'fail' };
  }
}

/* ------------------------------------------------------------------ */
/* Per-teacher student nicknames (private to teacher)                  */
/* ------------------------------------------------------------------ */

import { onSnapshot as _onSnapshot, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';

// Listen to current user's nickname docs: /members/{uid}/nicknames/{studentId}
// cb receives an object map { studentId: { name: string|undefined, sound: string|undefined } }
export function onMyNicknames(cb){
  let unsub = () => {};
  (async () => {
    try {
      await waitForTenant();
      const u = currentUser(); if (!u) return;
      const sid = globalThis.SD?.schoolId; const oid = globalThis.SD?.orgId;
      if (!sid || !oid) return;
      const colRef = collection(db, 'orgs', oid, 'schools', sid, 'members', u.uid, 'nicknames');
      unsub = _onSnapshot(colRef, (snap) => {
        const map = {};
        snap.docs.forEach(d => {
          const data = d.data() || {};
          let name = '';
          try { if (data.name && typeof data.name === 'string') name = data.name.trim(); } catch {}
          let sound = '';
            try { if (data.sound && typeof data.sound === 'string') sound = data.sound.trim(); } catch {}
          // Always include object even if name empty (allows sound-only override)
          map[d.id] = { name: name || undefined, sound: sound || undefined };
        });
        try { cb(map); } catch {}
      }, (err) => console.error('[onMyNicknames] listener error:', err));
    } catch (e) { console.error('[onMyNicknames] init failed:', e); }
  })();
  return () => { try { unsub(); } catch {} };
}

// Set or clear a nickname (and optional private sound) for a student.
// If both nickname and sound are empty/blank, the doc is deleted.
export async function setMyNickname(studentId, nickname, sound){
  await waitForTenant();
  const u = currentUser(); if (!u) throw new Error('no-user');
  const sid = globalThis.SD?.schoolId; const oid = globalThis.SD?.orgId;
  if (!sid || !oid) throw new Error('missing tenant');
  const trimmed = (nickname || '').trim();
  const trimmedSound = (sound || '').trim();
  const ref = doc(db, 'orgs', oid, 'schools', sid, 'members', u.uid, 'nicknames', studentId);
  if (!trimmed && !trimmedSound){
    try { await deleteDoc(ref); } catch {}
    return { ok: true, deleted: true };
  }
  if (trimmed && trimmed.length > 60) throw new Error('Nickname too long (max 60 chars)');
  if (trimmedSound && trimmedSound.length > 80) throw new Error('Sound id too long (max 80 chars)');
  // Ensure cleared fields are actually removed (previous logic left stale name when cleared but sound kept)
  let deleteFieldFn = null;
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js');
    deleteFieldFn = mod.deleteField;
  } catch {}
  const payload = { updatedAt: serverTimestamp() };
  if (trimmed) payload.name = trimmed; else if (deleteFieldFn) payload.name = deleteFieldFn();
  if (trimmedSound) payload.sound = trimmedSound; else if (deleteFieldFn) payload.sound = deleteFieldFn();
  try {
    await setDoc(ref, payload, { merge: true });
    try { console.debug('[nicknames] setMyNickname success', { studentId, payload }); } catch {}
    return { ok: true };
  } catch (e){
    console.error('[nicknames] setMyNickname failed', studentId, e);
    throw e;
  }
}
