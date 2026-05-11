const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const DEFAULT_FRONTEND_ORIGIN = "http://localhost:4325";
const DEFAULT_RESEND_FROM = "noreply@updates.serverboi.org";
const SESSION_COOKIE = "scheduler_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders(request, env) });
      }

      if (url.pathname === "/" || url.pathname === "/login") return workerLoginPage();
      if (url.pathname === "/auth/google/start") return startGoogleAuth(env, url);
      if (url.pathname === "/auth/google/callback") return finishGoogleAuth(request, env, url);
      if (url.pathname === "/auth/logout" && request.method === "POST") return json(request, env, { ok: true }, { headers: [["Set-Cookie", clearCookie(SESSION_COOKIE)]] });
      if (url.pathname.startsWith("/ics/") && request.method === "GET") {
        try {
          return await renderIcsFeed(env, url.pathname.slice("/ics/".length));
        } catch (error) {
          const message = error instanceof Error ? error.message : "ICS feed failed";
          console.error(error);
          return new Response(`ICS feed error: ${message}`, {
            status: 500,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }
      }

      if (url.pathname === "/api/me" && request.method === "GET") return json(request, env, { user: await requireUser(request, env) });

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (url.pathname === "/api/jobs" || jobMatch) {
        const user = await requireUser(request, env);
        if (request.method === "GET" && !jobMatch) return listJobs(request, env, user);
        if (request.method === "POST" && !jobMatch) {
          requireSupervisor(user);
          return saveJob(request, env);
        }
        if (request.method === "PUT" && jobMatch) {
          requireSupervisor(user);
          return saveJob(request, env, jobMatch[1]);
        }
      }

      if (url.pathname === "/api/users") {
        const user = await requireUser(request, env);
        if (request.method === "GET") return listUsers(request, env, user);
        if (request.method === "POST") {
          requireSupervisor(user);
          return createUser(request, env);
        }
      }

      if (url.pathname === "/api/consultations" && request.method === "GET") {
        requireSupervisor(await requireUser(request, env));
        return listConsultations(request, env);
      }

      if (url.pathname === "/api/feeds") {
        const user = await requireUser(request, env);
        if (request.method === "GET") return listFeeds(request, env, user);
        if (request.method === "POST") {
          requireSupervisor(user);
          return createFeed(request, env);
        }
      }

      return json(request, env, { error: "Not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(request, env, error);
    }
  },
};

function workerLoginPage() {
  return html(`
    <main style="font-family:system-ui;padding:40px;max-width:640px;margin:auto">
      <h1>Luc Contracting Scheduler</h1>
      <p>Internal scheduling dashboard.</p>
      <a href="/auth/google/start"><button style="font:inherit;padding:12px 18px;cursor:pointer">Sign in with Google</button></a>
    </main>
  `);
}

async function startGoogleAuth(env, url) {
  const redirectUri = `${env.APP_ORIGIN}/auth/google/callback`;
  const state = randomState();
  const returnTo = getSafeReturnTo(url.searchParams.get("return_to"), env);
  const googleUrl = new URL(GOOGLE_AUTH_URL);
  googleUrl.searchParams.set("client_id", env.GOOGLE_OAUTH_ID.trim());
  googleUrl.searchParams.set("redirect_uri", redirectUri);
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", "openid email profile");
  googleUrl.searchParams.set("prompt", "select_account");
  googleUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: [
      ["Location", googleUrl.toString()],
      ["Set-Cookie", cookie("oauth_state", state, { path: "/auth/google/callback", maxAge: 600, sameSite: "Lax" })],
      ["Set-Cookie", cookie("oauth_return_to", encodeURIComponent(returnTo), { path: "/auth/google/callback", maxAge: 600, sameSite: "Lax" })],
    ],
  });
}

