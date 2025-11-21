// functions/index.js
// Node 18  •  Firebase Functions v2  •  CommonJS

// ───────────────── Imports ─────────────────
const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { beforeUserSignedIn } = require('firebase-functions/v2/identity');
const { defineBoolean } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

try { initializeApp(); } catch (_) { }
const auth = getAuth();
const db = getFirestore();
// Basic CORS wrapper for HTTP shim endpoints (preview channel safe)
const allowCors = (handler) => async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  // Allow credentials if you later restrict origins
  // res.set('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try { await handler(req, res); } catch (e) {
    console.warn('[allowCors] handler error', e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'internal' });
  }
};
// Prefer runtime param (deployable via .env or CLI). Fallback to process.env for backward compatibility.
// Safety-first: default disabled to prevent sign-in outages if indexes are missing or queries are slow.
const PARAM_ENABLE_BEFORE_SIGNIN = defineBoolean('ENABLE_BEFORE_SIGNIN', { default: false });
const ENABLE_BEFORE_SIGNIN =
  (typeof process !== 'undefined' && process.env && typeof process.env.ENABLE_BEFORE_SIGNIN === 'string')
    ? (String(process.env.ENABLE_BEFORE_SIGNIN).toLowerCase() === 'true')
    : PARAM_ENABLE_BEFORE_SIGNIN.value();

// ───────────────── Small helpers ─────────────────
const ts = () => FieldValue.serverTimestamp();
const norm = (s) => String(s || '').trim().toLowerCase();
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

const flagsFrom = (src) => {
  // Accepts {roles:{admin,caller,viewer}} or roles array or role string
  const map =
    (src && typeof src.roles === 'object' && !Array.isArray(src.roles)) ? src.roles :
      (Array.isArray(src?.roles)) ? src.roles.reduce((m, k) => (m[norm(k)] = true, m), {}) :
        (src?.role) ? { [norm(src.role)]: true } : {};

  const admin = !!map.admin;
  const caller = admin || !!map.caller;
  const viewer = caller || !!map.viewer;
  const role = admin ? 'admin' : caller ? 'caller' : viewer ? 'viewer' : null;
  return { role, admin, caller, viewer };
};

const parseMemberPath = (ref) => {
  // Supports:
  //   orgs/{orgId}/members/{uid}                                   (scope: 'org')
  //   orgs/{orgId}/schools/{schoolId}/members/{uid}                (scope: 'school')
  const coll = ref.parent;                   // members
  const parent = coll.parent;                // orgs/{orgId} OR schools/{schoolId}
  if (parent.parent && parent.parent.id === 'schools') {
    // parent is schools/{schoolId}
    const schoolId = parent.id;
    const orgId = parent.parent.parent.id;  // orgs/{orgId}
    return { orgId, schoolId };
  }
  // org-level members
  return { orgId: parent.id, schoolId: null };
};

// Write a per-user doc the client can read to invalidate tokens immediately.
const bumpUserTokens = async (uid, extra = {}) => {
  try { await auth.revokeRefreshTokens(uid); } catch (_) { }
  await db.doc(`users/${uid}`).set({
    claimsVersion: FieldValue.increment(1),
    tokensValidAfterSec: Math.floor(Date.now() / 1000),
    updatedAt: ts(),
    ...extra,
  }, { merge: true });
};

// Bump only the claimsVersion to notify clients, without revoking tokens
const bumpClaimsVersion = async (uid, extra = {}) => {
  await db.doc(`users/${uid}`).set({
    claimsVersion: FieldValue.increment(1),
    updatedAt: ts(),
    ...extra,
  }, { merge: true });
};

// ───────────────── Claims aggregation (single source of truth) ─────────────────
async function computeClaims(uid, email) {
  const emailLower = norm(email);
  const base = {
    owner: false, superintendent: false, admin: false, caller: false, viewer: false, guardian: false,
    orgIds: [], schoolIds: []
  };

  // Owner? (store this on users/{uid}.owner = true)
  const uDoc = await db.doc(`users/${uid}`).get().catch(() => null);
  if (uDoc?.exists) {
    if (uDoc.get('owner') === true) base.owner = true;
    if (uDoc.get('guardian') === true) base.guardian = true;
  }

  // Superintendent — two ways:
  // 1) orgs where orgs.superEmails contains user email (recommended to maintain when adding/removing supers)
  const superViaEmail = await db.collection('orgs')
    .where('superEmails', 'array-contains', emailLower).get().catch(() => null);
  if (superViaEmail && !superViaEmail.empty) {
    base.superintendent = true;
    base.orgIds.push(...superViaEmail.docs.map(d => d.id));
  }

  // 2) org-level member docs marking superintendent
  const orgMemberSnap = await db.collectionGroup('members')
    .where('scope', '==', 'org').where('uid', '==', uid).get();
  for (const d of orgMemberSnap.docs) {
    const data = d.data() || {};
    if ((data.status || 'active') !== 'active') continue;
    const roles = Array.isArray(data.roles) ? data.roles.map(norm)
      : Object.keys(data.roles || {}).filter(k => data.roles[k]).map(norm);
    if (roles.includes('superintendent')) {
      base.superintendent = true;
      const { orgId } = parseMemberPath(d.ref);
      if (orgId) base.orgIds.push(orgId);
    }
  }

  // School memberships (admin/caller/viewer)
  const schoolSnap = await db.collectionGroup('members')
    .where('scope', '==', 'school').where('uid', '==', uid).get();
  let hasAdmin = false, hasCaller = false, hasViewer = false;
  for (const d of schoolSnap.docs) {
    const data = d.data() || {};
    if ((data.status || 'active') !== 'active') continue;
    const { orgId, schoolId } = parseMemberPath(d.ref);
    if (orgId) base.orgIds.push(orgId);
    if (schoolId) base.schoolIds.push(schoolId);

    const f = flagsFrom(data);
    hasAdmin = hasAdmin || f.admin;
    hasCaller = hasCaller || f.caller;
    hasViewer = hasViewer || f.viewer;
  }

  base.orgIds = uniq(base.orgIds);
  base.schoolIds = uniq(base.schoolIds);

  // Collapse flags (viewer implied by any higher role or superintendent)
  base.admin = !!hasAdmin;
  base.caller = !!hasCaller || base.admin;
  base.viewer = !!hasViewer || base.caller || base.admin || base.superintendent;

  // Convenience anchors
  if (base.orgIds.length === 1) base.orgId = base.orgIds[0];
  if (base.schoolIds.length >= 1) base.schoolId = base.schoolIds[0];

  // Primary role label (owner > admin > caller > viewer > superintendent)
  if (base.owner) base.role = 'owner';
  else if (base.admin) base.role = 'admin';
  else if (base.caller) base.role = 'caller';
  else if (base.viewer && !base.superintendent) base.role = 'viewer';
  else if (base.superintendent) base.role = base.role || 'superintendent';

  // Also include a roles[] array to align with rules.hasRole() checks
  const rolesArr = [];
  if (base.owner) rolesArr.push('owner');
  if (base.superintendent) rolesArr.push('superintendent');
  if (base.admin) rolesArr.push('admin');
  if (base.caller) rolesArr.push('caller');
  if (base.viewer) rolesArr.push('viewer');
  if (base.guardian) rolesArr.push('guardian');
  base.roles = rolesArr;

  return base;
}

async function applyClaims(uid, email, reason = 'recompute', opts = {}) {
  const claims = await computeClaims(uid, email);
  await auth.setCustomUserClaims(uid, claims);
  // Default: do NOT revoke refresh tokens on every claim change, to avoid bouncing user sessions.
  // Only revoke when explicitly requested (e.g., admin actions) to force a full re-auth.
  if (opts && opts.revoke === true) {
    await bumpUserTokens(uid, { reason });
  } else {
    await bumpClaimsVersion(uid, { reason });
  }
  return claims;
}

// ───────────────── Auth Blocking (instant claims on first token) ─────────────────
// Runs BEFORE a session starts; puts final roles/orgs/schools into the first ID token.
if (ENABLE_BEFORE_SIGNIN) {
  const withTimeout = (p, ms = 2000) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, Math.max(500, ms));
    p.then((v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } })
      .catch((_) => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
  });
  exports.beforeSignIn = beforeUserSignedIn(async (event) => {
    try {
      const { uid, email } = event.data || {};
      if (!uid) return {};
      const claims = await withTimeout(computeClaims(uid, email || ''), 2000);
      if (claims && typeof claims === 'object') return { customClaims: claims };
      // Degrade gracefully: allow sign-in with no custom claims; clients can call refreshMyClaims later
      return {};
    } catch (e) {
      console.warn('[beforeSignIn] degraded due to error:', e?.message || e);
      return {};
    }
  });
}

// ───────────────── Triggers (recompute after writes) ─────────────────
exports.onSchoolMemberWrite = onDocumentWritten(
  { document: 'orgs/{orgId}/schools/{schoolId}/members/{uid}', region: 'us-central1', minInstances: 0 },
  async (event) => {
    const after = event.data.after?.data();
    const before = event.data.before?.data();
    const uid = after?.uid || before?.uid || event.params.uid;
    if (!uid) return;
    const user = await auth.getUser(uid).catch(() => null);
    if (!user) return;
    await applyClaims(uid, user.email || '', 'school-membership-changed');
  }
);

exports.onOrgMemberWrite = onDocumentWritten(
  { document: 'orgs/{orgId}/members/{uid}', region: 'us-central1', minInstances: 0 },
  async (event) => {
    const uid = event.params.uid;
    const user = await auth.getUser(uid).catch(() => null);
    if (!user) return;
    await applyClaims(uid, user.email || '', 'org-membership-changed');
  }
);

// Optional: if you edit org.superEmails manually, keep claims in sync
exports.onOrgDocWrite = onDocumentWritten(
  { document: 'orgs/{orgId}', region: 'us-central1', minInstances: 0 },
  async (event) => {
    const before = event.data.before?.data() || {};
    const after = event.data.after?.data() || {};
    const prev = new Set((before.superEmails || []).map(norm));
    const next = new Set((after.superEmails || []).map(norm));
    const touched = new Set([...prev, ...next]);
    for (const email of touched) {
      if (!email) continue;
      const user = await auth.getUserByEmail(email).catch(() => null);
      if (user) await applyClaims(user.uid, user.email || '', 'org-superEmails-changed');
    }
  }
);

// ───────────────── Authorization helpers ─────────────────
const assertAuthed = (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
};

const canManageOrg = (claims, orgId) => {
  if (claims?.owner) return true;
  if (claims?.superintendent && Array.isArray(claims.orgIds) && claims.orgIds.includes(orgId)) return true;
  return false;
};

const canManageSchool = async (claims, orgId, schoolId, uid) => {
  if (canManageOrg(claims, orgId)) return true;
  const ref = db.doc(`orgs/${orgId}/schools/${schoolId}/members/${uid}`);
  const snap = await ref.get();
  const d = snap.data() || {};
  const f = flagsFrom(d);
  return (d.status || 'active') === 'active' && f.admin;
};

