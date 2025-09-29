// functions/index.js
// Node 18  •  Firebase Functions v2  •  CommonJS

// ───────────────── Imports ─────────────────
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { onDocumentWritten }        = require('firebase-functions/v2/firestore');
const { beforeUserSignedIn }       = require('firebase-functions/v2/identity');
const { initializeApp }            = require('firebase-admin/app');
const { getAuth }                  = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

try { initializeApp(); } catch (_) {}
const auth = getAuth();
const db   = getFirestore();

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

  async function applyClaims(uid, email, reason = 'recompute') {
    const claims = await computeClaims(uid, email);
    await auth.setCustomUserClaims(uid, claims);
    await bumpUserTokens(uid, { reason });
    return claims;
  }

  // ───────────────── Auth Blocking (instant claims on first token) ─────────────────
  // Runs BEFORE a session starts; puts final roles/orgs/schools into the first ID token.
  exports.beforeSignIn = beforeUserSignedIn(async (event) => {
    const { uid, email } = event.data || {};
    if (!uid) return {};
    const claims = await computeClaims(uid, email || '');
    return { customClaims: claims };
  });

  // ───────────────── Triggers (recompute after writes) ─────────────────
  exports.onSchoolMemberWrite = onDocumentWritten(
    { document: 'orgs/{orgId}/schools/{schoolId}/members/{uid}', region: 'us-central1', minInstances: 1 },
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
    { document: 'orgs/{orgId}/members/{uid}', region: 'us-central1', minInstances: 1 },
    async (event) => {
      const uid = event.params.uid;
      const user = await auth.getUser(uid).catch(() => null);
      if (!user) return;
      await applyClaims(uid, user.email || '', 'org-membership-changed');
    }
  );

  // Optional: if you edit org.superEmails manually, keep claims in sync
  exports.onOrgDocWrite = onDocumentWritten(
    { document: 'orgs/{orgId}', region: 'us-central1', minInstances: 1 },
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
  exports.ownerGrant = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
    await bumpUserTokens(req.auth.uid, { reason: 'owner-grant' });
    return { ok: true };
  });

  // Create org + superintendent (owner only)
  exports.createSuperintendent = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
  exports.ownerAddSuperintendent = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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

  exports.ownerRemoveSuperintendent = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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

  // Add a school (owner or superintendent of that org)
  exports.addSchool = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
  exports.setSchoolMemberRoles = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
  exports.listSchoolMembers = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
      };
    });

    return { ok: true, members };
  });

  // List classes for a school (ordered) — lightweight read used by roles UI
  exports.listSchoolClasses = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
  exports.setTeacherClasses = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
  exports.inviteUser = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
  exports.refreshMyClaims = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
    assertAuthed(req);
    const user = await auth.getUser(req.auth.uid);
    const claims = await applyClaims(user.uid, user.email || '', 'manual-refresh');
    return { ok: true, claims };
  });

  // Admin: force revoke a user’s tokens (owner or any superintendent)
  exports.adminRevokeUserTokens = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
    assertAuthed(req);
    const claims = req.auth.token || {};
    const { uid, reason = 'admin-revoke' } = req.data || {};
    if (!uid) throw new HttpsError('invalid-argument', 'uid required');
    if (!claims.owner && !claims.superintendent) throw new HttpsError('permission-denied', 'Owner or Superintendent only');
    await bumpUserTokens(uid, { reason });
    return { ok: true };
  });

  // Delete a school and all nested data, then recompute usedSchools
  exports.deleteSchool = onCall({ region: 'us-central1', minInstances: 1 }, async (req) => {
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
    { document: 'orgs/{orgId}/schools/{schoolId}', region: 'us-central1', minInstances: 1 },
    async (event) => {
      const orgId = event.params.orgId;
      if (!orgId) return;
      const orgRef = db.doc(`orgs/${orgId}`);
      const docs = await orgRef.collection('schools').listDocuments();
      await orgRef.set({ usedSchools: docs.length, updatedAt: ts() }, { merge: true });
    }
  );
