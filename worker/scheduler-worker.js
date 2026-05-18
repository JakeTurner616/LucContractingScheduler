const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const DEFAULT_FRONTEND_ORIGIN = "http://localhost:4325";
const DEFAULT_PRODUCTION_FRONTEND_ORIGINS = [
  "https://scheduler.serverboi.org",
  "https://www.scheduler.serverboi.org",
  "https://serverboi.org",
  "https://www.serverboi.org",
];
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

      if (url.pathname === "/" || url.pathname === "/login") return workerLoginPage(request, env);
      if (url.pathname === "/auth/dev/session" && request.method === "POST") return createDevSessionResponse(request, env);
      if (url.pathname === "/auth/dev/start") return startDevAuthRequest(request, env, url);
      if (url.pathname === "/auth/google/start") return startGoogleAuth(env, url);
      if (url.pathname === "/auth/google/callback") return finishGoogleAuth(request, env, url);
      if (url.pathname === "/auth/logout" && request.method === "POST") return json(request, env, { ok: true }, { headers: [["Set-Cookie", clearCookie(SESSION_COOKIE, "/", env)]] });
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

      const completionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/completion$/);
      if (completionMatch) {
        const user = await requireUser(request, env);
        if (request.method === "GET") return getCompletionDocument(request, env, user, completionMatch[1]);
        if (request.method === "POST" || request.method === "PUT") {
          requireSupervisor(user);
          return saveCompletionDocument(request, env, user, completionMatch[1]);
        }
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (url.pathname === "/api/jobs" || jobMatch) {
        const user = await requireUser(request, env);
        if (request.method === "GET" && !jobMatch) return listJobs(request, env, user);
        if (request.method === "POST" && !jobMatch) {
          requireSupervisor(user);
          return saveJob(request, env, user);
        }
        if (request.method === "PUT" && jobMatch) {
          requireSupervisor(user);
          return saveJob(request, env, user, jobMatch[1]);
        }
      }

      const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
      if (url.pathname === "/api/users" || userMatch) {
        const user = await requireUser(request, env);
        if (request.method === "GET" && !userMatch) return listUsers(request, env, user);
        if (request.method === "POST" && !userMatch) {
          requireSupervisor(user);
          return createUser(request, env);
        }
        if (request.method === "PUT" && userMatch) {
          requireSupervisor(user);
          return updateUser(request, env, user, userMatch[1]);
        }
        if (request.method === "DELETE" && userMatch) {
          requireSupervisor(user);
          return deleteUser(request, env, user, userMatch[1]);
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

      if (url.pathname === "/api/admin/database/stats" && request.method === "GET") {
        requireSupervisor(await requireUser(request, env));
        return databaseStats(request, env);
      }

      if (url.pathname === "/api/admin/database/export" && request.method === "GET") {
        requireSupervisor(await requireUser(request, env));
        return exportDatabaseRows(request, env, url);
      }

      if (url.pathname === "/api/admin/database/purge" && request.method === "POST") {
        requireSupervisor(await requireUser(request, env));
        return purgeDatabaseRows(request, env);
      }

      return json(request, env, { error: "Not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(request, env, error);
    }
  },
};

function workerLoginPage(request, env) {
  const useDevAuth = isDevAuthAllowed(request, env);
  const authHref = useDevAuth ? "/auth/dev/start" : "/auth/google/start";
  const authLabel = useDevAuth ? "Continue as local dev user" : "Sign in with Google";

  return html(`
    <main style="font-family:system-ui;padding:40px;max-width:640px;margin:auto">
      <h1>Luc Contracting Scheduler</h1>
      <p>Internal scheduling dashboard.</p>
      <a href="${authHref}"><button style="font:inherit;padding:12px 18px;cursor:pointer">${escapeHtml(authLabel)}</button></a>
    </main>
  `);
}

async function startDevAuthRequest(request, env, url) {
  if (!isDevAuthAllowed(request, env)) throw new HttpError(404, "Not found");
  return startDevAuth(env, url);
}

async function startDevAuth(env, url) {
  const { session } = await createDevSession(env);
  const redirectUrl = new URL(getSafeReturnTo(url.searchParams.get("return_to"), env));
  if (shouldPassSessionInRedirect(redirectUrl, env)) redirectUrl.searchParams.set("session", session);

  return new Response(null, {
    status: 302,
    headers: [
      ["Location", redirectUrl.toString()],
      ["Set-Cookie", devSessionCookie(SESSION_COOKIE, session, { path: "/", maxAge: SESSION_MAX_AGE }, env)],
      ...clearOauthCookiePairs(),
    ],
  });
}

async function createDevSessionResponse(request, env) {
  if (!isDevAuthAllowed(request, env)) throw new HttpError(404, "Not found");
  const { session, user } = await createDevSession(env);
  return json(request, env, { session, user }, {
    headers: [["Set-Cookie", devSessionCookie(SESSION_COOKIE, session, { path: "/", maxAge: SESSION_MAX_AGE }, env)]],
  });
}

async function createDevSession(env) {
  requireBinding(env.SCHEDULER_DB, "SCHEDULER_DB");

  const user = await ensureDevUser(env);
  await env.SCHEDULER_DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();

  return { session: await createSession(env, user), user };
}

async function ensureDevUser(env) {
  const id = env.DEV_AUTH_USER_ID || "local-dev-supervisor";
  const email = env.DEV_AUTH_EMAIL || "dev@localhost";
  const name = env.DEV_AUTH_NAME || "Local Dev";
  const role = env.DEV_AUTH_ROLE === "employee" ? "employee" : "supervisor";
  const existing = await env.SCHEDULER_DB.prepare("SELECT id FROM users WHERE id = ? OR lower(email) = lower(?) LIMIT 1").bind(id, email).first();

  if (existing?.id) {
    await env.SCHEDULER_DB.prepare("UPDATE users SET email = ?, name = ?, role = ?, active = 1 WHERE id = ?").bind(email, name, role, existing.id).run();
    return env.SCHEDULER_DB.prepare("SELECT id, email, name, role, active FROM users WHERE id = ? LIMIT 1").bind(existing.id).first();
  }

  await env.SCHEDULER_DB.prepare("INSERT INTO users (id, email, name, role, active) VALUES (?, ?, ?, ?, 1)").bind(id, email, name, role).run();
  return env.SCHEDULER_DB.prepare("SELECT id, email, name, role, active FROM users WHERE id = ? LIMIT 1").bind(id).first();
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
      jobs.customer_name, jobs.customer_email, jobs.public_notes, jobs.internal_notes, jobs.created_at, jobs.updated_at,
      completion.id AS completion_document_id, completion.signed_at AS completion_signed_at,
      completion.customer_name AS completion_customer_name,
      GROUP_CONCAT(users.id) AS assigned_user_ids,
      GROUP_CONCAT(COALESCE(users.name, users.email)) AS assigned_user_names,
      GROUP_CONCAT(users.email) AS assigned_user_emails
    FROM jobs
    LEFT JOIN job_assignments ON job_assignments.job_id = jobs.id
    LEFT JOIN users ON users.id = job_assignments.user_id
    LEFT JOIN job_completion_documents completion ON completion.job_id = jobs.id
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

async function saveJob(request, env, user, id = crypto.randomUUID()) {
  const body = await readJson(request);
  const title = stringField(body.title, "title");
  const customerName = nullableString(body.customer_name);
  const customerEmail = nullableString(body.customer_email);
  const location = nullableString(body.location);
  const scheduledStart = nullableString(body.scheduled_start) || dateTimeFromParts(body.job_date, body.start_hour, body.start_minute, body.start_period);
  const scheduledEnd = nullableString(body.scheduled_end)
    || dateTimeFromParts(body.end_date || body.job_date, body.end_hour, body.end_minute, body.end_period);
  const publicNotes = nullableString(body.public_notes);
  const internalNotes = nullableString(body.internal_notes);
  const status = enumField(body.status ?? "scheduled", "status", ["draft", "scheduled", "complete", "cancelled"]);
  const assignedUserIds = Array.isArray(body.assigned_user_ids) ? body.assigned_user_ids.filter(Boolean) : [];
  const existing = await env.SCHEDULER_DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(id).first();

  if (status === "complete") {
    const completion = await findCompletionDocument(env, id);
    if (!completion?.signed_at) {
      throw new HttpError(400, "A signed work completion document is required before this job can be marked complete.");
    }
  }

  if (existing) {
    await env.SCHEDULER_DB.prepare(`
      UPDATE jobs
      SET title = ?, customer_name = ?, customer_email = ?, location = ?, scheduled_start = ?, scheduled_end = ?, status = ?, public_notes = ?, internal_notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(title, customerName, customerEmail, location, scheduledStart, scheduledEnd, status, publicNotes, internalNotes, id).run();
    await env.SCHEDULER_DB.prepare("DELETE FROM job_assignments WHERE job_id = ?").bind(id).run();
  } else {
    await env.SCHEDULER_DB.prepare(`
      INSERT INTO jobs (id, title, customer_name, customer_email, location, scheduled_start, scheduled_end, status, public_notes, internal_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, title, customerName, customerEmail, location, scheduledStart, scheduledEnd, status, publicNotes, internalNotes).run();
  }

  for (const userId of assignedUserIds) {
    await env.SCHEDULER_DB.prepare("INSERT OR IGNORE INTO job_assignments (job_id, user_id) VALUES (?, ?)").bind(id, userId).run();
  }

  await notifyAssignedWorkers(env, id, existing ? "updated" : "created");
  const saved = await env.SCHEDULER_DB.prepare(jobSelectSql("jobs.id = ?")).bind(id).all();
  return json(request, env, { job: normalizeJobs(saved.results ?? [])[0] }, { status: existing ? 200 : 201 });
}

async function getCompletionDocument(request, env, user, jobId) {
  const job = await getAuthorizedJob(env, user, jobId);
  const completion = await findCompletionDocument(env, jobId);
  return json(request, env, { job, completion });
}

async function saveCompletionDocument(request, env, user, jobId) {
  const job = await getAuthorizedJob(env, user, jobId);
  const body = await readJson(request);
  const customerName = stringField(body.customer_name, "customer_name");
  const signatureName = nullableString(body.signature_name) || customerName;
  const signatureDataUrl = stringField(body.signature_data_url, "signature_data_url");
  if (!isValidDocumentImageDataUrl(signatureDataUrl) || signatureDataUrl.length < 300) {
    throw new HttpError(400, "Customer signature is required before completing the job.");
  }

  const customerEmail = nullableString(body.customer_email);
  const workPerformed = nullableString(body.work_performed) || job.public_notes || "Work completed as scheduled.";
  const materialsUsed = nullableString(body.materials_used);
  const customerNotes = nullableString(body.customer_notes);
  const workImageDataUrl = nullableString(body.work_image_data_url);
  if (workImageDataUrl && !isValidDocumentImageDataUrl(workImageDataUrl)) {
    throw new HttpError(400, "Work image must be a small PNG, JPEG, or WebP image.");
  }
  const existing = await findCompletionDocument(env, jobId);
  const documentId = existing?.id || crypto.randomUUID();

  if (existing) {
    await env.SCHEDULER_DB.prepare(`
      UPDATE job_completion_documents
      SET customer_name = ?, customer_email = ?, work_performed = ?, materials_used = ?, customer_notes = ?, work_image_data_url = ?,
        signature_name = ?, signature_data_url = ?, signed_at = datetime('now'), completed_at = datetime('now'),
        created_by_user_id = ?, updated_at = datetime('now')
      WHERE job_id = ?
    `).bind(customerName, customerEmail, workPerformed, materialsUsed, customerNotes, workImageDataUrl, signatureName, signatureDataUrl, user.id, jobId).run();
  } else {
    await env.SCHEDULER_DB.prepare(`
      INSERT INTO job_completion_documents
        (id, job_id, customer_name, customer_email, work_performed, materials_used, customer_notes, work_image_data_url, signature_name, signature_data_url, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(documentId, jobId, customerName, customerEmail, workPerformed, materialsUsed, customerNotes, workImageDataUrl, signatureName, signatureDataUrl, user.id).run();
  }

  await env.SCHEDULER_DB.prepare("UPDATE jobs SET status = 'complete', updated_at = datetime('now') WHERE id = ?").bind(jobId).run();

  const saved = await env.SCHEDULER_DB.prepare(jobSelectSql("jobs.id = ?")).bind(jobId).all();
  return json(request, env, {
    job: normalizeJobs(saved.results ?? [])[0],
    completion: await findCompletionDocument(env, jobId),
  }, { status: existing ? 200 : 201 });
}

async function getAuthorizedJob(env, user, jobId) {
  const rows = await (user.role === "supervisor"
    ? env.SCHEDULER_DB.prepare(jobSelectSql("jobs.id = ?")).bind(jobId).all()
    : env.SCHEDULER_DB.prepare(jobSelectSql("jobs.id = ? AND EXISTS (SELECT 1 FROM job_assignments worker_filter WHERE worker_filter.job_id = jobs.id AND worker_filter.user_id = ?)")).bind(jobId, user.id).all());
  const job = normalizeJobs(rows.results ?? [])[0];
  if (!job) throw new HttpError(404, "Job not found");
  return job;
}

async function findCompletionDocument(env, jobId) {
  return env.SCHEDULER_DB.prepare(`
    SELECT id, job_id, customer_name, customer_email, work_performed, materials_used, customer_notes, work_image_data_url,
      signature_name, signature_data_url, signed_at, completed_at, created_by_user_id, created_at, updated_at
    FROM job_completion_documents
    WHERE job_id = ?
    LIMIT 1
  `).bind(jobId).first();
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
  const active = body.active === false || body.active === 0 || body.active === "0" ? 0 : 1;
  const id = crypto.randomUUID();
  await env.SCHEDULER_DB.prepare("INSERT INTO users (id, email, name, role, active) VALUES (?, ?, ?, ?, ?)").bind(id, email, name, role, active).run();
  const user = await env.SCHEDULER_DB.prepare("SELECT id, email, name, role, active, created_at, last_login_at FROM users WHERE id = ?").bind(id).first();
  return json(request, env, { user }, { status: 201 });
}

async function updateUser(request, env, currentUser, id) {
  const existing = await env.SCHEDULER_DB.prepare("SELECT id, role, active FROM users WHERE id = ? LIMIT 1").bind(id).first();
  if (!existing) throw new HttpError(404, "Worker not found");

  const body = await readJson(request);
  const email = stringField(body.email, "email").toLowerCase();
  const name = nullableString(body.name);
  const role = enumField(body.role ?? "employee", "role", ["employee", "supervisor"]);
  const active = body.active === false || body.active === 0 || body.active === "0" ? 0 : 1;
  if (currentUser.id === id && (role !== "supervisor" || active !== 1)) {
    throw new HttpError(400, "You cannot remove your own active supervisor access.");
  }
  if (existing.role === "supervisor" && existing.active === 1 && (role !== "supervisor" || active !== 1)) {
    await requireAnotherActiveSupervisor(env, id);
  }

  await env.SCHEDULER_DB.prepare(`
    UPDATE users
    SET email = ?, name = ?, role = ?, active = ?
    WHERE id = ?
  `).bind(email, name, role, active, id).run();

  const user = await env.SCHEDULER_DB.prepare("SELECT id, email, name, role, active, created_at, last_login_at FROM users WHERE id = ?").bind(id).first();
  return json(request, env, { user });
}

async function deleteUser(request, env, currentUser, id) {
  if (currentUser.id === id) throw new HttpError(400, "You cannot delete your own supervisor account.");

  const existing = await env.SCHEDULER_DB.prepare("SELECT id, role, active FROM users WHERE id = ? LIMIT 1").bind(id).first();
  if (!existing) throw new HttpError(404, "Worker not found");
  if (existing.role === "supervisor" && existing.active === 1) {
    await requireAnotherActiveSupervisor(env, id);
  }

  await env.SCHEDULER_DB.prepare("DELETE FROM calendar_feeds WHERE user_id = ?").bind(id).run();
  await env.SCHEDULER_DB.prepare("DELETE FROM job_assignments WHERE user_id = ?").bind(id).run();
  await env.SCHEDULER_DB.prepare("UPDATE notification_log SET user_id = NULL WHERE user_id = ?").bind(id).run();
  await env.SCHEDULER_DB.prepare("UPDATE job_completion_documents SET created_by_user_id = NULL WHERE created_by_user_id = ?").bind(id).run();
  await env.SCHEDULER_DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();

  return json(request, env, { ok: true });
}

async function requireAnotherActiveSupervisor(env, id) {
  const row = await env.SCHEDULER_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE role = 'supervisor' AND active = 1 AND id != ?
  `).bind(id).first();
  if (Number(row?.count || 0) < 1) {
    throw new HttpError(400, "At least one active supervisor account must remain.");
  }
}

async function listConsultations(request, env) {
  if (!env.CONSULT_DB) return json(request, env, { consultations: [] });

  try {
    const rows = await env.CONSULT_DB.prepare(`
      SELECT id, created_at, name, email, phone, service_type, preferred_date, preferred_time, address, message, status, source
      FROM schedule_requests
      ORDER BY created_at DESC
      LIMIT 100
    `).all();
    return json(request, env, { consultations: rows.results ?? [] });
  } catch (error) {
    if (isMissingD1TableError(error)) return json(request, env, { consultations: [] });
    throw error;
  }
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

async function databaseStats(request, env) {
  const databases = [
    await collectDatabaseStats(env.SCHEDULER_DB, "SCHEDULER_DB", [
      { name: "users", dateColumn: "created_at" },
      { name: "jobs", dateColumn: "COALESCE(scheduled_start, created_at)" },
      { name: "job_assignments", dateColumn: "created_at" },
      { name: "job_completion_documents", dateColumn: "COALESCE(completed_at, signed_at, created_at)" },
      { name: "calendar_feeds", dateColumn: "created_at" },
      { name: "notification_log", dateColumn: "created_at" },
    ]),
  ];

  if (env.CONSULT_DB) {
    databases.push(await collectDatabaseStats(env.CONSULT_DB, "CONSULT_DB", [
      { name: "schedule_requests", dateColumn: "COALESCE(preferred_date, created_at)" },
    ]));
  }

  const tables = databases.flatMap((database) => database.tables);
  return json(request, env, {
    databases,
    totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
    totalBytes: tables.reduce((sum, table) => sum + table.bytes, 0),
    oldest: tables.map((table) => table.oldest).filter(Boolean).sort()[0] || null,
    generatedAt: new Date().toISOString(),
  });
}

async function collectDatabaseStats(db, name, tableConfigs) {
  requireBinding(db, name);
  const tables = [];

  for (const config of tableConfigs) {
    try {
      const countRow = await db.prepare(`SELECT COUNT(*) AS rows FROM ${config.name}`).first();
      const dateRow = await db.prepare(`
        SELECT MIN(${config.dateColumn}) AS oldest, MAX(${config.dateColumn}) AS newest
        FROM ${config.name}
      `).first();
      const sample = (await db.prepare(`SELECT * FROM ${config.name} LIMIT 250`).all()).results ?? [];
      const rowCount = Number(countRow?.rows || 0);
      const averageBytes = sample.length ? byteLength(JSON.stringify(sample)) / sample.length : 0;

      tables.push({
        name: config.name,
        rows: rowCount,
        bytes: Math.round(rowCount * averageBytes),
        oldest: dateRow?.oldest || null,
        newest: dateRow?.newest || null,
      });
    } catch (error) {
      if (!isMissingD1TableError(error)) throw error;
    }
  }

  return {
    name,
    tables,
    rows: tables.reduce((sum, table) => sum + table.rows, 0),
    bytes: tables.reduce((sum, table) => sum + table.bytes, 0),
  };
}

async function exportDatabaseRows(request, env, url) {
  const from = optionalDateParam(url.searchParams.get("from"), "from");
  const to = optionalDateParam(url.searchParams.get("to"), "to");
  const format = (url.searchParams.get("format") || "csv").toLowerCase();
  if (!["csv", "sql", "sqlite"].includes(format)) throw new HttpError(400, "Unsupported export format");

  if (format === "sql") return exportDatabaseSqlDump(request, env, from, to);
  if (format === "sqlite") return exportDatabaseSqlite(request, env, from, to);

  const rows = [
    ...await exportSchedulerRows(env, from, to),
    ...await exportConsultRows(env, from, to),
  ];
  const dateStamp = new Date().toISOString().slice(0, 10);
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "text/csv; charset=utf-8");
  headers.set("Content-Disposition", `attachment; filename="luc-contracting-tax-export-${dateStamp}.csv"`);
  headers.set("Cache-Control", "no-store");

  return new Response(rowsToCsv(rows), { headers });
}

async function exportDatabaseSqlDump(request, env, from, to) {
  const dump = await buildSqlDump(env, from, to);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/sql; charset=utf-8");
  headers.set("Content-Disposition", `attachment; filename="luc-contracting-d1-archive-${dateStamp}.sql"`);
  headers.set("Cache-Control", "no-store");

  return new Response(dump, { headers });
}

async function exportDatabaseSqlite(request, env, from, to) {
  const database = await buildSqliteDatabase(await buildArchiveTables(env, from, to));
  const dateStamp = new Date().toISOString().slice(0, 10);
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/vnd.sqlite3");
  headers.set("Content-Disposition", `attachment; filename="luc-contracting-d1-archive-${dateStamp}.sqlite"`);
  headers.set("Cache-Control", "no-store");

  return new Response(database, { headers });
}

async function exportSchedulerRows(env, from, to) {
  const rows = [];
  const jobs = (await dateFilteredAll(env.SCHEDULER_DB, `
    SELECT jobs.*, GROUP_CONCAT(COALESCE(users.name, users.email)) AS assigned_workers
    FROM jobs
    LEFT JOIN job_assignments ON job_assignments.job_id = jobs.id
    LEFT JOIN users ON users.id = job_assignments.user_id
    WHERE date(COALESCE(jobs.scheduled_start, jobs.created_at)) BETWEEN date(?) AND date(?)
    GROUP BY jobs.id
    ORDER BY COALESCE(jobs.scheduled_start, jobs.created_at) ASC
  `, from, to)).results ?? [];

  for (const job of jobs) {
    rows.push({
      database: "SCHEDULER_DB",
      table: "jobs",
      record_type: "job",
      record_id: job.id,
      record_date: dateOnly(job.scheduled_start || job.created_at),
      title: job.title,
      customer_name: job.customer_name,
      customer_email: job.customer_email,
      location: job.location,
      status: job.status,
      workers: job.assigned_workers,
      details: [job.public_notes, job.internal_notes].filter(Boolean).join("\n\n"),
      signature_name: "",
      signed_at: "",
      work_image_attached_at: "",
      created_at: job.created_at,
      updated_at: job.updated_at,
    });
  }

  const completions = (await dateFilteredAll(env.SCHEDULER_DB, `
    SELECT completion.*, jobs.title AS job_title, jobs.location AS job_location
    FROM job_completion_documents completion
    LEFT JOIN jobs ON jobs.id = completion.job_id
    WHERE date(COALESCE(completion.completed_at, completion.signed_at, completion.created_at)) BETWEEN date(?) AND date(?)
    ORDER BY COALESCE(completion.completed_at, completion.signed_at, completion.created_at) ASC
  `, from, to)).results ?? [];

  for (const completion of completions) {
    rows.push({
      database: "SCHEDULER_DB",
      table: "job_completion_documents",
      record_type: "completion",
      record_id: completion.id,
      record_date: dateOnly(completion.completed_at || completion.signed_at || completion.created_at),
      title: completion.job_title,
      customer_name: completion.customer_name,
      customer_email: completion.customer_email,
      location: completion.job_location,
      status: "complete",
      workers: "",
      details: [completion.work_performed, completion.materials_used, completion.customer_notes].filter(Boolean).join("\n\n"),
      signature_name: completion.signature_name,
      signed_at: completion.signature_data_url ? completion.signed_at : "",
      work_image_attached_at: completion.work_image_data_url ? (completion.updated_at || completion.created_at) : "",
      created_at: completion.created_at,
      updated_at: completion.updated_at,
    });
  }

  return rows;
}

async function exportConsultRows(env, from, to) {
  if (!env.CONSULT_DB) return [];

  try {
    const consults = (await dateFilteredAll(env.CONSULT_DB, `
      SELECT *
      FROM schedule_requests
      WHERE date(COALESCE(preferred_date, created_at)) BETWEEN date(?) AND date(?)
      ORDER BY COALESCE(preferred_date, created_at) ASC
    `, from, to)).results ?? [];

    return consults.map((consult) => ({
      database: "CONSULT_DB",
      table: "schedule_requests",
      record_type: "consultation",
      record_id: consult.id,
      record_date: dateOnly(consult.preferred_date || consult.created_at),
      title: consult.service_type,
      customer_name: consult.name,
      customer_email: consult.email,
      location: consult.address,
      status: consult.status,
      workers: "",
      details: consult.message,
      signature_name: "",
      signed_at: "",
      work_image_attached_at: "",
      created_at: consult.created_at,
      updated_at: "",
    }));
  } catch (error) {
    if (isMissingD1TableError(error)) return [];
    throw error;
  }
}

async function purgeDatabaseRows(request, env) {
  const body = await readJson(request);
  const before = requiredDateParam(body.before, "before");
  const preserveFrom = optionalDateParam(body.preserveFrom, "preserveFrom");
  const preserveTo = optionalDateParam(body.preserveTo, "preserveTo");
  const dryRun = body.dryRun !== false;

  if ((preserveFrom && !preserveTo) || (!preserveFrom && preserveTo)) throw new HttpError(400, "Set both preserve window dates, or leave both blank.");
  if (preserveFrom && preserveTo && preserveFrom > preserveTo) throw new HttpError(400, "Preserve window start must be before its end.");

  const jobIds = await purgeableJobIds(env, before, preserveFrom, preserveTo);
  const consultIds = await purgeableConsultIds(env, before, preserveFrom, preserveTo);
  const counts = {
    jobs: jobIds.length,
    job_assignments: await countRowsByJobIds(env.SCHEDULER_DB, "job_assignments", jobIds),
    job_completion_documents: await countRowsByJobIds(env.SCHEDULER_DB, "job_completion_documents", jobIds),
    notification_log: await purgeableNotificationCount(env, before, preserveFrom, preserveTo),
    schedule_requests: consultIds.length,
  };

  if (!dryRun) {
    if (jobIds.length) {
      await env.SCHEDULER_DB.prepare(`DELETE FROM job_completion_documents WHERE job_id IN (${placeholders(jobIds)})`).bind(...jobIds).run();
      await env.SCHEDULER_DB.prepare(`DELETE FROM job_assignments WHERE job_id IN (${placeholders(jobIds)})`).bind(...jobIds).run();
      await env.SCHEDULER_DB.prepare(`DELETE FROM notification_log WHERE job_id IN (${placeholders(jobIds)})`).bind(...jobIds).run();
      await env.SCHEDULER_DB.prepare(`DELETE FROM jobs WHERE id IN (${placeholders(jobIds)})`).bind(...jobIds).run();
    }

    await env.SCHEDULER_DB.prepare(`
      DELETE FROM notification_log
      WHERE date(created_at) < date(?)
        AND (? IS NULL OR date(created_at) NOT BETWEEN date(?) AND date(?))
    `).bind(before, preserveFrom, preserveFrom, preserveTo).run();

    if (consultIds.length && env.CONSULT_DB) {
      await env.CONSULT_DB.prepare(`DELETE FROM schedule_requests WHERE id IN (${placeholders(consultIds)})`).bind(...consultIds).run();
    }
  }

  return json(request, env, {
    dryRun,
    rows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
    before,
    preserveFrom,
    preserveTo,
  });
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

  if (areEmailNotificationsDisabled(env)) return;

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

function areEmailNotificationsDisabled(env) {
  return env.SCHEDULER_AUTH_MODE === "dev";
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

function isDevAuthAllowed(request, env) {
  if (env.SCHEDULER_AUTH_MODE !== "dev") return false;
  const requestUrl = new URL(request.url);
  return isLocalHostname(requestUrl.hostname);
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function requireBinding(binding, name) {
  if (!binding) {
    throw new HttpError(500, `${name} binding is not configured. Start the local Worker with Wrangler D1 bindings before using the scheduler API.`);
  }
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

function dateTimeFromParts(date, hour, minute, period) {
  const cleanDate = nullableString(date);
  const cleanMinute = nullableString(minute);
  const cleanPeriod = nullableString(period);
  if (!cleanDate || !cleanMinute || !cleanPeriod) return null;

  let numericHour = Number(nullableString(hour));
  if (!Number.isInteger(numericHour) || numericHour < 1 || numericHour > 12) return null;
  if (cleanPeriod === "AM" && numericHour === 12) numericHour = 0;
  if (cleanPeriod === "PM" && numericHour !== 12) numericHour += 12;
  if (!["AM", "PM"].includes(cleanPeriod) || !/^\d{2}$/.test(cleanMinute)) return null;

  return `${cleanDate}T${String(numericHour).padStart(2, "0")}:${cleanMinute}`;
}

function isValidDocumentImageDataUrl(value) {
  const image = parseImageDataUrl(value);
  return Boolean(image && image.bytes.length > 24 && image.bytes.length <= 400000 && imageBytesMatchMime(image.mime, image.bytes));
}

function byteLength(value) {
  return new TextEncoder().encode(String(value ?? "")).length;
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function requiredDateParam(value, field) {
  const clean = optionalDateParam(value, field);
  if (!clean) throw new HttpError(400, `Missing ${field}`);
  return clean;
}

function optionalDateParam(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const clean = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new HttpError(400, `Invalid ${field}`);
  return clean;
}

function dateRangeStart(value) {
  return value || "0001-01-01";
}

function dateRangeEnd(value) {
  return value || "9999-12-31";
}

function placeholders(values) {
  return values.map(() => "?").join(",");
}

async function dateFilteredAll(db, sql, from, to) {
  return db.prepare(sql).bind(dateRangeStart(from), dateRangeEnd(to)).all();
}

function rowsToCsv(rows) {
  const columns = [
    "database",
    "table",
    "record_type",
    "record_id",
    "record_date",
    "title",
    "customer_name",
    "customer_email",
    "location",
    "status",
    "workers",
    "details",
    "signature_name",
    "signed_at",
    "work_image_attached_at",
    "created_at",
    "updated_at",
  ];
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(",")),
  ].join("\r\n");
}

async function buildSqlDump(env, from, to) {
  const tables = await buildArchiveTables(env, from, to);
  const insertLines = tables.flatMap((table) => rowsToSqlInserts(table.name, table.rows, table.columns));
  const createLines = tables.flatMap((table) => [
    `DROP TABLE IF EXISTS ${table.name};`,
    `${table.createSql};`,
  ]);
  const lines = [
    "-- Luc Contracting D1 archive",
    `-- Generated: ${new Date().toISOString()}`,
    `-- Date range: ${from || "beginning"} to ${to || "end"}`,
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
    "",
    ...createLines,
    "",
    ...insertLines,
    "COMMIT;",
    "",
  ];

  return lines.join("\n");
}

async function buildArchiveTables(env, from, to) {
  const schedulerJobs = (await dateFilteredAll(env.SCHEDULER_DB, `
    SELECT *
    FROM jobs
    WHERE date(COALESCE(scheduled_start, created_at)) BETWEEN date(?) AND date(?)
    ORDER BY COALESCE(scheduled_start, created_at) ASC
  `, from, to)).results ?? [];
  const jobIds = schedulerJobs.map((job) => job.id).filter(Boolean);
  const schedulerUsers = (await env.SCHEDULER_DB.prepare("SELECT * FROM users ORDER BY name COLLATE NOCASE, email COLLATE NOCASE").all()).results ?? [];
  const schedulerAssignments = jobIds.length
    ? (await env.SCHEDULER_DB.prepare(`SELECT * FROM job_assignments WHERE job_id IN (${placeholders(jobIds)}) ORDER BY created_at ASC`).bind(...jobIds).all()).results ?? []
    : [];
  const schedulerCompletions = (await dateFilteredAll(env.SCHEDULER_DB, `
    SELECT *
    FROM job_completion_documents
    WHERE date(COALESCE(completed_at, signed_at, created_at)) BETWEEN date(?) AND date(?)
    ORDER BY COALESCE(completed_at, signed_at, created_at) ASC
  `, from, to)).results ?? [];
  const schedulerNotifications = (await dateFilteredAll(env.SCHEDULER_DB, `
    SELECT *
    FROM notification_log
    WHERE date(created_at) BETWEEN date(?) AND date(?)
    ORDER BY created_at ASC
  `, from, to)).results ?? [];
  const consultRequests = await sqlDumpConsultRows(env, from, to);

  return archiveTableDefinitions().map((table) => ({
    ...table,
    rows: {
      scheduler_users: schedulerUsers,
      scheduler_jobs: schedulerJobs,
      scheduler_job_assignments: schedulerAssignments,
      scheduler_job_completion_documents: schedulerCompletions,
      scheduler_notification_log: schedulerNotifications,
      consult_schedule_requests: consultRequests,
    }[table.name] ?? [],
  }));
}

async function sqlDumpConsultRows(env, from, to) {
  if (!env.CONSULT_DB) return [];

  try {
    return (await dateFilteredAll(env.CONSULT_DB, `
      SELECT *
      FROM schedule_requests
      WHERE date(COALESCE(preferred_date, created_at)) BETWEEN date(?) AND date(?)
      ORDER BY COALESCE(preferred_date, created_at) ASC
    `, from, to)).results ?? [];
  } catch (error) {
    if (isMissingD1TableError(error)) return [];
    throw error;
  }
}

function archiveTableDefinitions() {
  return [
    tableDefinition("scheduler_users", ["id", "email", "name", "role", "active", "created_at", "last_login_at"], "id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, active INTEGER, created_at TEXT, last_login_at TEXT"),
    tableDefinition("scheduler_jobs", ["id", "title", "customer_name", "customer_email", "location", "scheduled_start", "scheduled_end", "status", "public_notes", "internal_notes", "created_at", "updated_at"], "id TEXT PRIMARY KEY, title TEXT, customer_name TEXT, customer_email TEXT, location TEXT, scheduled_start TEXT, scheduled_end TEXT, status TEXT, public_notes TEXT, internal_notes TEXT, created_at TEXT, updated_at TEXT"),
    tableDefinition("scheduler_job_assignments", ["job_id", "user_id", "created_at"], "job_id TEXT, user_id TEXT, created_at TEXT"),
    tableDefinition("scheduler_job_completion_documents", ["id", "job_id", "customer_name", "customer_email", "work_performed", "materials_used", "customer_notes", "work_image_data_url", "signature_name", "signature_data_url", "signed_at", "completed_at", "created_by_user_id", "created_at", "updated_at"], "id TEXT PRIMARY KEY, job_id TEXT, customer_name TEXT, customer_email TEXT, work_performed TEXT, materials_used TEXT, customer_notes TEXT, work_image_data_url TEXT, signature_name TEXT, signature_data_url TEXT, signed_at TEXT, completed_at TEXT, created_by_user_id TEXT, created_at TEXT, updated_at TEXT"),
    tableDefinition("scheduler_notification_log", ["id", "job_id", "user_id", "email", "status", "error", "created_at"], "id TEXT PRIMARY KEY, job_id TEXT, user_id TEXT, email TEXT, status TEXT, error TEXT, created_at TEXT"),
    tableDefinition("consult_schedule_requests", ["id", "created_at", "name", "email", "phone", "service_type", "preferred_date", "preferred_time", "address", "message", "status", "source"], "id TEXT PRIMARY KEY, created_at TEXT, name TEXT, email TEXT, phone TEXT, service_type TEXT, preferred_date TEXT, preferred_time TEXT, address TEXT, message TEXT, status TEXT, source TEXT"),
  ];
}

function tableDefinition(name, columns, columnSql) {
  return {
    name,
    columns,
    createSql: `CREATE TABLE ${name} (${columnSql})`,
  };
}

function rowsToSqlInserts(table, rows, columns = Object.keys(rows[0] || {})) {
  if (!rows.length) return [`-- ${table}: 0 rows`];

  return rows.map((row) =>
    `INSERT INTO ${table} (${columns.map(sqlIdentifier).join(", ")}) VALUES (${columns.map((column) => sqlValue(row[column])).join(", ")});`
  );
}

function sqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function buildSqliteDatabase(tables) {
  const writer = createSqliteWriter();
  const tableRoots = tables.map((table) => ({
    ...table,
    rootPage: writer.addTable(table.rows, table.columns),
  }));
  const schemaRows = tableRoots.map((table) => ({
    type: "table",
    name: table.name,
    tbl_name: table.name,
    rootpage: table.rootPage,
    sql: table.createSql,
  }));

  writer.setSchema(schemaRows, ["type", "name", "tbl_name", "rootpage", "sql"]);
  return writer.toUint8Array();
}

function createSqliteWriter() {
  const pageSize = 4096;
  const pages = [null];
  let schemaPage = null;

  const appendPage = (page) => {
    pages.push(page);
    return pages.length;
  };

  const appendOverflowPages = (payload) => {
    const chunkSize = pageSize - 4;
    const pageCount = Math.ceil(payload.length / chunkSize);
    const firstPage = pages.length + 1;

    for (let index = 0; index < pageCount; index += 1) {
      const pageNo = pages.length + 1;
      const nextPageNo = index === pageCount - 1 ? 0 : pageNo + 1;
      const page = new Uint8Array(pageSize);
      writeUint32(page, 0, nextPageNo);
      page.set(payload.slice(index * chunkSize, (index + 1) * chunkSize), 4);
      appendPage(page);
    }

    return firstPage;
  };

  const makeTableCell = (rowid, record) => {
    const usableSize = pageSize;
    const maxLocal = usableSize - 35;
    const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    let localPayload = record;
    let overflowPage = 0;

    if (record.length > maxLocal) {
      const preferredLocal = minLocal + ((record.length - minLocal) % (usableSize - 4));
      const localLength = preferredLocal <= maxLocal ? preferredLocal : minLocal;
      localPayload = record.slice(0, localLength);
      overflowPage = appendOverflowPages(record.slice(localLength));
    }

    const prefix = concatBytes(encodeVarint(record.length), encodeVarint(rowid));
    if (!overflowPage) return concatBytes(prefix, localPayload);

    const overflowPointer = new Uint8Array(4);
    writeUint32(overflowPointer, 0, overflowPage);
    return concatBytes(prefix, localPayload, overflowPointer);
  };

  const makeLeafPages = (rows, columns) => {
    const leafPages = [];
    let cells = [];
    let maxRowid = 0;

    rows.forEach((row, index) => {
      const rowid = index + 1;
      const cell = makeTableCell(rowid, encodeSqliteRecord(columns.map((column) => row[column])));
      const nextCellFootprint = cells.reduce((sum, item) => sum + item.cell.length, 0) + cell.length + 8 + ((cells.length + 1) * 2);

      if (cells.length && nextCellFootprint > pageSize) {
        leafPages.push({ pageNo: appendPage(makeBtreePage(0x0d, cells)), maxRowid });
        cells = [];
      }

      cells.push({ cell });
      maxRowid = rowid;
    });

    leafPages.push({ pageNo: appendPage(makeBtreePage(0x0d, cells)), maxRowid });
    return leafPages;
  };

  const addTable = (rows, columns) => {
    const leaves = makeLeafPages(rows, columns);
    if (leaves.length === 1) return leaves[0].pageNo;

    const interiorCells = leaves.slice(0, -1).map((leaf) => ({
      leftChild: leaf.pageNo,
      key: leaf.maxRowid,
    }));
    return appendPage(makeBtreePage(0x05, interiorCells, { rightChild: leaves[leaves.length - 1].pageNo }));
  };

  const setSchema = (rows, columns) => {
    const cells = rows.map((row, index) => ({
      cell: makeTableCell(index + 1, encodeSqliteRecord(columns.map((column) => row[column]))),
    }));
    schemaPage = makeBtreePage(0x0d, cells, { headerOffset: 100 });
    writeSqliteHeader(schemaPage, pageSize, pages.length);
  };

  const toUint8Array = () => {
    if (!schemaPage) throw new Error("SQLite schema page was not initialized.");
    pages[0] = schemaPage;
    const database = new Uint8Array(pages.length * pageSize);
    pages.forEach((page, index) => database.set(page, index * pageSize));
    return database;
  };

  return { addTable, setSchema, toUint8Array };
}

function makeBtreePage(type, entries, options = {}) {
  const pageSize = 4096;
  const headerOffset = options.headerOffset || 0;
  const headerSize = type === 0x05 ? 12 : 8;
  const page = new Uint8Array(pageSize);
  let contentOffset = pageSize;
  const cells = type === 0x05
    ? entries.map((entry) => {
      const key = encodeVarint(entry.key);
      const cell = new Uint8Array(4 + key.length);
      writeUint32(cell, 0, entry.leftChild);
      cell.set(key, 4);
      return cell;
    })
    : entries.map((entry) => entry.cell);

  const pointerStart = headerOffset + headerSize;
  const pointerBytes = cells.length * 2;
  const cellBytes = cells.reduce((sum, cell) => sum + cell.length, 0);
  if (pointerStart + pointerBytes + cellBytes > pageSize) throw new Error("SQLite export page is too large.");

  page[headerOffset] = type;
  writeUint16(page, headerOffset + 1, 0);
  writeUint16(page, headerOffset + 3, cells.length);
  page[headerOffset + 7] = 0;
  if (type === 0x05) writeUint32(page, headerOffset + 8, options.rightChild || 0);

  cells.forEach((cell, index) => {
    contentOffset -= cell.length;
    page.set(cell, contentOffset);
    writeUint16(page, pointerStart + (index * 2), contentOffset);
  });

  writeUint16(page, headerOffset + 5, contentOffset);
  return page;
}

function writeSqliteHeader(page, pageSize, pageCount) {
  page.set(new TextEncoder().encode("SQLite format 3\0"), 0);
  writeUint16(page, 16, pageSize);
  page[18] = 1;
  page[19] = 1;
  page[20] = 0;
  page[21] = 64;
  page[22] = 32;
  page[23] = 32;
  writeUint32(page, 24, 1);
  writeUint32(page, 28, pageCount);
  writeUint32(page, 40, 1);
  writeUint32(page, 44, 4);
  writeUint32(page, 56, 1);
  writeUint32(page, 92, 1);
  writeUint32(page, 96, 3045000);
}

function encodeSqliteRecord(values) {
  const fields = values.map(sqliteField);
  const serialTypes = fields.map((field) => encodeVarint(field.serialType));
  let headerLength = serialTypes.reduce((sum, bytes) => sum + bytes.length, 0) + 1;
  let headerSize = encodeVarint(headerLength);

  while (headerLength !== serialTypes.reduce((sum, bytes) => sum + bytes.length, 0) + headerSize.length) {
    headerLength = serialTypes.reduce((sum, bytes) => sum + bytes.length, 0) + headerSize.length;
    headerSize = encodeVarint(headerLength);
  }

  return concatBytes(headerSize, ...serialTypes, ...fields.map((field) => field.bytes));
}

function sqliteField(value) {
  if (value === null || value === undefined) return { serialType: 0, bytes: new Uint8Array() };
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return sqliteIntegerField(value);
  }

  const bytes = new TextEncoder().encode(String(value));
  return { serialType: 13 + (bytes.length * 2), bytes };
}

function sqliteIntegerField(value) {
  const ranges = [
    [1, -0x80, 0x7f],
    [2, -0x8000, 0x7fff],
    [3, -0x800000, 0x7fffff],
    [4, -0x80000000, 0x7fffffff],
    [6, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ];
  const [bytes] = ranges.find(([, min, max]) => value >= min && value <= max) || [6];
  const out = new Uint8Array(bytes);
  let big = BigInt(value);
  if (big < 0) big += 1n << BigInt(bytes * 8);

  for (let index = bytes - 1; index >= 0; index -= 1) {
    out[index] = Number(big & 0xffn);
    big >>= 8n;
  }

  return { serialType: bytes === 6 ? 6 : bytes, bytes: out };
}

function encodeVarint(value) {
  let big = BigInt(value);
  const bytes = [Number(big & 0x7fn)];
  big >>= 7n;

  while (big > 0n) {
    bytes.unshift(Number(big & 0x7fn) | 0x80);
    big >>= 7n;
  }

  return Uint8Array.from(bytes);
}

function concatBytes(...chunks) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.length;
  });
  return bytes;
}

function writeUint16(bytes, offset, value) {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function parseImageDataUrl(value) {
  const match = String(value || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;

  try {
    const binary = atob(match[2]);
    return {
      mime: match[1],
      bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    };
  } catch {
    return null;
  }
}

function imageBytesMatchMime(mime, bytes) {
  if (mime === "png") {
    return bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }

  if (mime === "jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (mime === "webp") {
    return bytes[0] === 0x52
      && bytes[1] === 0x49
      && bytes[2] === 0x46
      && bytes[3] === 0x46
      && bytes[8] === 0x57
      && bytes[9] === 0x45
      && bytes[10] === 0x42
      && bytes[11] === 0x50;
  }

  return false;
}

async function purgeableJobIds(env, before, preserveFrom, preserveTo) {
  const rows = await env.SCHEDULER_DB.prepare(`
    SELECT id
    FROM jobs
    WHERE status IN ('complete', 'cancelled')
      AND date(COALESCE(scheduled_start, created_at)) < date(?)
      AND (? IS NULL OR date(COALESCE(scheduled_start, created_at)) NOT BETWEEN date(?) AND date(?))
  `).bind(before, preserveFrom, preserveFrom, preserveTo).all();
  return (rows.results ?? []).map((row) => row.id).filter(Boolean);
}

async function purgeableConsultIds(env, before, preserveFrom, preserveTo) {
  if (!env.CONSULT_DB) return [];

  try {
    const rows = await env.CONSULT_DB.prepare(`
      SELECT id
      FROM schedule_requests
      WHERE status IN ('complete', 'completed', 'cancelled', 'closed', 'archived')
        AND date(COALESCE(preferred_date, created_at)) < date(?)
        AND (? IS NULL OR date(COALESCE(preferred_date, created_at)) NOT BETWEEN date(?) AND date(?))
    `).bind(before, preserveFrom, preserveFrom, preserveTo).all();
    return (rows.results ?? []).map((row) => row.id).filter(Boolean);
  } catch (error) {
    if (isMissingD1TableError(error)) return [];
    throw error;
  }
}

async function purgeableNotificationCount(env, before, preserveFrom, preserveTo) {
  const row = await env.SCHEDULER_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM notification_log
    WHERE date(created_at) < date(?)
      AND (? IS NULL OR date(created_at) NOT BETWEEN date(?) AND date(?))
  `).bind(before, preserveFrom, preserveFrom, preserveTo).first();
  return Number(row?.count || 0);
}

async function countRowsByJobIds(db, table, jobIds) {
  if (!jobIds.length) return 0;
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE job_id IN (${placeholders(jobIds)})`).bind(...jobIds).first();
  return Number(row?.count || 0);
}

function splitCsv(value) {
  return typeof value === "string" && value ? value.split(",").filter(Boolean) : [];
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = allowedCorsOrigins(env);
  const headers = new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
    "Vary": "Origin",
  });
  if (origin && (allowedOrigins.has(normalizeOrigin(origin)) || isDevLocalOrigin(origin, env))) headers.set("Access-Control-Allow-Origin", origin);
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

function isMissingD1TableError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /no such table/i.test(message);
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
  const fallback = `${getFrontendOrigin(env)}/dashboard`;
  if (!value) return fallback;
  try {
    const returnUrl = new URL(value, fallback);
    return isAllowedFrontendOrigin(returnUrl.origin, env) ? returnUrl.toString() : fallback;
  } catch {
    return fallback;
  }
}

function shouldPassSessionInRedirect(url, env) {
  return isAllowedFrontendOrigin(url.origin, env);
}

function isAllowedFrontendOrigin(origin, env) {
  return allowedFrontendOrigins(env).has(normalizeOrigin(origin)) || isDevLocalOrigin(origin, env);
}

function allowedCorsOrigins(env) {
  return new Set([
    ...allowedFrontendOrigins(env),
    normalizeOrigin(env.APP_ORIGIN),
  ].filter(Boolean));
}

function allowedFrontendOrigins(env) {
  return new Set([
    DEFAULT_FRONTEND_ORIGIN,
    ...DEFAULT_PRODUCTION_FRONTEND_ORIGINS,
    ...originList(env.FRONTEND_ORIGIN),
    ...originList(env.FRONTEND_ORIGINS),
  ].map(normalizeOrigin).filter(Boolean));
}

function originList(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return String(value).replace(/\/+$/, "");
  }
}

function isDevLocalOrigin(origin, env) {
  if (env.SCHEDULER_AUTH_MODE !== "dev") return false;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${value}`, "HttpOnly", "Secure", `SameSite=${options.sameSite || "Lax"}`, `Path=${options.path || "/"}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function devSessionCookie(name, value, options = {}, env) {
  if (env.SCHEDULER_AUTH_MODE !== "dev") return cookie(name, value, options);
  const parts = [`${name}=${value}`, "HttpOnly", `SameSite=${options.sameSite || "Lax"}`, `Path=${options.path || "/"}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function clearCookie(name, path = "/", env) {
  return devSessionCookie(name, "", { path, maxAge: 0, sameSite: "None" }, env);
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