// ───────────────── Callables ─────────────────

// Owner bootstrap (one-time)
exports.ownerGrant = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  if (norm(req.auth.token.email) !== 'carlsonandy85@gmail.com') {
    throw new HttpsError('permission-denied', 'Nope.');
  }
  await auth.setCustomUserClaims(req.auth.uid, {
    role: 'owner',
    orgIds: ['*'],
    schoolIds: ['*'],
    roles: ['owner']
  });
  // Persist an owner marker in Firestore so future claim recomputations (computeClaims)
  // continue to recognize this user as owner. Previously we only set custom claims;
  // the next trigger-based recompute would drop owner because users/{uid}.owner was absent.
  try {
    await db.doc(`users/${req.auth.uid}`).set({ owner: true, updatedAt: ts() }, { merge: true });
  } catch (e) {
    console.warn('Failed to persist owner flag', e);
  }
  // "takes two times to login" experience. Instead, bump claimsVersion so clients
  // refresh their ID token on the next tick via the header listener.
  await bumpClaimsVersion(req.auth.uid, { reason: 'owner-grant' });
  return { ok: true };
});

// Create org + superintendent (owner only)
exports.createSuperintendent = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  if (!req.auth.token?.owner) throw new HttpsError('permission-denied', 'Owner only.');

  const { email, orgName, allowedSchools = 1, orgId } = req.data || {};
  if (!email || !orgName) throw new HttpsError('invalid-argument', 'Email and orgName required.');

  let user;
  try { user = await auth.getUserByEmail(email); }
  catch { user = await auth.createUser({ email }); }

  const orgRef = orgId ? db.collection('orgs').doc(String(orgId)) : db.collection('orgs').doc();
  if (orgId && (await orgRef.get()).exists) throw new HttpsError('already-exists', 'orgId already exists.');

  await orgRef.set({
    name: orgName,
    allowedSchools,
    usedSchools: 0,
    status: 'active',
    // Keep a fast superintendent lookup
    superEmails: FieldValue.arrayUnion(norm(user.email || email)),
    createdAt: ts(),
    updatedAt: ts(),
  }, { merge: true });

  // Org-level member (scope=org) marks superintendent
  await orgRef.collection('members').doc(user.uid).set({
    scope: 'org',
    uid: user.uid,
    email: user.email || email,
    displayName: user.displayName || null,
    roles: ['superintendent'],
    status: 'active',
    createdAt: ts(),
    updatedAt: ts(),
    addedBy: { uid: req.auth.uid, email: req.auth.token.email || null },
  }, { merge: true });

  // Apply claims immediately (no waiting for trigger)
  await applyClaims(user.uid, user.email || email, 'create-superintendent');

  return { ok: true, orgId: orgRef.id, uid: user.uid };
});


// (Removed duplicated access grant callables here — canonical versions are defined later under Parent-to-parent Access Grants.)
// Owner: add/remove superintendent
exports.ownerAddSuperintendent = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  if (!req.auth.token?.owner) throw new HttpsError('permission-denied', 'Owner only.');
  const { orgId, email } = req.data || {};
  if (!orgId || !email) throw new HttpsError('invalid-argument', 'orgId and email required.');

  let user;
  try { user = await auth.getUserByEmail(email); }
  catch { user = await auth.createUser({ email }); }

  const orgRef = db.doc(`orgs/${orgId}`);
  await orgRef.set({
    superEmails: FieldValue.arrayUnion(norm(user.email || email)),
    updatedAt: ts(),
  }, { merge: true });

  await orgRef.collection('members').doc(user.uid).set({
    scope: 'org',
    uid: user.uid,
    email: user.email || email,
    displayName: user.displayName || null,
    roles: ['superintendent'],
    status: 'active',
    updatedAt: ts(),
    createdAt: ts(),
    addedBy: { uid: req.auth.uid, email: req.auth.token.email || null },
  }, { merge: true });

  await applyClaims(user.uid, user.email || email, 'owner-add-superintendent');
  return { ok: true, uid: user.uid };
});

exports.ownerRemoveSuperintendent = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  if (!req.auth.token?.owner) throw new HttpsError('permission-denied', 'Owner only.');
  const { orgId, uid, email } = req.data || {};
  if (!orgId || !uid) throw new HttpsError('invalid-argument', 'orgId and uid required.');

  await db.doc(`orgs/${orgId}/members/${uid}`).set({ status: 'removed', updatedAt: ts() }, { merge: true });
  if (email) {
    await db.doc(`orgs/${orgId}`).set({
      superEmails: FieldValue.arrayRemove(norm(email)),
      updatedAt: ts(),
    }, { merge: true });
  }
  const user = await auth.getUser(uid).catch(() => null);
  if (user) await applyClaims(uid, user.email || '', 'owner-remove-superintendent');
  return { ok: true };
});

// Reset all students in a school to 'waiting' (admin or caller for that school)
exports.resetAllToWaiting = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const claims = req.auth.token || {};
  const uid = req.auth.uid;
  const { orgId, schoolId } = req.data || {};
  if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');

  // Allow owner/superintendent/admin via canManageSchool; also allow active school callers
  let allowed = await canManageSchool(claims, orgId, schoolId, uid);
  if (!allowed) {
    try {
      const memSnap = await db.doc(`orgs/${orgId}/schools/${schoolId}/members/${uid}`).get();
      const data = memSnap.data() || {};
      const flags = flagsFrom(data);
      allowed = (data.status || 'active') === 'active' && (flags.admin || flags.caller);
    } catch (_) { allowed = false; }
  }
  if (!allowed) throw new HttpsError('permission-denied', 'Caller or Admin for this school required.');

  const col = db.collection('orgs').doc(orgId).collection('schools').doc(schoolId).collection('students');
  const snap = await col.get();
  let changed = 0, scanned = 0;
  let batch = db.batch();
  let ops = 0;
  const FLUSH = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const d of snap.docs) {
    scanned++;
    const st = (d.get('status') || '').toString();
    if (st !== 'waiting') {
      batch.update(d.ref, { status: 'waiting', updatedAt: ts() });
      changed++; ops++;
      if (ops >= 450) await FLUSH();
    }
  }
  await FLUSH();
  return { ok: true, scanned, changed };
});

// ───────────────── Auto end stale call sessions (backend safety net) ─────────────────
// Why: client pages enforce auto-end with a timer, but if no caller keeps a page open,
// sessions can remain active for hours. This scheduled job ends sessions that exceed
// the per-school configured cap (settings/dismissal.autoEndMinutes, default 30).
exports.autoEndStaleSessions = onSchedule({
  schedule: 'every 5 minutes',
  region: 'us-central1',
  timeZone: 'America/Chicago', // adjust to your primary tenant timezone if needed
  minInstances: 0,
}, async () => {
  const nowMs = Date.now();
  const ended = [];
  try {
    // Scan all active sessions (endedAt == null). Expected volume is tiny per org.
    const snap = await db.collectionGroup('callSessions').where('endedAt', '==', null).get();
    for (const d of snap.docs) {
      const data = d.data() || {};
      const started = data.startedAt;
      if (!started || typeof started.toMillis !== 'function') continue;
      // Parse path: orgs/{orgId}/schools/{schoolId}/callSessions/{id}
      const seg = d.ref.path.split('/');
      if (seg.length < 6) continue;
      const orgId = seg[1];
      const schoolId = seg[3];

      // Load autoEndMinutes from school settings; fall back to 30 (bounded 5..240)
      let autoEndMinutes = 30;
      try {
        const setRef = db.doc(`orgs/${orgId}/schools/${schoolId}/settings/dismissal`);
        const setSnap = await setRef.get();
        if (setSnap.exists) {
          const cfg = setSnap.data() || {};
          const v = Number(cfg.autoEndMinutes);
          if (!Number.isNaN(v) && v >= 5 && v <= 240) autoEndMinutes = v;
        }
      } catch (_) { /* default */ }

      const ageMs = nowMs - started.toMillis();
      if (ageMs >= autoEndMinutes * 60000) {
        try {
          await d.ref.update({ endedAt: ts() });
          // Nudge classes with a dismissal-over signal
          try {
            await db.doc(`orgs/${orgId}/schools/${schoolId}/signals/dismissal`)?.set({
              message: 'Dismissal auto-ended by system',
              lastAt: ts(),
              seq: FieldValue.increment(1),
            }, { merge: true });
          } catch (sigErr) { console.warn('[autoEnd] signal failed', sigErr); }
          ended.push(d.id);
        } catch (e) {
          console.warn('[autoEnd] failed to end', d.ref.path, e);
        }
      }
    }
  } catch (e) {
    console.warn('[autoEnd] scan failed', e);
  }
  if (ended.length) console.log('[autoEnd] ended sessions:', ended.join(','));
});

// Add a school (owner or superintendent of that org)
exports.addSchool = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const claims = req.auth.token || {};
  const { orgId, schoolName } = req.data || {};
  if (!orgId || !schoolName) throw new HttpsError('invalid-argument', 'orgId and schoolName required.');
  if (!canManageOrg(claims, orgId)) throw new HttpsError('permission-denied', 'Owner or assigned Superintendent only.');

  const slug = (s) => String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  const orgRef = db.doc(`orgs/${orgId}`);
  const result = await db.runTransaction(async (tx) => {
    const orgSnap = await tx.get(orgRef);
    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
    const org = orgSnap.data() || {};
    const allowed = Number(org.allowedSchools || 0);
    const used = Number(org.usedSchools || 0);
    if (allowed > 0 && used >= allowed) throw new HttpsError('resource-exhausted', 'School quota reached.');

    const schoolsCol = orgRef.collection('schools');
    let schoolId = slug(schoolName) || schoolsCol.doc().id;
    for (let i = 1; i <= 5; i++) {
      const exists = (await tx.get(schoolsCol.doc(schoolId))).exists;
      if (!exists) break;
      const base = slug(schoolName) || 'school';
      schoolId = `${base}-${i}`.slice(0, 40);
    }

    tx.set(schoolsCol.doc(schoolId), { name: schoolName, status: 'active', createdAt: ts(), updatedAt: ts() }, { merge: true });
    tx.update(orgRef, { usedSchools: (used || 0) + 1, updatedAt: ts() });
    return { schoolId };
  });

  return { ok: true, ...result };
});

