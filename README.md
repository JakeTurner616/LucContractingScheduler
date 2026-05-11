# Luc Contracting Scheduler

Static Astro frontend for the internal scheduler app.

## Commands

```bash
npm install
npm run dev
npm run build
```

The frontend talks to the Cloudflare Worker at:

```text
https://luc-contracting-scheduler-worker.jake-3c8.workers.dev
```

## Worker

The scheduler Worker source lives in `worker/scheduler-worker.js`.

The D1 schema for the expected MVP tables lives in `worker/schema.sql`.

Required Worker bindings and vars:

```text
SCHEDULER_DB
APP_ORIGIN=https://luc-contracting-scheduler-worker.jake-3c8.workers.dev
FRONTEND_ORIGIN=http://localhost:4325
GOOGLE_OAUTH_ID
GOOGLE_OAUTH_SECRET
SESSION_SECRET
RESEND_API_KEY
```
