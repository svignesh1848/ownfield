# End-to-end tester

Playwright runs a full day on a phone-sized screen (iPhone 13) against a fresh Postgres and a locally started app. No real passwords are committed: CI generates them at runtime.

On every pull request and push to master the `e2e` job:

1. Creates a new sample company from the platform owner (two-step sign-in included).
2. Has the admin upload users, outlets, SKUs and stock through the real Excel import endpoints.
3. Walks the rep (check-in, visit photo, order), manager (outlet and order approval, dashboard) and distributor (accept, deliver, download the order file).
4. Checks the database after each step, including stock holds and company isolation.
5. Saves a screenshot of each screen and fails if the layout overflows or the console reports an error.

A separate `live-smoke` workflow hits https://app.ownfield.in after each deploy and every 30 minutes. If the demo admin login should run, add the repository secret `OWNFIELD_DEMO_PASSWORD` (the current demo password). The password is never printed. A failure opens or updates a GitHub issue labelled `live-down`.

```bash
# Local run (Postgres required)
export DATABASE_URL=postgres://...
export OWNER_PASSWORD=...
export E2E_PASSWORD=...
npm ci && npm run build
npx playwright install chromium
bash e2e/run-server.sh &
npm run test:e2e
```
