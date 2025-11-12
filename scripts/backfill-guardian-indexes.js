#!/usr/bin/env node
'use strict';

const admin = require('firebase-admin');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryRun'],
  string: ['org', 'school', 'project'],
  default: { limit: 300, dryRun: false, project: 'dismissalcallerdev' }
});

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: argv.project
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const ts = () => FieldValue.serverTimestamp();

async function backfill(opts) {
  const { orgId = null, schoolId = null, limit = 300, dryRun = false } = opts;
  const max = Math.max(1, Math.min(1000, Number(limit) || 300));
  const results = { ok: true, dryRun, scanned: 0, updatedGuardianDocs: 0, createdReverseLinks: 0, skippedExisting: 0 };

  let query = db.collectionGroup('guardians');
  if (orgId) query = query.where('orgId', '==', String(orgId));
  if (orgId && schoolId) query = query.where('schoolId', '==', String(schoolId));

  const snap = await query.limit(max).get();
  const batch = db.batch();

  for (const doc of snap.docs) {
    if (results.scanned >= max) break;
    results.scanned++;

    const ref = doc.ref;
    const parts = ref.parent.parent.path.split('/');
    if (parts.length < 6) continue;
    const parsedOrgId = parts[1];
    const parsedSchoolId = parts[3];
    const studentId = parts[5];
    const uid = ref.id;

    if (orgId && parsedOrgId !== orgId) continue;
    if (schoolId && parsedSchoolId !== schoolId) continue;

    const data = doc.data() || {};
    const needsUpdate = (!data.orgId || data.orgId !== parsedOrgId) || (!data.schoolId || data.schoolId !== parsedSchoolId);

    if (needsUpdate) {
      if (dryRun) {
        results.updatedGuardianDocs++;
      } else {
        batch.set(ref, { orgId: parsedOrgId, schoolId: parsedSchoolId, updatedAt: ts() }, { merge: true });
        results.updatedGuardianDocs++;
      }
    }

    const revKey = `${parsedOrgId}__${parsedSchoolId}__${studentId}`;
    const revRef = db.doc(`users/${uid}/guardianLinks/${revKey}`);
    const revSnap = await revRef.get();
    if (!revSnap.exists) {
      if (dryRun) {
        results.createdReverseLinks++;
      } else {
        batch.set(revRef, {
          orgId: parsedOrgId,
          schoolId: parsedSchoolId,
          studentId,
          linkedAt: ts()
        }, { merge: true });
        results.createdReverseLinks++;
      }
    } else {
      results.skippedExisting++;
    }
  }

  if (!dryRun && (results.updatedGuardianDocs + results.createdReverseLinks > 0)) {
    await batch.commit();
  }

  return results;
}

backfill({
  orgId: argv.org ?? null,
  schoolId: argv.school ?? null,
  limit: argv.limit ?? 300,
  dryRun: argv.dryRun
}).then((res) => {
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