// Set roles for a school member (canonical write = members/)
exports.setSchoolMemberRoles = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const { orgId, schoolId, user = {}, roles = {} } = req.data || {};
  if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');

  const claims = req.auth.token || {};
  const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
  if (!allowed) throw new HttpsError('permission-denied', 'Admin or higher required for this school.');

  // Resolve/create target user
  let target = null;
  if (user.uid) { try { target = await auth.getUser(String(user.uid)); } catch { } }
  if (!target && user.email) {
    try { target = await auth.getUserByEmail(String(user.email)); }
    catch { target = await auth.createUser({ email: String(user.email) }); }
  }
  if (!target) throw new HttpsError('not-found', 'Provide a valid uid or email.');

  // Normalize role booleans (viewer implied by caller/admin)
  const r = {
    admin: !!roles.admin,
    caller: !!roles.admin || !!roles.caller,
    viewer: !!roles.admin || !!roles.caller || !!roles.viewer,
  };
  const status = (r.admin || r.caller || r.viewer) ? 'active' : 'removed';

  const ref = db.doc(`orgs/${orgId}/schools/${schoolId}/members/${target.uid}`);
  const payload = {
    scope: 'school',
    uid: target.uid,
    email: target.email || String(user.email || ''),
    emailLower: norm(target.email || user.email || ''),
    displayName: target.displayName || null,
    roles: r,
    status,
    updatedAt: ts(),
    createdAt: ts(),
    addedBy: { uid: req.auth.uid, email: claims.email || null },
  };
  const snap = await ref.get();
  if (snap.exists) delete payload.createdAt;

  await ref.set(payload, { merge: true });

  // Apply claims immediately so the UI updates without waiting for trigger
  await applyClaims(target.uid, target.email || user.email || '', 'set-school-member-roles');

  return { ok: true, uid: target.uid, roles: r, status };
});

// List school members
exports.listSchoolMembers = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const { orgId, schoolId } = req.data || {};
  if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');

  const claims = req.auth.token || {};
  const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
  if (!allowed) throw new HttpsError('permission-denied', 'Admin or higher required for this school.');

  const snap = await db.collection(`orgs/${orgId}/schools/${schoolId}/members`)
    .where('status', 'in', ['active', null]).get();

  const members = snap.docs.map(d => {
    const x = d.data() || {};
    const f = flagsFrom(x);
    return {
      id: x.uid || d.id,
      uid: x.uid || null,
      email: x.email || x.emailLower || null,
      displayName: x.displayName || null,
      roles: { admin: f.admin, caller: f.caller, viewer: f.viewer },
      status: x.status || 'active',
      updatedAt: x.updatedAt || null,
      classIds: Array.isArray(x?.teacher?.classIds) ? x.teacher.classIds.filter(Boolean) : []
    };
  });

  return { ok: true, members };
});

// List classes for a school (ordered) — lightweight read used by roles UI
exports.listSchoolClasses = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const { orgId, schoolId } = req.data || {};
  if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');
  const claims = req.auth.token || {};
  const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
  if (!allowed) throw new HttpsError('permission-denied', 'Admin or higher required.');
  const col = db.collection(`orgs/${orgId}/schools/${schoolId}/classes`);
  let docs = [];
  try {
    const snap = await col.orderBy('order', 'asc').get();
    docs = snap.docs;
  } catch (e) {
    // fallback name
    try { const snap2 = await col.orderBy('name', 'asc').get(); docs = snap2.docs; }
    catch { const snap3 = await col.get(); docs = snap3.docs; }
  }
  const classes = docs.map(d => {
    const data = d.data() || {};
    const out = { id: d.id, name: data.name || data.title || d.id };
    if (typeof data.order === 'number') out.order = data.order;
    return out;
  }).sort((a, b) => {
    const ao = (typeof a.order === 'number') ? a.order : 999999;
    const bo = (typeof b.order === 'number') ? b.order : 999999;
    if (ao !== bo) return ao - bo;
    return (a.name || a.id || '').localeCompare(b.name || b.id || '');
  });
  return { ok: true, classes };
});

// Assign classes to a teacher/member
// Stores at members/{uid}.teacher.classIds (array)
exports.setTeacherClasses = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const { orgId, schoolId, memberId, classIds } = req.data || {};
  if (!orgId || !schoolId || !memberId) throw new HttpsError('invalid-argument', 'orgId, schoolId, memberId required.');
  if (classIds && !Array.isArray(classIds)) throw new HttpsError('invalid-argument', 'classIds must be array.');
  const claims = req.auth.token || {};
  const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
  if (!allowed) throw new HttpsError('permission-denied', 'Admin or higher required.');
  const ref = db.doc(`orgs/${orgId}/schools/${schoolId}/members/${memberId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Member not found.');
  const clean = (classIds || []).map(c => String(c || '').trim()).filter(Boolean);
  await ref.set({ teacher: { classIds: clean }, updatedAt: ts() }, { merge: true });
  return { ok: true, classIds: clean };
});

// Invite then set initial role (writes members/; claims applied immediately)
exports.inviteUser = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const claims = req.auth.token || {};
  const { email, orgId, schoolId, role = 'admin' } = req.data || {};
  if (!email || !orgId || !schoolId) throw new HttpsError('invalid-argument', 'email, orgId, schoolId required.');
  if (!canManageOrg(claims, orgId)) throw new HttpsError('permission-denied', 'Owner/Superintendent only.');

  let user;
  try { user = await auth.getUserByEmail(String(email)); }
  catch { user = await auth.createUser({ email: String(email) }); }

  const r = flagsFrom({ role: String(role) });
  await db.doc(`orgs/${orgId}/schools/${schoolId}/members/${user.uid}`).set({
    scope: 'school',
    uid: user.uid,
    email: user.email || String(email),
    emailLower: norm(user.email || email),
    displayName: user.displayName || null,
    roles: { admin: r.admin, caller: r.caller, viewer: r.viewer },
    status: 'active',
    createdAt: ts(),
    updatedAt: ts(),
    addedBy: { uid: req.auth.uid, email: claims.email || null },
  }, { merge: true });

  await applyClaims(user.uid, user.email || email, 'invite-user');

  return { ok: true, uid: user.uid };
});

// Recompute claims for the current user (self-service)
exports.refreshMyClaims = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const user = await auth.getUser(req.auth.uid);
  // IMPORTANT: Do not revoke on self-service refresh to avoid bouncing other sessions/devices
  const claims = await applyClaims(user.uid, user.email || '', 'manual-refresh', { revoke: false });
  return { ok: true, claims };
});

// Admin: force revoke a user’s tokens (owner or any superintendent)
exports.adminRevokeUserTokens = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const claims = req.auth.token || {};
  const { uid, reason = 'admin-revoke' } = req.data || {};
  if (!uid) throw new HttpsError('invalid-argument', 'uid required');
  if (!claims.owner && !claims.superintendent) throw new HttpsError('permission-denied', 'Owner or Superintendent only');
  await bumpUserTokens(uid, { reason });
  return { ok: true };
});

// Delete a school and all nested data, then recompute usedSchools
exports.deleteSchool = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const claims = req.auth.token || {};
  const { orgId, schoolId } = req.data || {};
  if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');
  if (!canManageOrg(claims, orgId)) throw new HttpsError('permission-denied', 'Owner or assigned Superintendent only.');

  const orgRef = db.doc(`orgs/${orgId}`);
  const schoolRef = orgRef.collection('schools').doc(String(schoolId));
  const schoolSnap = await schoolRef.get();
  if (!schoolSnap.exists) {
    // Idempotent: nothing to do; still reconcile quota
  } else {
    // Recursive delete via BulkWriter for speed
    const bw = db.bulkWriter();
    const deleteDocumentRecursively = async (docRef) => {
      const subcols = await docRef.listCollections();
      for (const sub of subcols) {
        const docs = await sub.listDocuments();
        for (const d of docs) {
          await deleteDocumentRecursively(d);
        }
      }
      bw.delete(docRef);
    };
    await deleteDocumentRecursively(schoolRef);
    await bw.close();
  }

  // Recompute org.usedSchools based on live count
  const rem = await orgRef.collection('schools').listDocuments();
  await orgRef.set({ usedSchools: rem.length, updatedAt: ts() }, { merge: true });
  return { ok: true, usedSchools: rem.length };
});

// Keep org.usedSchools in sync when schools are created/deleted (safety net)
exports.onSchoolsWrite = onDocumentWritten(
  { document: 'orgs/{orgId}/schools/{schoolId}', region: 'us-central1', minInstances: 0 },
  async (event) => {
    const orgId = event.params.orgId;
    if (!orgId) return;
    const orgRef = db.doc(`orgs/${orgId}`);
    const docs = await orgRef.collection('schools').listDocuments();
    await orgRef.set({ usedSchools: docs.length, updatedAt: ts() }, { merge: true });
  }
);

// ───────────────── Guardian Invites & Claims ─────────────────
function randomToken(bytes = 16) {
  try { return crypto.randomBytes(bytes).toString('base64url'); }
  catch { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
}
function shortCode8() {
  const alphabet = 'ABCDEFGHJKMNPqrstuvwxyz23456789abcdefghjkmnpQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return (s.slice(0, 4) + '-' + s.slice(4)).toUpperCase();
}
function parseInvitePath(p) {
  // orgs/{orgId}/schools/{schoolId}/invites/{inviteId}
  const seg = String(p || '').split('/');
  if (seg.length < 6) return { orgId: null, schoolId: null, inviteId: null };
  return { orgId: seg[1], schoolId: seg[3], inviteId: seg[5] };
}

// Admin/staff: create a guardian claim invite for a student
// Input: { orgId, schoolId, studentId, email?, relationshipType? }
// NOTE: Added explicit cors:true to support preview channel hosting domains (e.g., dismissalcaller--dev-<id>.web.app)
// Without this, some preview subdomains were failing the automatic callable CORS preflight.
exports.createGuardianInvite = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  console.log('[createGuardianInvite] invoked');
  assertAuthed(req);
  const claims = req.auth.token || {};
  const { orgId, schoolId, studentId, email = null, relationshipType = 'primary', daysValid = 14 } = req.data || {};
  if (!orgId || !schoolId || !studentId) throw new HttpsError('invalid-argument', 'orgId, schoolId, studentId required.');
  const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
  if (!allowed) throw new HttpsError('permission-denied', 'Admin for this school required.');

  const invitesCol = db.collection('orgs').doc(orgId).collection('schools').doc(schoolId).collection('invites');
  const token = 'PT-' + randomToken(16); // Prefix avoids tag collisions
  const code8 = shortCode8();
  const inviteRef = invitesCol.doc();
  const expiresAt = FieldValue.serverTimestamp(); // set placeholder, then backfill with absolute date in an extra write not needed — keep server TS and store daysValid

  const payload = {
    type: 'guardian-claim',
    studentId: String(studentId),
    relationshipType: String(relationshipType || 'primary'),
    email: email ? String(email).trim() : null,
    code8,
    code8Lower: code8.replace(/-/g, '').toLowerCase(),
    token,
    status: 'pending',
    orgId, schoolId,
    daysValid: Math.max(1, Math.min(60, Number(daysValid) || 14)),
    createdAt: ts(),
    expiresAt: FieldValue.increment(0) // purely to keep shape; validity enforced as createdAt + daysValid on read
  };
  await inviteRef.set(payload, { merge: true });

  // Return link (client-host agnostic: relative path)
  const inviteId = inviteRef.id;
  const link = `/claim.html?inv=${encodeURIComponent(inviteId)}&token=${encodeURIComponent(token)}`;
  return { ok: true, inviteId, code8, token, link };
});

// Admin/staff: list guardian invites for a school (recent first)
// Input: { orgId, schoolId, status?: 'pending'|'consumed'|'revoked'|"all", limit?: number }
exports.listGuardianInvites = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  console.log('[listGuardianInvites] invoked');
  assertAuthed(req);
  const claims = req.auth.token || {};
  const { orgId, schoolId, status = 'all', limit = 50 } = req.data || {};
  if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');
  const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
  if (!allowed) throw new HttpsError('permission-denied', 'Admin for this school required.');

  let q = db.collection('orgs').doc(orgId).collection('schools').doc(schoolId).collection('invites')
    .orderBy('createdAt', 'desc')
    .limit(Math.max(1, Math.min(200, Number(limit) || 50)));
  const s = String(status || 'all').toLowerCase();
  if (s !== 'all') q = q.where('status', '==', s);

  const snap = await q.get();
  const rows = [];
  for (const d of snap.docs) {
    const x = d.data() || {};
    if (x.type !== 'guardian-claim') continue;
    const link = `/claim.html?inv=${encodeURIComponent(d.id)}&token=${encodeURIComponent(x.token || '')}`;
    // Best-effort student name
    let studentName = String(x.studentId || '');
    try {
      const sref = db.doc(`orgs/${orgId}/schools/${schoolId}/students/${x.studentId}`);
      const ss = await sref.get();
      if (ss.exists) { const sd = ss.data() || {}; studentName = sd.name || [sd.firstName, sd.lastName].filter(Boolean).join(' ') || studentName; }
    } catch { }
    rows.push({
      id: d.id,
      studentId: String(x.studentId || ''),
      studentName,
      relationshipType: String(x.relationshipType || 'primary'),
      email: x.email || null,
      code8: x.code8 || null,
      link,
      status: String(x.status || 'pending'),
      createdAt: x.createdAt || null,
      consumedAt: x.consumedAt || null,
      consumedByUid: x.consumedByUid || null,
    });
  }
  return { ok: true, invites: rows };
});

// Admin/staff: revoke a pending guardian invite
// Input: { orgId, schoolId, inviteId }
exports.revokeGuardianInvite = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  console.log('[revokeGuardianInvite] invoked');
  assertAuthed(req);
  const claims = req.auth.token || {};
  const { orgId, schoolId, inviteId } = req.data || {};
  if (!orgId || !schoolId || !inviteId) throw new HttpsError('invalid-argument', 'orgId, schoolId, inviteId required.');
  const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
  if (!allowed) throw new HttpsError('permission-denied', 'Admin for this school required.');
  const ref = db.doc(`orgs/${orgId}/schools/${schoolId}/invites/${inviteId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Invite not found.');
  const cur = snap.data() || {};
  if ((cur.status || 'pending') !== 'pending') throw new HttpsError('failed-precondition', 'Invite is not pending.');
  await ref.set({ status: 'revoked', revokedAt: ts(), updatedAt: ts() }, { merge: true });
  return { ok: true };
});