async function finishGoogleAuth(request, env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, "oauth_state");
  const returnToCookie = getCookie(request, "oauth_return_to");
  const returnTo = getSafeReturnTo(returnToCookie ? decodeURIComponent(returnToCookie) : null, env);

  if (!state || !expectedState || state !== expectedState) return new Response("Invalid OAuth state", { status: 400, headers: clearOauthCookies() });
  if (!code) return new Response("Missing Google OAuth code", { status: 400, headers: clearOauthCookies() });

  const redirectUri = `${env.APP_ORIGIN}/auth/google/callback`;
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_ID.trim(),
      client_secret: env.GOOGLE_OAUTH_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return new Response(await tokenRes.text(), { status: 400, headers: clearOauthCookies() });

  const tokenData = await tokenRes.json();
  const userRes = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
  if (!userRes.ok) return new Response("Failed to fetch Google profile", { status: 400, headers: clearOauthCookies() });

  const googleUser = await userRes.json();
  const allowedUser = await findActiveUserByEmail(env, googleUser.email);
  if (!allowedUser) {
    return html(`
      <main style="font-family:system-ui;padding:40px;max-width:720px;margin:auto">
        <h1>Access denied</h1>
        <p>Your Google account is not approved for this scheduler.</p>
        <p><strong>${escapeHtml(googleUser.email)}</strong></p>
        <p>Ask a supervisor to add this email to the scheduler users table.</p>
        <p><a href="/login">Back to login</a></p>
      </main>
    `, 403, clearOauthCookies());
  }

  await env.SCHEDULER_DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(allowedUser.id).run();
  const session = await createSession(env, allowedUser);
  const redirectUrl = new URL(returnTo);
  if (shouldPassSessionInRedirect(redirectUrl, env)) redirectUrl.searchParams.set("session", session);

  return new Response(null, {
    status: 302,
    headers: [
      ["Location", redirectUrl.toString()],
      ["Set-Cookie", cookie(SESSION_COOKIE, session, { path: "/", maxAge: SESSION_MAX_AGE, sameSite: "None" })],
      ...clearOauthCookiePairs(),
    ],
  });
}

async function listJobs(request, env, user) {
  const statement = user.role === "supervisor"
    ? env.SCHEDULER_DB.prepare(jobSelectSql("1 = 1"))
    : env.SCHEDULER_DB.prepare(jobSelectSql("EXISTS (SELECT 1 FROM job_assignments worker_filter WHERE worker_filter.job_id = jobs.id AND worker_filter.user_id = ?)")).bind(user.id);
  const rows = await statement.all();
  return json(request, env, { jobs: normalizeJobs(rows.results ?? []) });
}

function jobSelectSql(whereClause) {
  return `
    SELECT jobs.id, jobs.title, jobs.location, jobs.scheduled_start, jobs.scheduled_end, jobs.status,
      jobs.public_notes, jobs.internal_notes, jobs.created_at, jobs.updated_at,
      GROUP_CONCAT(users.id) AS assigned_user_ids,
      GROUP_CONCAT(COALESCE(users.name, users.email)) AS assigned_user_names,
      GROUP_CONCAT(users.email) AS assigned_user_emails
    FROM jobs
    LEFT JOIN job_assignments ON job_assignments.job_id = jobs.id
    LEFT JOIN users ON users.id = job_assignments.user_id
    WHERE ${whereClause}
    GROUP BY jobs.id
    ORDER BY COALESCE(jobs.scheduled_start, jobs.created_at) ASC
  `;
}

function normalizeJobs(rows) {
  return rows.map((job) => ({
    ...job,
    assigned_user_ids: splitCsv(job.assigned_user_ids),
    assigned_user_names: splitCsv(job.assigned_user_names),
    assigned_user_emails: splitCsv(job.assigned_user_emails),
  }));
}

