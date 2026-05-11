# Luc Contracting Scheduler

Internal job scheduling app for Luc Contracting.

## Commands

```bash
npm install
npm run dev
npm run build
```

## Domain Changes

When moving between local, staging, or production domains, update:

- `src/lib/config.ts`: frontend API origin
- `astro.config.mjs`: local dev proxy target for calendar feeds
- GitHub repository variables: `PUBLIC_API_ORIGIN` and `PUBLIC_SITE_URL`
- Worker environment: app origin and frontend origin
- Google OAuth redirect URI: `/auth/google/callback` on the active Worker/app origin
- Production routing: forward `/ics/*` on the frontend domain to the Worker calendar feed route

Calendar feed links should stay on the frontend domain when possible, for example:

```text
https://scheduler.example.com/ics/<token>
```

## Deployment Notes

- GitHub Pages deploys from `.github/workflows/deploy-pages.yml` on pushes to `main`.
- Keep secrets, local vars, database exports, and generated builds out of git.
- Verify the configured sender domain before enabling email notifications.
- Apply database schema or migrations through the deployment environment, not from public documentation.