// Signed-in guardian: claim invite via inv+token OR code
// Input: { inv, token } OR { code }
exports.claimGuardianInvite = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  console.log('[claimGuardianInvite] invoked');
  assertAuthed(req);
  const uid = req.auth.uid;
  const { inv, token, code } = req.data || {};

  // Locate the invite doc
  let docSnap = null; let docRef = null;
  if (code) {
    const codeKey = String(code).replace(/-/g, '').toLowerCase();
    const q = await db.collectionGroup('invites')
      .where('code8Lower', '==', codeKey)
      .where('status', '==', 'pending')
      .limit(1).get();
    if (!q.empty) { docSnap = q.docs[0]; docRef = docSnap.ref; }
  } else if (token) {
    const q = await db.collectionGroup('invites')
      .where('token', '==', String(token))
      .where('status', '==', 'pending')
      .limit(1).get();
    if (!q.empty) { docSnap = q.docs[0]; docRef = docSnap.ref; }
  }
  if (!docSnap || !docRef) throw new HttpsError('not-found', 'Invite not found or already used.');

  const invite = docSnap.data() || {};
  if (inv && docRef.id !== String(inv)) throw new HttpsError('permission-denied', 'Invite mismatch.');
  if (token && invite.token !== String(token)) throw new HttpsError('permission-denied', 'Token mismatch.');
  if ((invite.status || 'pending') !== 'pending') throw new HttpsError('failed-precondition', 'Invite is not pending.');
  if (invite.type !== 'guardian-claim') throw new HttpsError('failed-precondition', 'Wrong invite type.');

  const { orgId, schoolId, inviteId } = parseInvitePath(docRef.path);
  if (!orgId || !schoolId) throw new HttpsError('internal', 'Malformed invite path.');

  // Enforce daysValid from createdAt
  let createdAtMs = Date.now();
  try { const t = invite.createdAt; if (t && typeof t.toMillis === 'function') createdAtMs = t.toMillis(); } catch { }
  const daysValid = Math.max(1, Math.min(60, Number(invite.daysValid) || 14));
  const expiresMs = createdAtMs + daysValid * 24 * 60 * 60 * 1000;
  if (Date.now() > expiresMs) throw new HttpsError('deadline-exceeded', 'Invite expired.');

  const studentId = String(invite.studentId || '');
  if (!studentId) throw new HttpsError('invalid-argument', 'Invite missing studentId.');

  const studentRef = db.doc(`orgs/${orgId}/schools/${schoolId}/students/${studentId}`);
  const linkRef = studentRef.collection('guardians').doc(uid);

  await db.runTransaction(async (tx) => {
    const curInvite = await tx.get(docRef);
    if (!curInvite.exists) throw new HttpsError('not-found', 'Invite missing.');
    const cur = curInvite.data() || {};
    if ((cur.status || 'pending') !== 'pending') throw new HttpsError('failed-precondition', 'Invite already used or revoked.');
    // Idempotent: if link already exists, proceed quietly
    const linkSnap = await tx.get(linkRef);
    const linkPayload = {
      uid,
      relationshipType: String(cur.relationshipType || 'primary'),
      verifiedAt: ts(),
      createdAt: linkSnap.exists ? (linkSnap.get('createdAt') || ts()) : ts(),
      orgId, schoolId,
    };
    tx.set(linkRef, linkPayload, { merge: true });
    tx.update(docRef, { status: 'consumed', consumedByUid: uid, consumedAt: ts(), updatedAt: ts() });
    tx.set(db.doc(`users/${uid}`), { guardian: true, updatedAt: ts() }, { merge: true });

    // Also write a reverse lookup so guardians can be listed without collectionGroup
    // Key format keeps it unique and readable; values denormalize minimal fields for client
    const reverseKey = `${orgId}__${schoolId}__${studentId}`;
    const reverseRef = db.doc(`users/${uid}/guardianLinks/${reverseKey}`);
    // Try to denormalize a display name for convenience (best-effort, not required)
    let studentName = studentId;
    let studentTag = '';
    try {
      const sSnap = await tx.get(studentRef);
      if (sSnap.exists) {
        const s = sSnap.data() || {};
        studentName = s.name || [s.firstName, s.lastName].filter(Boolean).join(' ') || studentId;
        const rawTag = s.carTag || s.tag || '';
        studentTag = String(rawTag || '').toUpperCase().trim();
      }
    } catch (_) { }
    tx.set(reverseRef, {
      orgId,
      schoolId,
      studentId,
      name: studentName,
      tag: studentTag || null,
      linkedAt: ts(),
    }, { merge: true });
  });

  // Apply claims immediately so new guardian flag lands in the next ID token refresh
  const user = await auth.getUser(uid).catch(() => null);
  if (user) {
    await applyClaims(uid, user.email || '', 'guardian-claim-consumed');
  } else {
    // Fallback: still bump so clients attempt a refresh
    await bumpClaimsVersion(uid, { reason: 'guardian-claim-consumed' });
  }

  return { ok: true, orgId, schoolId, studentId };
});

// Guardian helper: list students linked to current user
// Returns [{ orgId, schoolId, studentId, name }]
exports.listMyLinkedStudents = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const out = [];
  try {
    // Preferred: read reverse index written at claim time
    const revSnap = await db.collection(`users/${uid}/guardianLinks`).limit(100).get();
    if (!revSnap.empty) {
      revSnap.docs.forEach(d => {
        const x = d.data() || {};
        const orgId = String(x.orgId || '');
        const schoolId = String(x.schoolId || '');
        const studentId = String(x.studentId || d.id);
        const name = x.name || studentId;
        const tag = String(x.tag || '').toUpperCase().trim();
        if (orgId && schoolId && studentId) out.push({ orgId, schoolId, studentId, name, tag });
      });
      // Enrich names/tags if missing or clearly an ID (best-effort, avoids client reads)
      const needEnrich = out.filter(s => !s.name || s.name === s.studentId || /^(?:[A-Za-z0-9_-]{6,})$/.test(s.name));
      for (const s of needEnrich) {
        try {
          const ref = db.doc(`orgs/${s.orgId}/schools/${s.schoolId}/students/${s.studentId}`);
          const snap = await ref.get();
          if (snap.exists) {
            const d = snap.data() || {};
            const nm = d.name || [d.firstName, d.lastName].filter(Boolean).join(' ');
            if (nm) s.name = nm;
            const tg = String(d.carTag || d.tag || '').toUpperCase().trim();
            if (tg) s.tag = tg;
          }
        } catch (e) { /* ignore */ }
      }

      // Enrich school names
      const schoolMap = new Map();
      for (const s of out) {
        const key = `${s.orgId}|${s.schoolId}`;
        if (!schoolMap.has(key)) {
          try {
            const snap = await db.doc(`orgs/${s.orgId}/schools/${s.schoolId}`).get();
            schoolMap.set(key, snap.exists ? (snap.data().name || s.schoolId) : s.schoolId);
          } catch { schoolMap.set(key, s.schoolId); }
        }
        s.schoolName = schoolMap.get(key);
      }

      return { ok: true, students: out };
    }
  } catch (e) {
    console.error('[listMyLinkedStudents] reverse index read failed', e);
  }
  try {
    // Fallback: collection group scan of guardians
    const snap = await db.collectionGroup('guardians').where('uid', '==', uid).limit(100).get();
    for (const d of snap.docs) {
      try {
        const guardiansColl = d.ref.parent;                 // .../students/{studentId}/guardians
        const studentRef = guardiansColl.parent;            // .../students/{studentId}
        const seg = studentRef.path.split('/');             // orgs/{orgId}/schools/{schoolId}/students/{studentId}
        if (seg.length < 6) continue;
        const orgId = seg[1];
        const schoolId = seg[3];
        const studentId = seg[5];
        const sSnap = await studentRef.get();
        const s = sSnap.exists ? (sSnap.data() || {}) : {};
        const name = s.name || [s.firstName, s.lastName].filter(Boolean).join(' ') || studentId;
        const tag = String(s.carTag || s.tag || '').toUpperCase().trim();
        out.push({ orgId, schoolId, studentId, name, tag });
      } catch (inner) {
        console.error('[listMyLinkedStudents] doc parse failed', inner);
      }
    }
  } catch (e) {
    console.error('[listMyLinkedStudents] guardians group query failed', e);
    // Don't surface 500s to the client; return empty list so UI can degrade gracefully
    return { ok: true, students: out };
  }

  // Enrich school names (fallback path)
  const schoolMap = new Map();
  for (const s of out) {
    const key = `${s.orgId}|${s.schoolId}`;
    if (!schoolMap.has(key)) {
      try {
        const snap = await db.doc(`orgs/${s.orgId}/schools/${s.schoolId}`).get();
        schoolMap.set(key, snap.exists ? (snap.data().name || s.schoolId) : s.schoolId);
      } catch { schoolMap.set(key, s.schoolId); }
    }
    s.schoolName = schoolMap.get(key);
  }

  return { ok: true, students: out };
});