async function saveJob(request, env, id = crypto.randomUUID()) {
  const body = await readJson(request);
  const title = stringField(body.title, "title");
  const location = nullableString(body.location);
  const scheduledStart = nullableString(body.scheduled_start);
  const scheduledEnd = nullableString(body.scheduled_end);
  const publicNotes = nullableString(body.public_notes);
  const internalNotes = nullableString(body.internal_notes);
  const status = enumField(body.status ?? "scheduled", "status", ["draft", "scheduled", "complete", "cancelled"]);
  const assignedUserIds = Array.isArray(body.assigned_user_ids) ? body.assigned_user_ids.filter(Boolean) : [];
  const existing = await env.SCHEDULER_DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(id).first();

  if (existing) {
    await env.SCHEDULER_DB.prepare(`
      UPDATE jobs
      SET title = ?, location = ?, scheduled_start = ?, scheduled_end = ?, status = ?, public_notes = ?, internal_notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(title, location, scheduledStart, scheduledEnd, status, publicNotes, internalNotes, id).run();
    await env.SCHEDULER_DB.prepare("DELETE FROM job_assignments WHERE job_id = ?").bind(id).run();
  } else {
    await env.SCHEDULER_DB.prepare(`
      INSERT INTO jobs (id, title, location, scheduled_start, scheduled_end, status, public_notes, internal_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, title, location, scheduledStart, scheduledEnd, status, publicNotes, internalNotes).run();
  }

  for (const userId of assignedUserIds) {
    await env.SCHEDULER_DB.prepare("INSERT OR IGNORE INTO job_assignments (job_id, user_id) VALUES (?, ?)").bind(id, userId).run();
  }

  await notifyAssignedWorkers(env, id, existing ? "updated" : "created");
  const saved = await env.SCHEDULER_DB.prepare(jobSelectSql("jobs.id = ?")).bind(id).all();
  return json(request, env, { job: normalizeJobs(saved.results ?? [])[0] }, { status: existing ? 200 : 201 });
}

async function listUsers(request, env, user) {
  const statement = user.role === "supervisor"
    ? env.SCHEDULER_DB.prepare(`
        SELECT id, email, name, role, active, created_at, last_login_at
        FROM users
        ORDER BY active DESC, name COLLATE NOCASE, email COLLATE NOCASE
      `)
    : env.SCHEDULER_DB.prepare(`
        SELECT id, email, name, role, active, created_at, last_login_at
        FROM users
        WHERE id = ?
        ORDER BY active DESC, name COLLATE NOCASE, email COLLATE NOCASE
      `).bind(user.id);
  const rows = await statement.all();
  return json(request, env, { users: rows.results ?? [] });
}

async function createUser(request, env) {
  const body = await readJson(request);
  const email = stringField(body.email, "email").toLowerCase();
  const name = nullableString(body.name);
  const role = enumField(body.role ?? "employee", "role", ["employee", "supervisor"]);
  const active = body.active === false || body.active === 0 ? 0 : 1;
  const id = crypto.randomUUID();
  await env.SCHEDULER_DB.prepare("INSERT INTO users (id, email, name, role, active) VALUES (?, ?, ?, ?, ?)").bind(id, email, name, role, active).run();
  const user = await env.SCHEDULER_DB.prepare("SELECT id, email, name, role, active, created_at, last_login_at FROM users WHERE id = ?").bind(id).first();
  return json(request, env, { user }, { status: 201 });
}

async function listConsultations(request, env) {
  if (!env.CONSULT_DB) return json(request, env, { consultations: [] });
  const rows = await env.CONSULT_DB.prepare(`
    SELECT id, created_at, name, email, phone, service_type, preferred_date, preferred_time, address, message, status, source
    FROM schedule_requests
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
  return json(request, env, { consultations: rows.results ?? [] });
}

async function listFeeds(request, env, user) {
  const statement = user.role === "supervisor"
    ? env.SCHEDULER_DB.prepare(`
        SELECT calendar_feeds.id, calendar_feeds.feed_type, calendar_feeds.user_id, calendar_feeds.token, calendar_feeds.active,
          calendar_feeds.created_at, calendar_feeds.last_accessed_at, users.name AS user_name, users.email AS user_email
        FROM calendar_feeds
        LEFT JOIN users ON users.id = calendar_feeds.user_id
        ORDER BY calendar_feeds.feed_type, users.name, users.email
      `)
    : env.SCHEDULER_DB.prepare(`
        SELECT calendar_feeds.id, calendar_feeds.feed_type, calendar_feeds.user_id, calendar_feeds.token, calendar_feeds.active,
          calendar_feeds.created_at, calendar_feeds.last_accessed_at, users.name AS user_name, users.email AS user_email
        FROM calendar_feeds
        LEFT JOIN users ON users.id = calendar_feeds.user_id
        WHERE calendar_feeds.feed_type = 'worker' AND calendar_feeds.user_id = ?
      `).bind(user.id);
  const rows = await statement.all();
  return json(request, env, { feeds: rows.results ?? [] });
}

async function createFeed(request, env) {
  const body = await readJson(request);
  const feedType = enumField(body.feed_type, "feed_type", ["supervisor_all", "worker"]);
  const userId = feedType === "worker" ? stringField(body.user_id, "user_id") : null;
  const token = randomState();
  const id = crypto.randomUUID();
  await env.SCHEDULER_DB.prepare("INSERT INTO calendar_feeds (id, feed_type, user_id, token) VALUES (?, ?, ?, ?)").bind(id, feedType, userId, token).run();
  const feed = await env.SCHEDULER_DB.prepare("SELECT id, feed_type, user_id, token, active, created_at, last_accessed_at FROM calendar_feeds WHERE id = ?").bind(id).first();
  return json(request, env, { feed }, { status: 201 });
}

async function renderIcsFeed(env, token) {
  const feed = await env.SCHEDULER_DB.prepare("SELECT id, feed_type, user_id, active FROM calendar_feeds WHERE token = ?").bind(token).first();
  if (!feed || feed.active !== 1) return new Response("Feed not found", { status: 404 });

  const jobs = normalizeJobs((await (feed.feed_type === "supervisor_all"
    ? env.SCHEDULER_DB.prepare(jobSelectSql("jobs.status != 'cancelled'")).all()
    : env.SCHEDULER_DB.prepare(jobSelectSql("jobs.status != 'cancelled' AND EXISTS (SELECT 1 FROM job_assignments worker_filter WHERE worker_filter.job_id = jobs.id AND worker_filter.user_id = ?)")).bind(feed.user_id).all()
  )).results ?? []);

  const consultations = feed.feed_type === "supervisor_all" && env.CONSULT_DB
    ? (await env.CONSULT_DB.prepare("SELECT id, name, preferred_date, preferred_time, address, service_type, message FROM schedule_requests WHERE status != 'cancelled' ORDER BY preferred_date ASC LIMIT 200").all()).results ?? []
    : [];

  await env.SCHEDULER_DB.prepare("UPDATE calendar_feeds SET last_accessed_at = datetime('now') WHERE id = ?").bind(feed.id).run();
  return new Response(buildIcs(jobs, consultations), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="luc-contracting.ics"',
      "Cache-Control": "no-store",
    },
  });
}

function buildIcs(jobs, consultations) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Luc Contracting//Scheduler//EN", "CALSCALE:GREGORIAN"];
  for (const job of jobs) {
    const startsAt = toValidDate(job.scheduled_start);
    if (!startsAt) continue;
    const endsAt = toValidDate(job.scheduled_end);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcs(job.id)}@luc-contracting`);
    lines.push(`DTSTAMP:${formatIcsDate(new Date())}`);
    lines.push(`DTSTART:${formatIcsDate(startsAt)}`);
    if (endsAt) lines.push(`DTEND:${formatIcsDate(endsAt)}`);
    lines.push(`SUMMARY:${escapeIcs(job.title)}`);
    if (job.location) lines.push(`LOCATION:${escapeIcs(job.location)}`);
    lines.push(`DESCRIPTION:${escapeIcs([job.public_notes, job.assigned_user_names.join(", ")].filter(Boolean).join("\\n"))}`);
    lines.push("END:VEVENT");
  }
  for (const consult of consultations) {
    const startsAt = toValidDate(`${consult.preferred_date || ""}T${consult.preferred_time || "09:00"}`) || toValidDate(consult.preferred_date);
    if (!startsAt) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:consult-${consult.id}@luc-contracting`);
    lines.push(`DTSTAMP:${formatIcsDate(new Date())}`);
    lines.push(`DTSTART:${formatIcsDate(startsAt)}`);
    lines.push(`SUMMARY:${escapeIcs(`Consultation: ${consult.name}`)}`);
    if (consult.address) lines.push(`LOCATION:${escapeIcs(consult.address)}`);
    lines.push(`DESCRIPTION:${escapeIcs([consult.service_type, consult.message].filter(Boolean).join("\\n"))}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

async function notifyAssignedWorkers(env, jobId, action) {
  const jobRows = await env.SCHEDULER_DB.prepare(jobSelectSql("jobs.id = ?")).bind(jobId).all();
  const job = normalizeJobs(jobRows.results ?? [])[0];
  if (!job) return;

  const rows = await env.SCHEDULER_DB.prepare(`
    SELECT users.id AS user_id, users.email, users.name
    FROM job_assignments
    JOIN users ON users.id = job_assignments.user_id
    WHERE job_assignments.job_id = ? AND users.active = 1
  `).bind(jobId).all();

  const recipients = rows.results ?? [];

  if (!env.RESEND_API_KEY) {
    for (const row of recipients) {
      await logNotification(env, jobId, row.user_id, row.email, "skipped", "RESEND_API_KEY is not configured");
    }
    return;
  }

  const from = getResendFrom(env);
  const subject = `Job ${action}: ${job.title}`;
  const text = buildJobEmailText(env, job, action);

  for (const row of recipients) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [row.email],
          subject,
          text,
        }),
      });
      const error = response.ok ? null : await response.text();
      if (error) console.warn(`Resend failed for ${row.email}: ${error}`);
      await logNotification(env, jobId, row.user_id, row.email, response.ok ? "sent" : "failed", error);
    } catch (error) {
      await logNotification(env, jobId, row.user_id, row.email, "failed", error instanceof Error ? error.message : "Unknown error");
    }
  }
}

