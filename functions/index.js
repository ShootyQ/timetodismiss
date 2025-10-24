// functions/index.js
// Node 18  •  Firebase Functions v2  •  CommonJS

// ───────────────── Imports ─────────────────
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onDocumentWritten }        = require('firebase-functions/v2/firestore');
const { beforeUserSignedIn }       = require('firebase-functions/v2/identity');
const { initializeApp }            = require('firebase-admin/app');
const { getAuth }                  = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

try { initializeApp(); } catch (_) {}
const auth = getAuth();
const db   = getFirestore();
const ENABLE_BEFORE_SIGNIN = String(process.env.ENABLE_BEFORE_SIGNIN || '').toLowerCase() === 'true';

// ───────────────── Small helpers ─────────────────
const ts        = () => FieldValue.serverTimestamp();
const norm      = (s) => String(s || '').trim().toLowerCase();
const uniq      = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

const flagsFrom = (src) => {
  // Accepts {roles:{admin,caller,viewer}} or roles array or role string
  const map =
    (src && typeof src.roles === 'object' && !Array.isArray(src.roles)) ? src.roles :
    (Array.isArray(src?.roles)) ? src.roles.reduce((m,k)=>(m[norm(k)]=true,m),{}) :
    (src?.role) ? { [norm(src.role)]: true } : {};

  const admin  = !!map.admin;
  const caller = admin || !!map.caller;
  const viewer = caller || !!map.viewer;
  const role   = admin ? 'admin' : caller ? 'caller' : viewer ? 'viewer' : null;
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
  try { await auth.revokeRefreshTokens(uid); } catch (_) {}
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
    owner: false, superintendent: false, admin: false, caller: false, viewer: false,
    orgIds: [], schoolIds: []
  };

  // Owner? (store this on users/{uid}.owner = true)
  const uDoc = await db.doc(`users/${uid}`).get().catch(() => null);
  if (uDoc?.exists && uDoc.get('owner') === true) base.owner = true;

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
      hasAdmin  = hasAdmin  || f.admin;
      hasCaller = hasCaller || f.caller;
      hasViewer = hasViewer || f.viewer;
    }

    base.orgIds    = uniq(base.orgIds);
    base.schoolIds = uniq(base.schoolIds);

    // Collapse flags (viewer implied by any higher role or superintendent)
    base.admin  = !!hasAdmin;
    base.caller = !!hasCaller || base.admin;
    base.viewer = !!hasViewer || base.caller || base.admin || base.superintendent;

    // Convenience anchors
    if (base.orgIds.length === 1) base.orgId = base.orgIds[0];
    if (base.schoolIds.length >= 1) base.schoolId = base.schoolIds[0];

    // Primary role label (owner > admin > caller > viewer > superintendent)
    if (base.owner)            base.role = 'owner';
    else if (base.admin)       base.role = 'admin';
    else if (base.caller)      base.role = 'caller';
    else if (base.viewer && !base.superintendent) base.role = 'viewer';
    else if (base.superintendent) base.role = base.role || 'superintendent';

    // Also include a roles[] array to align with rules.hasRole() checks
    const rolesArr = [];
    if (base.owner) rolesArr.push('owner');
    if (base.superintendent) rolesArr.push('superintendent');
    if (base.admin) rolesArr.push('admin');
    if (base.caller) rolesArr.push('caller');
    if (base.viewer) rolesArr.push('viewer');
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
    exports.beforeSignIn = beforeUserSignedIn(async (event) => {
      const { uid, email } = event.data || {};
      if (!uid) return {};
      const claims = await computeClaims(uid, email || '');
      return { customClaims: claims };
    });
  }

  // ───────────────── Triggers (recompute after writes) ─────────────────
  exports.onSchoolMemberWrite = onDocumentWritten(
    { document: 'orgs/{orgId}/schools/{schoolId}/members/{uid}', region: 'us-central1', minInstances: 0 },
    async (event) => {
      const after  = event.data.after?.data();
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
      const after  = event.data.after?.data()  || {};
      const prev = new Set((before.superEmails || []).map(norm));
      const next = new Set((after.superEmails  || []).map(norm));
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
  exports.ownerGrant = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
    assertAuthed(req);
    if (norm(req.auth.token.email) !== 'carlsonandy85@gmail.com') {
      throw new HttpsError('permission-denied', 'Nope.');
    }
    await auth.setCustomUserClaims(req.auth.uid, {
      role: 'owner',
      owner: true,
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
    await bumpUserTokens(req.auth.uid, { reason: 'owner-grant' });
    return { ok: true };
  });

  // Create org + superintendent (owner only)
  exports.createSuperintendent = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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

  // Owner: add/remove superintendent
  exports.ownerAddSuperintendent = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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

  exports.ownerRemoveSuperintendent = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
  exports.resetAllToWaiting = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
      } catch(_) { allowed = false; }
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
  exports.addSchool = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
      const used    = Number(org.usedSchools || 0);
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
  exports.setSchoolMemberRoles = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
    assertAuthed(req);
    const { orgId, schoolId, user = {}, roles = {} } = req.data || {};
    if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');

    const claims = req.auth.token || {};
    const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
    if (!allowed) throw new HttpsError('permission-denied', 'Admin or higher required for this school.');

    // Resolve/create target user
    let target = null;
    if (user.uid) { try { target = await auth.getUser(String(user.uid)); } catch {} }
    if (!target && user.email) {
      try { target = await auth.getUserByEmail(String(user.email)); }
      catch { target = await auth.createUser({ email: String(user.email) }); }
    }
    if (!target) throw new HttpsError('not-found', 'Provide a valid uid or email.');

    // Normalize role booleans (viewer implied by caller/admin)
    const r = {
      admin:  !!roles.admin,
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
  exports.listSchoolMembers = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
  exports.listSchoolClasses = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
    assertAuthed(req);
    const { orgId, schoolId } = req.data || {};
    if (!orgId || !schoolId) throw new HttpsError('invalid-argument', 'orgId and schoolId required.');
    const claims = req.auth.token || {};
    const allowed = await canManageSchool(claims, orgId, schoolId, req.auth.uid);
    if (!allowed) throw new HttpsError('permission-denied', 'Admin or higher required.');
    const col = db.collection(`orgs/${orgId}/schools/${schoolId}/classes`);
    let docs = [];
    try {
      const snap = await col.orderBy('order','asc').get();
      docs = snap.docs;
    } catch (e){
      // fallback name
      try { const snap2 = await col.orderBy('name','asc').get(); docs = snap2.docs; }
      catch { const snap3 = await col.get(); docs = snap3.docs; }
    }
    const classes = docs.map(d => {
      const data = d.data() || {};
      const out = { id: d.id, name: data.name || data.title || d.id };
      if (typeof data.order === 'number') out.order = data.order;
      return out;
    }).sort((a,b)=>{
      const ao = (typeof a.order==='number')?a.order:999999;
      const bo = (typeof b.order==='number')?b.order:999999;
      if (ao!==bo) return ao-bo;
      return (a.name||a.id||'').localeCompare(b.name||b.id||'');
    });
    return { ok: true, classes };
  });

  // Assign classes to a teacher/member
  // Stores at members/{uid}.teacher.classIds (array)
  exports.setTeacherClasses = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
    const clean = (classIds||[]).map(c=>String(c||'').trim()).filter(Boolean);
    await ref.set({ teacher: { classIds: clean }, updatedAt: ts() }, { merge: true });
    return { ok: true, classIds: clean };
  });

  // Invite then set initial role (writes members/; claims applied immediately)
  exports.inviteUser = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
  exports.refreshMyClaims = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
  exports.deleteSchool = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
  function randomToken(bytes = 16){
    try { return crypto.randomBytes(bytes).toString('base64url'); }
    catch { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
  }
  function shortCode8(){
    const alphabet = 'ABCDEFGHJKMNPqrstuvwxyz23456789abcdefghjkmnpQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random()*alphabet.length)];
    return (s.slice(0,4) + '-' + s.slice(4)).toUpperCase();
  }
  function parseInvitePath(p){
    // orgs/{orgId}/schools/{schoolId}/invites/{inviteId}
    const seg = String(p||'').split('/');
    if (seg.length < 6) return { orgId: null, schoolId: null, inviteId: null };
    return { orgId: seg[1], schoolId: seg[3], inviteId: seg[5] };
  }

  // Admin/staff: create a guardian claim invite for a student
  // Input: { orgId, schoolId, studentId, email?, relationshipType? }
  exports.createGuardianInvite = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
      code8Lower: code8.replace(/-/g,'').toLowerCase(),
      token,
      status: 'pending',
      orgId, schoolId,
      daysValid: Math.max(1, Math.min(60, Number(daysValid)||14)),
      createdAt: ts(),
      expiresAt: FieldValue.increment(0) // purely to keep shape; validity enforced as createdAt + daysValid on read
    };
    await inviteRef.set(payload, { merge: true });

    // Return link (client-host agnostic: relative path)
    const inviteId = inviteRef.id;
    const link = `/claim.html?inv=${encodeURIComponent(inviteId)}&token=${encodeURIComponent(token)}`;
    return { ok: true, inviteId, code8, token, link };
  });

  // Signed-in guardian: claim invite via inv+token OR code
  // Input: { inv, token } OR { code }
  exports.claimGuardianInvite = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
    assertAuthed(req);
    const uid = req.auth.uid;
    const { inv, token, code } = req.data || {};

    // Locate the invite doc
    let docSnap = null; let docRef = null;
    if (code) {
      const codeKey = String(code).replace(/-/g,'').toLowerCase();
      const q = await db.collectionGroup('invites')
        .where('code8Lower','==', codeKey)
        .where('status','==','pending')
        .limit(1).get();
      if (!q.empty) { docSnap = q.docs[0]; docRef = docSnap.ref; }
    } else if (token) {
      const q = await db.collectionGroup('invites')
        .where('token','==', String(token))
        .where('status','==','pending')
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
    try { const t = invite.createdAt; if (t && typeof t.toMillis === 'function') createdAtMs = t.toMillis(); } catch {}
    const daysValid = Math.max(1, Math.min(60, Number(invite.daysValid)||14));
    const expiresMs = createdAtMs + daysValid * 24*60*60*1000;
    if (Date.now() > expiresMs) throw new HttpsError('deadline-exceeded', 'Invite expired.');

    const studentId = String(invite.studentId || '');
    if (!studentId) throw new HttpsError('invalid-argument', 'Invite missing studentId.');

    const studentRef = db.doc(`orgs/${orgId}/schools/${schoolId}/students/${studentId}`);
    const linkRef    = studentRef.collection('guardians').doc(uid);

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
      } catch (_) {}
      tx.set(reverseRef, {
        orgId,
        schoolId,
        studentId,
        name: studentName,
        tag: studentTag || null,
        linkedAt: ts(),
      }, { merge: true });
    });

    // Force token refresh so UI updates immediately
    await bumpUserTokens(uid, { reason: 'guardian-claim-consumed' });

    return { ok: true, orgId, schoolId, studentId };
  });

  // Guardian helper: list students linked to current user
  // Returns [{ orgId, schoolId, studentId, name }]
  exports.listMyLinkedStudents = onCall({ region: 'us-central1', minInstances: 0 }, async (req) => {
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
        for (const s of needEnrich){
          try {
            const ref = db.doc(`orgs/${s.orgId}/schools/${s.schoolId}/students/${s.studentId}`);
            const snap = await ref.get();
            if (snap.exists){
              const d = snap.data() || {};
              const nm = d.name || [d.firstName, d.lastName].filter(Boolean).join(' ');
              if (nm) s.name = nm;
              const tg = String(d.carTag || d.tag || '').toUpperCase().trim();
              if (tg) s.tag = tg;
            }
          } catch (e) { /* ignore */ }
        }
        return { ok: true, students: out };
      }
    } catch (e) {
      console.error('[listMyLinkedStudents] reverse index read failed', e);
    }
    try {
      // Fallback: collection group scan of guardians
      const snap = await db.collectionGroup('guardians').where('uid','==', uid).limit(100).get();
      for (const d of snap.docs){
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
    return { ok: true, students: out };
  });