// ───────────────── Parent-to-parent Access Grants ─────────────────
// Helper: check guardian link for a student
async function isGuardianForStudent(uid, orgId, schoolId, studentId) {
  try {
    const ref = db.doc(`orgs/${orgId}/schools/${schoolId}/students/${studentId}/guardians/${uid}`);
    const snap = await ref.get();
    return snap.exists;
  } catch { return false; }
}

// Create an access grant (guardian -> trusted adult) for selected students
// Input: { orgId?, schoolId?, studentIds: string[], granteeUid?: string, granteeEmail?: string, granteeName?: string, windowType?: 'always'|'today' }
exports.createAccessGrant = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  assertAuthed(req);
  const grantorUid = req.auth.uid;
  const grantorEmailLower = norm(req.auth.token?.email || '');
  const { orgId, schoolId, studentIds, granteeEmail, granteeUid: rawUid, granteeName = '', windowType = 'always' } = req.data || {};
  const list = Array.isArray(studentIds) ? studentIds.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (!list.length) throw new HttpsError('invalid-argument', 'At least one student required.');
  const grUid = String(rawUid || '').trim();
  const grEmail = String(granteeEmail || '').trim();
  let grLower = norm(grEmail);
  if (!grUid && !grLower) throw new HttpsError('invalid-argument', 'Provide granteeUid or granteeEmail.');
  if (grUid && grUid === grantorUid) throw new HttpsError('failed-precondition', 'Cannot grant to yourself.');
  if (!grUid && grLower === grantorEmailLower) throw new HttpsError('failed-precondition', 'Cannot grant to your own email.');

  // Determine org/school context. If not provided or doesn't match, resolve from reverse index.
  // Accumulate candidate pairs for each student; ensure they all match one school.
  const pairs = [];
  for (const sid of list) {
    let o = String(orgId || '');
    let s = String(schoolId || '');
    let ok = false;
    if (o && s) {
      ok = await isGuardianForStudent(grantorUid, o, s, sid);
    }
    if (!ok) {
      // Try reverse index under users/{uid}/guardianLinks where studentId == sid
      try {
        const q = await db.collection(`users/${grantorUid}/guardianLinks`).where('studentId', '==', sid).limit(5).get();
        if (!q.empty) {
          // Prefer a deterministic first doc
          const d = q.docs[0]; const data = d.data() || {};
          const ro = String(data.orgId || '');
          const rs = String(data.schoolId || '');
          if (ro && rs) {
            o = ro; s = rs; ok = await isGuardianForStudent(grantorUid, o, s, sid);
          }
        }
      } catch { }
    }
    if (!ok) {
      // Fallback: scan guardians by uid and match studentId from path (no extra indexes required)
      try {
        const snap = await db.collectionGroup('guardians').where('uid', '==', grantorUid).limit(200).get();
        for (const d of snap.docs) {
          if (ok) break;
          try {
            const guardiansColl = d.ref.parent;                 // .../students/{studentId}/guardians
            const studentRef = guardiansColl.parent;            // .../students/{studentId}
            const seg = studentRef.path.split('/');
            if (seg.length < 6) continue;
            const foundStudentId = seg[5];
            if (foundStudentId !== sid) continue;
            const ro = seg[1]; const rs = seg[3];
            if (ro && rs) {
              o = ro; s = rs; ok = true; // doc existence already implies guardianship
            }
          } catch { }
        }
      } catch { }
    }
    if (!ok) throw new HttpsError('permission-denied', `Not a guardian for student ${sid}.`);
    if (!o || !s) throw new HttpsError('invalid-argument', 'Could not resolve school context.');
    pairs.push({ orgId: o, schoolId: s });
  }

  // Ensure all students share the same school context
  const first = pairs[0];
  const allSame = pairs.every(p => p.orgId === first.orgId && p.schoolId === first.schoolId);
  if (!allSame) throw new HttpsError('failed-precondition', 'All selected students must belong to the same school.');
  const finalOrgId = first.orgId; const finalSchoolId = first.schoolId;

  // Resolve target
  let granteeUid = null;
  if (grUid) {
    // Prefer provided uid
    try { const u = await auth.getUser(grUid); granteeUid = u?.uid || grUid; if (!grLower) grLower = norm(u?.email || ''); } catch { granteeUid = grUid; }
  } else if (grLower) {
    try { const u = await auth.getUserByEmail(grLower); granteeUid = u?.uid || null; } catch { }
  }

  const ref = db.collection('orgs').doc(finalOrgId).collection('schools').doc(finalSchoolId).collection('accessGrants').doc();
  const payload = {
    grantorUid,
    grantorEmailLower,
    granteeEmailLower: grLower || null,
    granteeName: String(granteeName || ''),
    granteeUid: granteeUid || null,
    studentIds: Array.from(new Set(list)).slice(0, 20),
    window: { type: (windowType === 'today' ? 'today' : 'always') },
    status: 'active',
    createdAt: ts(),
    updatedAt: ts(),
  };
  await ref.set(payload, { merge: true });
  return { ok: true, id: ref.id, path: ref.path };
});

// List my granted access (as grantor)
exports.listMyGrantedAccess = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const rows = [];
  try {
    const snap = await db.collectionGroup('accessGrants')
      .where('status', '==', 'active')
      .where('grantorUid', '==', uid)
      .limit(50).get();
    for (const d of snap.docs) {
      const g = d.data() || {};
      const seg = d.ref.path.split('/');
      if (seg.length < 6) continue;
      const orgId = seg[1]; const schoolId = seg[3];
      const students = Array.isArray(g.studentIds) ? g.studentIds.slice(0, 20) : [];
      // Resolve names (best-effort)
      let names = [];
      for (const sid of students) {
        try {
          const sSnap = await db.doc(`orgs/${orgId}/schools/${schoolId}/students/${sid}`).get();
          const s = sSnap.exists ? (sSnap.data() || {}) : {};
          const nm = s.name || [s.firstName, s.lastName].filter(Boolean).join(' ') || sid;
          names.push(nm);
        } catch { names.push(sid); }
      }
      rows.push({
        id: d.id,
        path: d.ref.path,
        orgId, schoolId,
        name: g.granteeName || g.granteeEmailLower,
        email: g.granteeEmailLower || '',
        students: names.join(', '),
        window: (g.window && g.window.type === 'today') ? 'Today only' : 'Always',
      });
    }
  } catch (e) { console.warn('[listMyGrantedAccess] failed', e); }
  return { ok: true, grants: rows };
});

// Revoke an access grant (grantor only)
// Input: { path } where path is orgs/{orgId}/schools/{schoolId}/accessGrants/{id}
exports.revokeAccessGrant = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const { path } = req.data || {};
  if (!path || typeof path !== 'string') throw new HttpsError('invalid-argument', 'path required.');
  const seg = path.split('/');
  if (seg.length < 6 || seg[0] !== 'orgs' || seg[2] !== 'schools' || seg[4] !== 'accessGrants') {
    throw new HttpsError('invalid-argument', 'Invalid grant path.');
  }
  const ref = db.doc(path);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Grant not found.');
  const g = snap.data() || {};
  if (g.grantorUid !== uid) throw new HttpsError('permission-denied', 'Only the grantor can revoke this grant.');
  await ref.set({ status: 'revoked', revokedAt: ts(), updatedAt: ts() }, { merge: true });
  return { ok: true };
});

// Union of guardianship + active grants for the current user
exports.listMyStudentsAndGrants = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public' }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const emailLower = norm(req.auth.token?.email || '');
  const out = [];
  const seen = new Set();
  // Start from existing helper output
  try {
    const resp = await exports.listMyLinkedStudents.run({ auth: req.auth, data: {} });
    const list = (resp && resp.data && resp.data.students) ? resp.data.students : [];
    for (const s of list) {
      const key = `${s.orgId}|${s.schoolId}|${s.studentId}`;
      if (!seen.has(key)) { seen.add(key); out.push(s); }
    }
  } catch { }
  // Add grants by uid
  const addFromGrants = async (snap) => {
    for (const d of snap.docs) {
      const g = d.data() || {};
      const seg = d.ref.path.split('/');
      if (seg.length < 6) continue;
      const orgId = seg[1]; const schoolId = seg[3];
      const students = Array.isArray(g.studentIds) ? g.studentIds.slice(0, 20) : [];
      for (const studentId of students) {
        const key = `${orgId}|${schoolId}|${studentId}`;
        if (seen.has(key)) continue;
        try {
          const sRef = db.doc(`orgs/${orgId}/schools/${schoolId}/students/${studentId}`);
          const sSnap = await sRef.get();
          const s = sSnap.exists ? (sSnap.data() || {}) : {};
          const name = s.name || [s.firstName, s.lastName].filter(Boolean).join(' ') || studentId;
          const tag = String(s.carTag || s.tag || '').toUpperCase().trim();
          seen.add(key); out.push({ orgId, schoolId, studentId, name, tag });
        } catch { }
      }
    }
  };
  try {
    const q1 = await db.collectionGroup('accessGrants')
      .where('status', '==', 'active')
      .where('granteeUid', '==', uid)
      .limit(50).get();
    await addFromGrants(q1);
  } catch { }
  try {
    if (emailLower) {
      const q2 = await db.collectionGroup('accessGrants')
        .where('status', '==', 'active')
        .where('granteeEmailLower', '==', emailLower)
        .limit(50).get();
      await addFromGrants(q2);
    }
  } catch { }
  return { ok: true, students: out };
});

