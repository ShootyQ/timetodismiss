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
