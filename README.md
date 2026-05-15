# Luc Contracting Scheduler

Internal job scheduling app for Luc Contracting.

## Commands

```bash
npm install
npm run dev
npm run build
```

`npm run dev` initializes the local D1 databases with the schema files in
`worker/`, starts the Worker with `wrangler dev --local` on port `8787`, and
starts Astro on `127.0.0.1:4325`.

## Local Development

Local development uses `.env` for the Astro frontend and `.dev.vars` for the
local Worker.

`.env`:

```text
PUBLIC_API_ORIGIN=http://127.0.0.1:8787
```

`.dev.vars`:

```text
SCHEDULER_AUTH_MODE=dev
SESSION_SECRET=<any-random-32+-character-value>
APP_ORIGIN=http://127.0.0.1:8787
FRONTEND_ORIGIN=http://127.0.0.1:4325
DEV_AUTH_USER_ID=local-dev-supervisor
DEV_AUTH_EMAIL=dev@localhost
DEV_AUTH_NAME=Local Dev
DEV_AUTH_ROLE=supervisor
```

When `SCHEDULER_AUTH_MODE=dev`, the Worker only enables the auth bypass for
localhost or `127.0.0.1`. The bypass creates or updates the configured dev user
in the local `SCHEDULER_DB` D1 database and signs in without Google OAuth.

Wrangler is always started with `--local`, so local development reads and writes
the local D1 state under `.wrangler` instead of Cloudflare's public databases.

## Production Notes

- GitHub Pages deploys from `.github/workflows/deploy-pages.yml` on pushes to
  `main`.
- Keep secrets, local vars, database exports, and generated builds out of git.
- Verify the configured sender domain before enabling email notifications.
- Apply database schema or migrations through the deployment environment, not
  from public documentation.
- Calendar feed URLs are bearer links. Revoke and regenerate them if a link is
  shared with the wrong person or exposed somewhere public.