// List access granted TO the current user (Trusted Pickups)
exports.listMyPickupAccess = onCall({ region: 'us-central1', minInstances: 0, invoker: 'public', cors: true }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const emailLower = norm(req.auth.token?.email || '');
  const pickups = [];

  console.log(`[listMyPickupAccess] uid=${uid} email=${emailLower}`);

  // 1. Find grants where I am the grantee (by uid or email)
  const grants = [];
  try {
    const q1 = await db.collectionGroup('accessGrants')
      .where('status', '==', 'active')
      .where('granteeUid', '==', uid)
      .get();
    console.log(`[listMyPickupAccess] Found ${q1.size} grants by UID`);
    q1.docs.forEach(d => grants.push(d));
  } catch (e) { console.warn('[listMyPickupAccess] uid query failed', e); }

  if (emailLower) {
    try {
      const q2 = await db.collectionGroup('accessGrants')
        .where('status', '==', 'active')
        .where('granteeEmailLower', '==', emailLower)
        .get();
      console.log(`[listMyPickupAccess] Found ${q2.size} grants by Email`);
      q2.docs.forEach(d => {
        if (!grants.some(g => g.id === d.id)) grants.push(d);
      });
    } catch (e) { console.warn('[listMyPickupAccess] email query failed', e); }
  }

  // 2. Resolve details for each grant
  for (const d of grants) {
    const g = d.data() || {};

    // Safer path resolution
    let orgId, schoolId;
    try {
      schoolId = d.ref.parent.parent.id;
      orgId = d.ref.parent.parent.parent.parent.id;
    } catch (err) {
      console.warn('[listMyPickupAccess] Failed to parse path', d.ref.path, err);
      continue;
    }

    const studentIds = Array.isArray(g.studentIds) ? g.studentIds : [];
    console.log(`[listMyPickupAccess] Grant ${d.id} org=${orgId} school=${schoolId} students=${studentIds.length}`);

    // Resolve grantor name
    let grantorName = 'A parent';
    if (g.grantorUid) {
      try {
        const uSnap = await db.doc(`users/${g.grantorUid}`).get();
        if (uSnap.exists) {
          const u = uSnap.data();
          grantorName = u.displayName || u.email || grantorName;
        } else if (g.grantorEmailLower) {
          grantorName = g.grantorEmailLower;
        }
      } catch { }
    }

    // Resolve each student
    for (const sid of studentIds) {
      let studentName = sid;
      let tag = '';
      try {
        const sSnap = await db.doc(`orgs/${orgId}/schools/${schoolId}/students/${sid}`).get();
        if (sSnap.exists) {
          const s = sSnap.data();
          studentName = s.name || [s.firstName, s.lastName].filter(Boolean).join(' ') || sid;
          tag = s.carTag || s.tag || '';
        } else {
          console.warn(`[listMyPickupAccess] Student ${sid} not found in ${orgId}/${schoolId}`);
        }
      } catch (e) { console.warn(`[listMyPickupAccess] Student fetch failed`, e); }

      pickups.push({
        studentId: sid,
        studentName,
        tag,
        window: (g.window && g.window.type === 'today') ? 'Today only' : 'Always',
        grantorName,
        note: '', // Not currently stored on grants
        orgId,
        schoolId
      });
    }
  }

  console.log(`[listMyPickupAccess] Returning ${pickups.length} pickups`);
  return { ok: true, pickups };
});

// ───────────────── Parent Profile & Connect ─────────────────

// Read the caller's parent profile from users/{uid}
exports.getMyParentProfile = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const userDoc = await db.doc(`users/${uid}`).get();
  const d = userDoc.exists ? (userDoc.data() || {}) : {};
  return {
    ok: true,
    uid,
    displayName: (d.displayName && String(d.displayName)) || (req.auth.token.name || null) || null,
    discoverable: !!d.discoverable,
    emailLower: (d.emailLower && String(d.emailLower)) || (req.auth.token.email || null) || null,
    guardian: !!d.guardian,
  };
});

// Update the caller's parent profile (displayName, discoverable)
exports.updateMyParentProfile = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const { displayName = undefined, discoverable = undefined } = req.data || {};

  const payload = { updatedAt: ts() };
  if (displayName !== undefined) {
    const name = String(displayName || '').trim();
    if (name && (name.length < 2 || name.length > 60)) {
      throw new HttpsError('invalid-argument', 'displayName must be 2–60 characters.');
    }
    payload.displayName = name || null;
  }
  if (discoverable !== undefined) {
    payload.discoverable = !!discoverable;
  }

  const email = req.auth?.token?.email || '';
  if (email) payload.emailLower = String(email).toLowerCase();

  await db.doc(`users/${uid}`).set(payload, { merge: true });
  return { ok: true };
});

// Helper: does this user participate in the school (admin/staff or guardian link)?
async function canSeeParentsForSchool(reqClaims, orgId, schoolId, uid) {
  try {
    if (await canManageSchool(reqClaims || {}, orgId, schoolId, uid)) return true;
  } catch { }
  try {
    const rev = await db.collection(`users/${uid}/guardianLinks`)
      .where('orgId', '==', String(orgId))
      .where('schoolId', '==', String(schoolId))
      .limit(1).get();
    return !rev.empty;
  } catch { }
  return false;
}

// List discoverable parents for a school the caller belongs to
// Input: { orgId, schoolId, limit? }
exports.listDiscoverableParents = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const { orgId, schoolId, limit = 50 } = req.data || {};
  if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');
  const max = Math.max(1, Math.min(100, Number(limit) || 50));
  try {
    const ok = await canSeeParentsForSchool(req.auth.token || {}, orgId, schoolId, req.auth.uid);
    if (!ok) throw new HttpsError('permission-denied', 'Not a member of this school.');

    // Collect connected/pending so we can exclude them from discovery
    const [incomingSnap, outgoingSnap, connSnap] = await Promise.all([
      db.collection(`users/${req.auth.uid}/parentConnectIncoming`).where('orgId', '==', String(orgId)).where('schoolId', '==', String(schoolId)).limit(200).get().catch(() => ({ docs: [] })),
      db.collection(`users/${req.auth.uid}/parentConnectOutgoing`).where('orgId', '==', String(orgId)).where('schoolId', '==', String(schoolId)).limit(200).get().catch(() => ({ docs: [] })),
      db.collection(`users/${req.auth.uid}/parentConnections`).where('orgId', '==', String(orgId)).where('schoolId', '==', String(schoolId)).limit(400).get().catch(() => ({ docs: [] })),
    ]);
    const exclude = new Set();
    for (const d of incomingSnap.docs) { exclude.add(d.id); }
    for (const d of outgoingSnap.docs) { exclude.add(d.id); }
    for (const d of connSnap.docs) { exclude.add(d.id); }

    const candidateUids = new Set();

    // Query guardianLinks ONLY by orgId, then filter schoolId in memory to avoid composite index requirement
    const glSnap = await db.collectionGroup('guardianLinks')
      .where('orgId', '==', String(orgId))
      .limit(max * 10) // allow slack; we'll filter
      .get().catch(() => null);
    if (glSnap) {
      for (const doc of glSnap.docs) {
        try {
          const data = doc.data() || {};
          if (String(data.schoolId || '') !== String(schoolId)) continue;
          const pUid = doc.ref.parent.parent.id;
          if (!pUid || pUid === req.auth.uid) continue;
          candidateUids.add(pUid);
        } catch { }
      }
    }

    // Fallback A: scan guardians collectionGroup by orgId only, filter schoolId in memory, backfill missing reverse indexes
    if (candidateUids.size < max) {
      const gSnap = await db.collectionGroup('guardians').where('orgId', '==', String(orgId)).limit(800).get().catch(() => null);
      if (gSnap) {
        for (const d of gSnap.docs) {
          try {
            const g = d.data() || {};
            if (String(g.schoolId || '') !== String(schoolId)) continue;
            const pUid = String(g.uid || '');
            if (!pUid || pUid === req.auth.uid) continue;
            candidateUids.add(pUid);
            // Reverse index backfill (best-effort)
            const seg = d.ref.parent.parent.path.split('/'); // .../students/{studentId}
            const studentId = seg[5];
            if (studentId) {
              const revKey = `${orgId}__${schoolId}__${studentId}`;
              db.doc(`users/${pUid}/guardianLinks/${revKey}`).set({ orgId, schoolId, studentId, linkedAt: ts() }, { merge: true }).catch(() => { });
            }
          } catch { }
        }
      }
    }

    // Fallback B: include parents participating via accessGrants (grantor or grantee) in this school
    if (candidateUids.size < max) {
      const agSnap = await db.collectionGroup('accessGrants').where('status', '==', 'active').limit(500).get().catch(() => null);
      if (agSnap) {
        for (const d of agSnap.docs) {
          try {
            const seg = d.ref.path.split('/'); // orgs/{orgId}/schools/{schoolId}/accessGrants/{id}
            if (seg.length < 6) continue;
            const oId = seg[1]; const sId = seg[3];
            if (oId !== orgId || sId !== schoolId) continue;
            const g = d.data() || {};
            if (g.grantorUid && g.grantorUid !== req.auth.uid) candidateUids.add(g.grantorUid);
            if (g.granteeUid && g.granteeUid !== req.auth.uid) candidateUids.add(g.granteeUid);
          } catch { }
        }
      }
    }

    // Remove excluded (pending/connected)
    const filtered = Array.from(candidateUids).filter(u => !exclude.has(u));
    if (!filtered.length) return { ok: true, parents: [] };

    // Load user docs in batches
    const parents = [];
    for (const uidChunk of filtered.slice(0, max + 5)) {
      try {
        const snap = await db.doc(`users/${uidChunk}`).get();
        if (snap.exists) {
          const u = snap.data() || {};
          if (u.discoverable) parents.push({ uid: uidChunk, displayName: u.displayName || null });
        }
        if (parents.length >= max) break;
      } catch { }
    }
    return { ok: true, parents };
  } catch (e) {
    console.warn('[listDiscoverableParents] degraded due to error', e?.message || e);
    // Do not surface internal errors — return empty list so client can show placeholder
    return { ok: true, parents: [] };
  }
});

// Send a parent-to-parent connect request
// Input: { toUid, orgId, schoolId, note? }
exports.sendParentConnectRequest = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const fromUid = req.auth.uid;
  const { toUid, orgId, schoolId, note = null } = req.data || {};
  if (!toUid || !orgId || !schoolId) throw new HttpsError('invalid-argument', 'toUid, orgId, schoolId required.');
  if (toUid === fromUid) throw new HttpsError('invalid-argument', 'Cannot connect to yourself.');

  const callerOk = await canSeeParentsForSchool(req.auth.token || {}, orgId, schoolId, fromUid);
  if (!callerOk) throw new HttpsError('permission-denied', 'Caller not in this school.');

  const targetLinks = await db.collection(`users/${toUid}/guardianLinks`)
    .where('orgId', '==', String(orgId)).where('schoolId', '==', String(schoolId)).limit(1).get();
  if (targetLinks.empty) throw new HttpsError('failed-precondition', 'Target is not part of this school.');

  const now = ts();
  const incomingRef = db.doc(`users/${toUid}/parentConnectIncoming/${fromUid}`);
  const outgoingRef = db.doc(`users/${fromUid}/parentConnectOutgoing/${toUid}`);

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(incomingRef);
    const status = existing.exists ? (existing.get('status') || 'pending') : 'pending';
    if (status === 'accepted') return; // already connected
    const payload = { fromUid: fromUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: existing.exists ? (existing.get('createdAt') || now) : now, updatedAt: now };
    tx.set(incomingRef, payload, { merge: true });
    tx.set(outgoingRef, { toUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: now, updatedAt: now }, { merge: true });
  });

  return { ok: true };
});

