# timetodismiss
Dismissal Platform for Schools

## Fast auth role updates (no more 2–5 min delay)

This repo includes Firebase Cloud Functions and Firestore Rules to make role changes effective immediately.

What’s included
- Functions:
	- https callable `refreshMyClaims` for clients to request a fresh recomputation of custom claims after login.
	- Firestore trigger `onMemberWrite` to recompute a user's claims when `orgs/{orgId}/schools/{schoolId}/members/{uid}` changes.
	- Optional `adminSetClaims` callable for admin/superintendent to force a recompute for any user.
	- Bumps `users/{uid}.claimsVersion` so the web client sees it and forces a `getIdToken(true)` refresh.
- Firestore rules enforce access using those claims and tenant IDs.

Deploy (Windows PowerShell)
1) Install Firebase CLI if needed
```
npm install -g firebase-tools
```
2) Login and pick the project
```
firebase login ; firebase use dismissalcaller
```
3) Install function deps and deploy
```
cd functions ; npm ci ; cd ..
firebase deploy --only functions,firestore:rules
```

Client behavior
- On sign-in, the header calls `refreshMyClaims` once per session and polls for updated claims for a few seconds.
- It also listens to `users/{uid}.claimsVersion` to force a token refresh whenever roles change.

Admin workflow
- Updating a user's roles under `orgs/{orgId}/schools/{schoolId}/members/{uid}` will trigger the function and the change will be live within seconds.
- You can also call the `adminSetClaims` callable if you need to force a recompute.

Troubleshooting
- If a user still sees old roles, click “Sign out” then sign back in; or visit `/index.html?reset=1` to clear caches and storage.
- Verify their membership doc has the expected `roles` array and that the project is set to `dismissalcaller`.
