# timetodismiss
Dismissal Platform for Schools

## Deployments

The live website is hosted by GitHub Pages. Every push to `main` runs
`.github/workflows/deploy-live-on-main.yml`, publishes the repository root, and
serves it at https://timetodismiss.com using the root `CNAME` file.

- Dev previews: on pushes to `aftercare-dev` or manual runs
	- Workflow: `.github/workflows/deploy-dev-hosting.yml`
	- Creates a Hosting preview channel named `dev` that auto-expires in 7 days
	- URL: https://dev--dismissalcaller.web.app (stable named channel URL)
	- Deploys Hosting only; it does not modify Firestore rules, indexes, or Functions
	- Hosting preview channels still use the configured `dismissalcaller` Firebase project for Auth, Firestore, and Functions

- Production: on pushes to `main` or manual runs
	- Workflow: `.github/workflows/deploy-live-on-main.yml`
	- Deploys the static site to GitHub Pages at https://timetodismiss.com
	- Firebase continues to provide Auth, Firestore, and Functions; Firebase Hosting is not the production frontend

### Prerequisites

In GitHub → Settings → Pages, set **Source** to **GitHub Actions**. No deployment
secret is required for the live GitHub Pages workflow.

The Firebase service account secret is required only for Firebase preview and
Functions workflows:

- `FIREBASE_SERVICE_ACCOUNT_DISMISSALCALLER`: contents of a Firebase service account JSON key with the permissions required by the selected Firebase workflow.

### Manually run a deploy

1) Go to the Actions tab.
2) Choose `Deploy live site to GitHub Pages`.
3) Click “Run workflow” and select `main`.

### Verify dev preview

- Open the Actions run log for the dev workflow; the job summary prints the preview URL.
- Or visit: https://dev--dismissalcaller.web.app
- Aftercare operator page: `/aftercare`
- Aftercare management page: `/aftercare-manage`
- The Hosting workflow does not deploy Functions, Firestore rules, or indexes. Deploy the Aftercare Functions separately only when the target Firebase project is ready for them.

### Deploy Aftercare Functions

From GitHub Actions, run the `Deploy Aftercare Functions` workflow manually, enter `deploy-functions` for confirmation, and choose the Firebase project. It deploys the targeted Aftercare callables and `autoCloseAftercareSessions` without deploying Firestore rules or indexes. The `FIREBASE_SERVICE_ACCOUNT_DISMISSALCALLER` secret must have Functions deployment permissions; Hosting Admin alone is insufficient. The workflow updates the selected project's Functions backend, while Hosting preview channels still share that project's Auth and Firestore.

For a local clone, the equivalent PowerShell command is `./deploy.ps1 -ProjectId dismissalcaller`. The repository targets the Node 22 Functions runtime.

### Aftercare operator visits and time corrections

- A checked-out student can **Check in again** before the daily cutoff. This creates a new visit and preserves the earlier closed visit; time away is not attendance.
- Cards show the latest visit's **IN** and **OUT** in the school's timezone, plus the visit number for repeat attendance. OUT is blank (—) while checked in. Students with today's aftercare attendance remain available even if their dismissal status is already picked up.
- Tap a student's name, then **Edit today's IN / OUT times**. Select any of today's visits and correct one visit at a time. The editor shows original times and a save preview. Cancel changes nothing.
- The same active school staff authorized for check-in/out may correct **today only**. Blank OUT keeps an open visit open; entering OUT explicitly checks the student out after confirmation. A closed visit requires both times and cannot be reopened by clearing OUT—use **Check in again** instead.
- The server enforces school-local today, student/school authorization, current revision, cutoff, nonfuture times, positive duration and nonoverlapping visits. Stale edits require a reload. Invalid existing records need manager review. Unchanged displayed minutes preserve timestamp precision and an unchanged save writes nothing.
- Corrections update the matching attendance card atomically and record before/after times with the staff identity under the session's `corrections` subcollection. Earlier visits do not overwrite the active visit's card. Captured rates, family assignments and original check-in/out actors are preserved. Intentionally saved time corrections can change billing; viewing cards or the editor does not alter records. There is no migration or backfill.

The editor requires the new `getAftercareStudentTodaySessions` and `updateAftercareStudentTodaySession` callables. Both explicit Functions deployment workflows and the local deploy helper include them. For backend-first rollout, manually deploy and verify Functions from the feature revision before publishing the frontend. The automatic live workflow still publishes Pages before Functions; if the backend deployment fails, the editor reports that time editing is unavailable while normal check-in/out remains usable. Do not broaden Firestore rules or substitute manager callables to bypass a missing deployment.

Run `npm test --prefix functions` for billing and correction tests. Correction tests use injected Firestore transaction mocks (no production data). Before live use, verify with an authenticated development-school staff account: repeat visits, earlier/latest corrections, open-visit closure, denied prior-day changes, and concurrent checkout/auto-close. Mock tests do not replace deployment or authenticated smoke testing.

### Aftercare reporting semantics

Aftercare reports are read-only. Billing groups students by the canonical current `aftercareStudentFamilies` mapping so linked siblings appear together and receive sibling-overlap billing. If no current mapping exists, the family stored on the session remains the fallback. Report generation never rewrites sessions or family mappings. Reports show the current configured roster separately from the students billed in the selected month and flag open or invalid sessions that were excluded from totals.

The management page provides a one-row-per-account monthly summary CSV, a session-level audit CSV, and family statements through browser Print / Save as PDF. Viewing, exporting, and printing reports do not write Firestore data.

For sibling billing, sessions from different students whose clock-in times are within five minutes and whose clock-out times are also within five minutes are billed as one family interval from the earliest check-in through the first recorded check-out. This intentionally removes small solo edge charges caused by checking siblings in or out one at a time. Each student's recorded attendance duration remains unchanged. Parent statements show the billed check-in and billed check-out for every service day.

### Hosting configuration

GitHub Pages publishes the repository root. `CNAME` maps the deployment to
`timetodismiss.com`, and `.nojekyll` keeps the site in plain static-file mode.

`firebase.json` remains available for Firebase preview hosting and includes:

- site: `dismissalcaller`
- public: `.` (serves static files from repo root)
- cleanUrls enabled

## Analytics

- Google Analytics 4 is initialized globally from `site-header.js` using Measurement ID `G-2799S6XEND`.
- To change the GA property later, update the `GA_MEASUREMENT_ID` constant and the `measurementId` inside the `firebaseConfig` block in `site-header.js`.
- The GA script loads asynchronously on every page that includes `site-header.js` (most pages). Page views are tracked automatically.