// Send a parent-to-parent connect request by email (if user exists)
// Input: { email, orgId, schoolId, note? }
exports.sendParentConnectRequestByEmail = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const fromUid = req.auth.uid;
  const { email, orgId, schoolId, note = null } = req.data || {};
  const emailLower = norm(email || '');
  if (!emailLower || !orgId || !schoolId) throw new HttpsError('invalid-argument', 'email, orgId, schoolId required.');

  const callerOk = await canSeeParentsForSchool(req.auth.token || {}, orgId, schoolId, fromUid);
  if (!callerOk) throw new HttpsError('permission-denied', 'Caller not in this school.');

  let toUid = null;
  try { const u = await auth.getUserByEmail(emailLower); toUid = u?.uid || null; } catch { }
  if (!toUid) throw new HttpsError('not-found', 'No account found for that email.');
  if (toUid === fromUid) throw new HttpsError('invalid-argument', 'Cannot connect to yourself.');

  // Ensure target is part of this school
  const targetLinks = await db.collection(`users/${toUid}/guardianLinks`)
    .where('orgId', '==', String(orgId)).where('schoolId', '==', String(schoolId)).limit(1).get();
  if (targetLinks.empty) throw new HttpsError('failed-precondition', 'Target is not part of this school.');

  const now = ts();
  const incomingRef = db.doc(`users/${toUid}/parentConnectIncoming/${fromUid}`);
  const outgoingRef = db.doc(`users/${fromUid}/parentConnectOutgoing/${toUid}`);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(incomingRef);
    const status = existing.exists ? (existing.get('status') || 'pending') : 'pending';
    if (status === 'accepted') return;
    const payload = { fromUid: fromUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: existing.exists ? (existing.get('createdAt') || now) : now, updatedAt: now };
    tx.set(incomingRef, payload, { merge: true });
    tx.set(outgoingRef, { toUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: now, updatedAt: now }, { merge: true });
  });
  return { ok: true };
});

// Respond to an incoming request: accept or decline
// Input: { fromUid, orgId, schoolId, action }
exports.respondParentConnectRequest = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const toUid = req.auth.uid;
  const { fromUid, orgId, schoolId, action } = req.data || {};
  if (!fromUid || !orgId || !schoolId || !action) throw new HttpsError('invalid-argument', 'fromUid, orgId, schoolId, action required.');
  const act = String(action).toLowerCase();
  if (!['accept', 'decline'].includes(act)) throw new HttpsError('invalid-argument', 'action must be accept or decline');

  const now = ts();
  const incomingRef = db.doc(`users/${toUid}/parentConnectIncoming/${fromUid}`);
  const outgoingRef = db.doc(`users/${fromUid}/parentConnectOutgoing/${toUid}`);

  await db.runTransaction(async (tx) => {
    const inc = await tx.get(incomingRef);
    if (!inc.exists) throw new HttpsError('not-found', 'No incoming request.');
    const cur = inc.data() || {};
    if (cur.orgId !== orgId || cur.schoolId !== schoolId) throw new HttpsError('failed-precondition', 'Context mismatch.');
    const newStatus = act === 'accept' ? 'accepted' : 'declined';
    tx.set(incomingRef, { status: newStatus, respondedAt: now, updatedAt: now }, { merge: true });
    tx.set(outgoingRef, { status: newStatus, respondedAt: now, updatedAt: now }, { merge: true });

    if (newStatus === 'accepted') {
      const aRef = db.doc(`users/${toUid}/parentConnections/${fromUid}`);
      const bRef = db.doc(`users/${fromUid}/parentConnections/${toUid}`);
      const conn = { orgId, schoolId, since: now };
      tx.set(aRef, conn, { merge: true });
      tx.set(bRef, conn, { merge: true });
    }
  });

  return { ok: true };
});

// List my incoming/outgoing requests and current connections
exports.listMyParentConnections = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const uid = req.auth.uid;
  const [incoming, outgoing, links] = await Promise.all([
    db.collection(`users/${uid}/parentConnectIncoming`).orderBy('updatedAt', 'desc').limit(50).get(),
    db.collection(`users/${uid}/parentConnectOutgoing`).orderBy('updatedAt', 'desc').limit(50).get(),
    db.collection(`users/${uid}/parentConnections`).limit(200).get(),
  ]);

  // Collect UIDs to resolve names
  const uids = new Set();
  incoming.docs.forEach(d => { const x = d.data() || {}; if (x.fromUid) uids.add(x.fromUid); });
  outgoing.docs.forEach(d => { const x = d.data() || {}; if (x.toUid) uids.add(x.toUid); });
  links.docs.forEach(d => { uids.add(d.id); });

  const names = new Map();
  if (uids.size > 0) {
    // Fetch in batches of 10
    const all = Array.from(uids);
    for (let i = 0; i < all.length; i += 10) {
      const chunk = all.slice(i, i + 10);
      await Promise.all(chunk.map(async (u) => {
        try {
          const s = await db.doc(`users/${u}`).get();
          if (s.exists) {
            const d = s.data() || {};
            if (d.displayName) names.set(u, d.displayName);
          }
        } catch { }
      }));
    }
  }

  const mapDoc = (d, field) => {
    const data = d.data() || {};
    const otherUid = field ? data[field] : d.id;
    return { id: d.id, ...data, displayName: names.get(otherUid) || null };
  };

  return {
    ok: true,
    incoming: incoming.docs.map(d => mapDoc(d, 'fromUid')),
    outgoing: outgoing.docs.map(d => mapDoc(d, 'toUid')),
    connections: links.docs.map(d => mapDoc(d, null)),
  };
});

// ───────────────── HTTP CORS shims for Parent Profile & Connect ─────────────────

// Helper to read auth from Bearer header
async function requireUserFromRequest(req, res) {
  const authHeader = String(req.headers.authorization || '');
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return null; }
  try { return await auth.verifyIdToken(idToken); } catch { res.status(401).json({ ok: false, error: 'unauthenticated' }); return null; }
}

exports.getMyParentProfileHttp = onRequest({ region: 'us-central1', invoker: 'public', minInstances: 0 }, allowCors(async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }
  const decoded = await requireUserFromRequest(req, res); if (!decoded) return;
  const uid = decoded.uid;
  const snap = await db.doc(`users/${uid}`).get();
  const d = snap.exists ? (snap.data() || {}) : {};
  res.json({ ok: true, uid, displayName: d.displayName || decoded.name || null, discoverable: !!d.discoverable, emailLower: d.emailLower || decoded.email || null, guardian: !!d.guardian });
}));

exports.updateMyParentProfileHttp = onRequest({ region: 'us-central1', invoker: 'public', minInstances: 0 }, allowCors(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }
  const decoded = await requireUserFromRequest(req, res); if (!decoded) return;
  const uid = decoded.uid;
  const { displayName = undefined, discoverable = undefined } = req.body || {};
  const payload = { updatedAt: ts() };
  if (displayName !== undefined) { const name = String(displayName || '').trim(); if (name && (name.length < 2 || name.length > 60)) { res.status(400).json({ ok: false, error: 'invalid-argument' }); return; } payload.displayName = name || null; }
  if (discoverable !== undefined) { payload.discoverable = !!discoverable; }
  if (decoded.email) payload.emailLower = String(decoded.email).toLowerCase();
  await db.doc(`users/${uid}`).set(payload, { merge: true });
  res.json({ ok: true });
}));

exports.listDiscoverableParentsHttp = onRequest({ region: 'us-central1', invoker: 'public', minInstances: 0 }, allowCors(async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }
  const decoded = await requireUserFromRequest(req, res); if (!decoded) return;
  const selfUid = decoded.uid;
  const orgId = String(req.query.orgId || ''); const schoolId = String(req.query.schoolId || '');
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  if (!orgId || !schoolId) { res.status(400).json({ ok: false, error: 'invalid-argument' }); return; }
  try {
    const ok = await canSeeParentsForSchool(decoded, orgId, schoolId, selfUid);
    if (!ok) { res.status(403).json({ ok: false, error: 'permission-denied' }); return; }

    // Gather exclusion set
    const [incomingSnap, outgoingSnap, connSnap] = await Promise.all([
      db.collection(`users/${selfUid}/parentConnectIncoming`).where('orgId', '==', orgId).where('schoolId', '==', schoolId).limit(200).get().catch(() => ({ docs: [] })),
      db.collection(`users/${selfUid}/parentConnectOutgoing`).where('orgId', '==', orgId).where('schoolId', '==', schoolId).limit(200).get().catch(() => ({ docs: [] })),
      db.collection(`users/${selfUid}/parentConnections`).where('orgId', '==', orgId).where('schoolId', '==', schoolId).limit(400).get().catch(() => ({ docs: [] })),
    ]);
    const exclude = new Set();
    for (const d of incomingSnap.docs) exclude.add(d.id);
    for (const d of outgoingSnap.docs) exclude.add(d.id);
    for (const d of connSnap.docs) exclude.add(d.id);

    const candidateUids = new Set();
    const glSnap = await db.collectionGroup('guardianLinks').where('orgId', '==', orgId).limit(limit * 10).get().catch(() => null);
    if (glSnap) {
      for (const doc of glSnap.docs) {
        try {
          const data = doc.data() || {};
          if (String(data.schoolId || '') !== schoolId) continue;
          const pUid = doc.ref.parent.parent.id;
          if (!pUid || pUid === selfUid) continue;
          candidateUids.add(pUid);
        } catch { }
      }
    }
    if (candidateUids.size < limit) {
      const gSnap = await db.collectionGroup('guardians').where('orgId', '==', orgId).limit(800).get().catch(() => null);
      if (gSnap) {
        for (const d of gSnap.docs) {
          try {
            const g = d.data() || {};
            if (String(g.schoolId || '') !== schoolId) continue;
            const pUid = String(g.uid || '');
            if (!pUid || pUid === selfUid) continue;
            candidateUids.add(pUid);
            const seg = d.ref.parent.parent.path.split('/');
            const studentId = seg[5];
            if (studentId) {
              const revKey = `${orgId}__${schoolId}__${studentId}`;
              db.doc(`users/${pUid}/guardianLinks/${revKey}`).set({ orgId, schoolId, studentId, linkedAt: ts() }, { merge: true }).catch(() => { });
            }
          } catch { }
        }
      }
    }
    if (candidateUids.size < limit) {
      const agSnap = await db.collectionGroup('accessGrants').where('status', '==', 'active').limit(500).get().catch(() => null);
      if (agSnap) {
        for (const d of agSnap.docs) {
          try {
            const seg = d.ref.path.split('/');
            if (seg.length < 6) continue;
            const oId = seg[1]; const sId = seg[3];
            if (oId !== orgId || sId !== schoolId) continue;
            const g = d.data() || {};
            if (g.grantorUid && g.grantorUid !== selfUid) candidateUids.add(g.grantorUid);
            if (g.granteeUid && g.granteeUid !== selfUid) candidateUids.add(g.granteeUid);
          } catch { }
        }
      }
    }
    const filtered = Array.from(candidateUids).filter(u => !exclude.has(u));
    const parents = [];
    for (const u of filtered.slice(0, limit + 5)) {
      try {
        const snap = await db.doc(`users/${u}`).get();
        if (snap.exists) {
          const data = snap.data() || {};
          if (data.discoverable) parents.push({ uid: u, displayName: data.displayName || null });
        }
        if (parents.length >= limit) break;
      } catch { }
    }
    res.json({ ok: true, parents });
  } catch (e) {
    console.warn('[listDiscoverableParentsHttp] degraded due to error', e?.message || e);
    res.json({ ok: true, parents: [] });
  }
}));