function getResendFrom(env) {
  return typeof env.RESEND_FROM === "string" && env.RESEND_FROM.trim() ? env.RESEND_FROM.trim() : DEFAULT_RESEND_FROM;
}

function buildJobEmailText(env, job, action) {
  return [
    `Job ${action}: ${job.title}`,
    "",
    `Status: ${job.status || "scheduled"}`,
    job.scheduled_start && `Starts: ${formatEmailDate(job.scheduled_start)}`,
    job.scheduled_end && `Ends: ${formatEmailDate(job.scheduled_end)}`,
    job.location && `Location: ${job.location}`,
    (job.assigned_user_names || []).length && `Assigned workers: ${job.assigned_user_names.join(", ")}`,
    job.public_notes && ["", "Notes:", job.public_notes].join("\n"),
    "",
    `${getFrontendOrigin(env)}/jobs`,
  ].filter(Boolean).join("\n");
}

function formatEmailDate(value) {
  const [datePart = "", timePart = ""] = String(value || "").split("T");
  if (!datePart) return "";

  const [year, month, day] = datePart.split("-").map(Number);
  const [hour = 0, minute = 0] = timePart.split(":").map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1, hour || 0, minute || 0);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getFrontendOrigin(env) {
  return env.FRONTEND_ORIGIN || DEFAULT_FRONTEND_ORIGIN;
}