exports.sendParentConnectRequestHttp = onRequest({ region: 'us-central1', invoker: 'public', minInstances: 0 }, allowCors(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }
  const decoded = await requireUserFromRequest(req, res); if (!decoded) return;
  const fromUid = decoded.uid;
  const { toUid, orgId, schoolId, note = null } = req.body || {};
  if (!toUid || !orgId || !schoolId) { res.status(400).json({ ok: false, error: 'invalid-argument' }); return; }
  if (toUid === fromUid) { res.status(400).json({ ok: false, error: 'invalid-argument' }); return; }
  const callerOk = await canSeeParentsForSchool(decoded, orgId, schoolId, fromUid);
  if (!callerOk) { res.status(403).json({ ok: false, error: 'permission-denied' }); return; }
  const targetLinks = await db.collection(`users/${toUid}/guardianLinks`).where('orgId', '==', orgId).where('schoolId', '==', schoolId).limit(1).get();
  if (targetLinks.empty) { res.status(412).json({ ok: false, error: 'failed-precondition' }); return; }
  const now = ts(); const incomingRef = db.doc(`users/${toUid}/parentConnectIncoming/${fromUid}`); const outgoingRef = db.doc(`users/${fromUid}/parentConnectOutgoing/${toUid}`);
  await db.runTransaction(async (tx) => { const existing = await tx.get(incomingRef); const status = existing.exists ? (existing.get('status') || 'pending') : 'pending'; if (status === 'accepted') return; const payload = { fromUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: existing.exists ? (existing.get('createdAt') || now) : now, updatedAt: now }; tx.set(incomingRef, payload, { merge: true }); tx.set(outgoingRef, { toUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: now, updatedAt: now }, { merge: true }); });
  res.json({ ok: true });
}));

exports.sendParentConnectRequestByEmailHttp = onRequest({ region: 'us-central1', invoker: 'public', minInstances: 0 }, allowCors(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }
  const decoded = await requireUserFromRequest(req, res); if (!decoded) return;
  const fromUid = decoded.uid;
  const { email, orgId, schoolId, note = null } = req.body || {};
  const emailLower = norm(email || '');
  if (!emailLower || !orgId || !schoolId) { res.status(400).json({ ok: false, error: 'invalid-argument' }); return; }
  const callerOk = await canSeeParentsForSchool(decoded, orgId, schoolId, fromUid);
  if (!callerOk) { res.status(403).json({ ok: false, error: 'permission-denied' }); return; }
  let toUid = null; try { const u = await auth.getUserByEmail(emailLower); toUid = u?.uid || null; } catch { }
  if (!toUid) { res.status(404).json({ ok: false, error: 'not-found' }); return; }
  if (toUid === fromUid) { res.status(400).json({ ok: false, error: 'invalid-argument' }); return; }
  const targetLinks = await db.collection(`users/${toUid}/guardianLinks`).where('orgId', '==', orgId).where('schoolId', '==', schoolId).limit(1).get();
  if (targetLinks.empty) { res.status(412).json({ ok: false, error: 'failed-precondition' }); return; }
  const now = ts(); const incomingRef = db.doc(`users/${toUid}/parentConnectIncoming/${fromUid}`); const outgoingRef = db.doc(`users/${fromUid}/parentConnectOutgoing/${toUid}`);
  await db.runTransaction(async (tx) => { const existing = await tx.get(incomingRef); const status = existing.exists ? (existing.get('status') || 'pending') : 'pending'; if (status === 'accepted') return; const payload = { fromUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: existing.exists ? (existing.get('createdAt') || now) : now, updatedAt: now }; tx.set(incomingRef, payload, { merge: true }); tx.set(outgoingRef, { toUid, orgId, schoolId, note: note || null, status: 'pending', createdAt: now, updatedAt: now }, { merge: true }); });
  res.json({ ok: true });
}));

exports.respondParentConnectRequestHttp = onRequest({ region: 'us-central1', invoker: 'public', minInstances: 0 }, allowCors(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }
  const decoded = await requireUserFromRequest(req, res); if (!decoded) return;
  const toUid = decoded.uid; const { fromUid, orgId, schoolId, action } = req.body || {}; const act = String(action || '').toLowerCase();
  if (!fromUid || !orgId || !schoolId || !['accept', 'decline'].includes(act)) { res.status(400).json({ ok: false, error: 'invalid-argument' }); return; }
  const now = ts(); const incomingRef = db.doc(`users/${toUid}/parentConnectIncoming/${fromUid}`); const outgoingRef = db.doc(`users/${fromUid}/parentConnectOutgoing/${toUid}`);
  await db.runTransaction(async (tx) => { const inc = await tx.get(incomingRef); if (!inc.exists) throw new Error('not-found'); const cur = inc.data() || {}; if (cur.orgId !== orgId || cur.schoolId !== schoolId) throw new Error('failed-precondition'); const newStatus = act === 'accept' ? 'accepted' : 'declined'; tx.set(incomingRef, { status: newStatus, respondedAt: now, updatedAt: now }, { merge: true }); tx.set(outgoingRef, { status: newStatus, respondedAt: now, updatedAt: now }, { merge: true }); if (newStatus === 'accepted') { const aRef = db.doc(`users/${toUid}/parentConnections/${fromUid}`); const bRef = db.doc(`users/${fromUid}/parentConnections/${toUid}`); const conn = { orgId, schoolId, since: now }; tx.set(aRef, conn, { merge: true }); tx.set(bRef, conn, { merge: true }); } });
  res.json({ ok: true });
}));

exports.listMyParentConnectionsHttp = onRequest({ region: 'us-central1', invoker: 'public', minInstances: 0 }, allowCors(async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }
  const decoded = await requireUserFromRequest(req, res); if (!decoded) return;
  const uid = decoded.uid;
  const [incoming, outgoing, links] = await Promise.all([
    db.collection(`users/${uid}/parentConnectIncoming`).orderBy('updatedAt', 'desc').limit(50).get(),
    db.collection(`users/${uid}/parentConnectOutgoing`).orderBy('updatedAt', 'desc').limit(50).get(),
    db.collection(`users/${uid}/parentConnections`).limit(200).get(),
  ]);
  const mapDoc = (d) => ({ id: d.id, ...(d.data() || {}) });
  res.json({ ok: true, incoming: incoming.docs.map(mapDoc), outgoing: outgoing.docs.map(mapDoc), connections: links.docs.map(mapDoc) });
}));

// ───────────────── Maintenance / One-time Backfill Utilities ─────────────────
// backfillGuardianIndexes: Owner-only callable to (a) ensure guardians docs have orgId/schoolId
// fields and (b) create missing reverse index docs at users/{uid}/guardianLinks/{orgId__schoolId__studentId}.
// This is idempotent and processes up to `limit` guardians per invocation (default 300) to avoid timeouts.
// Remove or disable after successful backfill.
exports.backfillGuardianIndexes = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
  assertAuthed(req);
  const { orgId = null, schoolId = null, limit = 300, dryRun = false } = req.data || {};
  const isScoped = !!orgId && !!schoolId;
  const isOwner = !!req.auth.token?.owner;
  if (!isOwner) {
    if (!isScoped) throw new HttpsError('permission-denied', 'Owner only (global). Provide orgId and schoolId to run as admin/superintendent.');
    const allowed = await canManageSchool(req.auth.token || {}, String(orgId), String(schoolId), req.auth.uid);
    if (!allowed) throw new HttpsError('permission-denied', 'Requires Owner or Admin/Superintendent of that school.');
  }
  const max = Math.max(1, Math.min(1000, Number(limit) || 300));
  const results = { scanned: 0, updatedGuardianDocs: 0, createdReverseLinks: 0, skippedExisting: 0 };

  // Strategy:
  // 1. Query collectionGroup('guardians') optionally narrowed by orgId/schoolId if provided (so we can run in chunks).
  // 2. For each doc, parse path: orgs/{orgId}/schools/{schoolId}/students/{studentId}/guardians/{uid}
  // 3. If guardian doc missing orgId/schoolId, patch them.
  // 4. Ensure reverse link doc exists.
  // NOTE: We limit to `max` docs per call to keep execution < 1 min.

  // Build base query; we can't add both orgId & schoolId filters safely if older docs lack those fields, so we filter in memory.
  let q = db.collectionGroup('guardians');
  if (orgId) q = q.where('orgId', '==', String(orgId));
  // schoolId filter only if provided AND orgId provided (to avoid requiring composite index for partial data); else in-memory filter
  if (orgId && schoolId) q = q.where('schoolId', '==', String(schoolId));

  let snap;
  try { snap = await q.limit(max).get(); }
  catch (e) { throw new HttpsError('internal', 'Query failed (indexes missing?) ' + (e.message || e)); }

  const batch = db.batch();
  for (const d of (snap?.docs || [])) {
    if (results.scanned >= max) break; // safeguard
    results.scanned++;
    const ref = d.ref;
    const seg = ref.parent.parent.path.split('/'); // .../students/{studentId}
    if (seg.length < 6) { continue; }
    const parsedOrgId = seg[1];
    const parsedSchoolId = seg[3];
    const studentId = seg[5];
    const uid = ref.id;
    if (orgId && parsedOrgId !== orgId) continue; // extra safety
    if (schoolId && parsedSchoolId !== schoolId) continue;

    const data = d.data() || {};
    let needsUpdate = (!data.orgId || data.orgId !== parsedOrgId) || (!data.schoolId || data.schoolId !== parsedSchoolId);
    if (needsUpdate && dryRun) {
      results.updatedGuardianDocs++; // count as potential updates
    } else if (needsUpdate && !dryRun) {
      batch.set(ref, { orgId: parsedOrgId, schoolId: parsedSchoolId, updatedAt: ts() }, { merge: true });
      results.updatedGuardianDocs++;
    }

    // Reverse link key
    const revKey = `${parsedOrgId}__${parsedSchoolId}__${studentId}`;
    const revRef = db.doc(`users/${uid}/guardianLinks/${revKey}`);
    // We'll read minimal: assume missing if we can't get quickly; reading individually is fine (small N)
    let exists = false;
    try { const rSnap = await revRef.get(); exists = rSnap.exists; } catch { }
    if (!exists) {
      if (dryRun) {
        results.createdReverseLinks++;
      } else {
        batch.set(revRef, { orgId: parsedOrgId, schoolId: parsedSchoolId, studentId, linkedAt: ts() }, { merge: true });
        results.createdReverseLinks++;
      }
    } else {
      results.skippedExisting++;
    }
  }

  if (!dryRun) {
    try { await batch.commit(); } catch (e) { throw new HttpsError('internal', 'Batch commit failed: ' + (e.message || e)); }
  }
  return { ok: true, dryRun: !!dryRun, ...results };
});