async function logNotification(env, jobId, userId, email, status, error) {
  await env.SCHEDULER_DB.prepare("INSERT INTO notification_log (id, job_id, user_id, email, status, error) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), jobId, userId, email, status, error).run();
}

async function requireUser(request, env) {
  const token = getBearerToken(request) || getCookie(request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "Not authenticated");
  const payload = await verifySession(env, token);
  if (!payload?.sub) throw new HttpError(401, "Invalid session");
  const user = await env.SCHEDULER_DB.prepare("SELECT id, email, name, role, active FROM users WHERE id = ? LIMIT 1").bind(payload.sub).first();
  if (!user || user.active !== 1) throw new HttpError(401, "Not authenticated");
  return user;
}

function requireSupervisor(user) {
  if (user.role !== "supervisor") throw new HttpError(403, "Supervisor access required");
}

async function findActiveUserByEmail(env, email) {
  if (!email) return null;
  const user = await env.SCHEDULER_DB.prepare("SELECT id, email, name, role, active FROM users WHERE lower(email) = lower(?) LIMIT 1").bind(email).first();
  return user?.active === 1 ? user : null;
}

async function createSession(env, user) {
  const payload = { sub: user.id, email: user.email, role: user.role, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(env.SESSION_SECRET, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

async function verifySession(env, token) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  const expectedSignature = await sign(env.SESSION_SECRET, encodedPayload);
  if (!constantTimeEqual(signature, expectedSignature)) return null;
  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function stringField(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `Missing ${field}`);
  return value.trim();
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function enumField(value, field, allowed) {
  const clean = stringField(value, field);
  if (!allowed.includes(clean)) throw new HttpError(400, `Invalid ${field}`);
  return clean;
}

function splitCsv(value) {
  return typeof value === "string" && value ? value.split(",").filter(Boolean) : [];
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = new Set([DEFAULT_FRONTEND_ORIGIN, env.FRONTEND_ORIGIN, env.APP_ORIGIN].filter(Boolean));
  const headers = new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
    "Vary": "Origin",
  });
  if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(request, env, body, options = {}) {
  const headers = corsHeaders(request, env);
  new Headers(options.headers).forEach((value, key) => headers.append(key, value));
  headers.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(body, { status: options.status ?? 200, headers });
}

function errorResponse(request, env, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  if (!(error instanceof HttpError)) console.error(error);

  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify({ error: message }), {
    status,
    headers,
  });
}

function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  return cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : null;
}

function getSafeReturnTo(value, env) {
  const fallback = `${DEFAULT_FRONTEND_ORIGIN}/dashboard`;
  if (!value) return fallback;
  try {
    const returnUrl = new URL(value);
    const allowedOrigins = new Set([DEFAULT_FRONTEND_ORIGIN, env.FRONTEND_ORIGIN].filter(Boolean));
    return allowedOrigins.has(returnUrl.origin) ? returnUrl.toString() : fallback;
  } catch {
    return fallback;
  }
}

function shouldPassSessionInRedirect(url, env) {
  const allowedOrigins = new Set([DEFAULT_FRONTEND_ORIGIN, env.FRONTEND_ORIGIN].filter(Boolean));
  return allowedOrigins.has(url.origin);
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${value}`, "HttpOnly", "Secure", `SameSite=${options.sameSite || "Lax"}`, `Path=${options.path || "/"}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function clearCookie(name, path = "/") {
  return cookie(name, "", { path, maxAge: 0, sameSite: "None" });
}

function clearOauthCookiePairs() {
  return [
    ["Set-Cookie", cookie("oauth_state", "", { path: "/auth/google/callback", maxAge: 0, sameSite: "Lax" })],
    ["Set-Cookie", cookie("oauth_return_to", "", { path: "/auth/google/callback", maxAge: 0, sameSite: "Lax" })],
  ];
}

function clearOauthCookies() {
  return new Headers(clearOauthCookiePairs());
}

function html(body, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html>${body}`, { status, headers });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function escapeIcs(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function formatIcsDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function toValidDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
