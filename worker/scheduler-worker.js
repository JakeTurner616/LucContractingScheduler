const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const DEFAULT_FRONTEND_ORIGIN = "http://localhost:4325";
const SESSION_COOKIE = "scheduler_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/api/health") {
        const row = await env.SCHEDULER_DB.prepare("SELECT datetime('now') AS now").first();
        return json(request, env, { ok: true, database: "connected", now: row?.now });
      }

      if (url.pathname === "/" || url.pathname === "/login") {
        return html(`
          <main style="font-family:system-ui;padding:40px;max-width:640px;margin:auto">
            <h1>Luc Contracting Scheduler</h1>
            <p>Internal scheduling dashboard.</p>
            <a href="/auth/google/start">
              <button style="font:inherit;padding:12px 18px;cursor:pointer">
                Sign in with Google
              </button>
            </a>
          </main>
        `);
      }

      if (url.pathname === "/auth/google/start") {
        return startGoogleAuth(request, env, url);
      }

      if (url.pathname === "/auth/google/callback") {
        return finishGoogleAuth(request, env, url);
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        return json(request, env, { ok: true }, { headers: [["Set-Cookie", clearCookie(SESSION_COOKIE)]] });
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        const user = await requireUser(request, env);
        return json(request, env, { user });
      }

      if (url.pathname === "/api/auth/debug" && request.method === "GET") {
        return json(request, env, {
          has_cookie_session: Boolean(getCookie(request, SESSION_COOKIE)),
          has_bearer_session: Boolean(getBearerToken(request)),
          origin: request.headers.get("Origin"),
        });
      }

      if (url.pathname === "/api/jobs") {
        const user = await requireUser(request, env);
        if (request.method === "GET") return listJobs(request, env);
        if (request.method === "POST") {
          requireSupervisor(user);
          return createJob(request, env);
        }
      }

      if (url.pathname === "/api/shifts") {
        const user = await requireUser(request, env);
        if (request.method === "GET") return listShifts(request, env, user);
        if (request.method === "POST") {
          requireSupervisor(user);
          return createShift(request, env);
        }
      }

      if (url.pathname === "/api/users") {
        const user = await requireUser(request, env);
        requireSupervisor(user);
        if (request.method === "GET") return listUsers(request, env);
        if (request.method === "POST") return createUser(request, env);
      }

      return json(request, env, { error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) {
        return json(request, env, { error: error.message }, { status: error.status });
      }

      console.error(error);
      return json(request, env, { error: "Internal server error" }, { status: 500 });
    }
  },
};

async function startGoogleAuth(request, env, url) {
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

  if (!state || !expectedState || state !== expectedState) {
    return new Response("Invalid OAuth state", { status: 400, headers: clearOauthCookies() });
  }

  if (!code) {
    return new Response("Missing Google OAuth code", { status: 400, headers: clearOauthCookies() });
  }

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

  if (!tokenRes.ok) {
    return new Response(await tokenRes.text(), { status: 400, headers: clearOauthCookies() });
  }

  const tokenData = await tokenRes.json();
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    return new Response("Failed to fetch Google profile", { status: 400, headers: clearOauthCookies() });
  }

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

  await env.SCHEDULER_DB.prepare(`
    UPDATE users
    SET last_login_at = datetime('now')
    WHERE id = ?
  `).bind(allowedUser.id).run();

  const session = await createSession(env, allowedUser);
  const redirectUrl = new URL(returnTo);
  const isLocalReturn = redirectUrl.hostname === "localhost" || redirectUrl.hostname === "127.0.0.1";

  if (isLocalReturn) {
    redirectUrl.searchParams.set("session", session);
  }

  return new Response(null, {
    status: 302,
    headers: [
      ["Location", redirectUrl.toString()],
      ["Set-Cookie", cookie(SESSION_COOKIE, session, { path: "/", maxAge: SESSION_MAX_AGE, sameSite: "None" })],
      ...clearOauthCookiePairs(),
    ],
  });
}

async function listJobs(request, env) {
  const rows = await env.SCHEDULER_DB.prepare(`
    SELECT id, title, location, status, public_notes, created_at, updated_at
    FROM jobs
    ORDER BY created_at DESC
  `).all();

  return json(request, env, { jobs: rows.results ?? [] });
}

async function createJob(request, env) {
  const body = await readJson(request);
  const title = stringField(body.title, "title");
  const location = nullableString(body.location);
  const publicNotes = nullableString(body.public_notes);
  const status = enumField(body.status ?? "open", "status", ["draft", "open", "complete", "cancelled"]);
  const id = crypto.randomUUID();

  await env.SCHEDULER_DB.prepare(`
    INSERT INTO jobs (id, title, location, status, public_notes)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, title, location, status, publicNotes).run();

  const job = await env.SCHEDULER_DB.prepare(`
    SELECT id, title, location, status, public_notes, created_at, updated_at
    FROM jobs
    WHERE id = ?
  `).bind(id).first();

  return json(request, env, { job }, { status: 201 });
}

async function listShifts(request, env, user) {
  const supervisor = user.role === "supervisor";
  const statement = supervisor
    ? env.SCHEDULER_DB.prepare(`
        SELECT shifts.id, shifts.job_id, shifts.user_id, shifts.starts_at, shifts.ends_at, shifts.status,
          shifts.public_notes, jobs.title AS job_title, jobs.location AS job_location,
          users.name AS user_name, users.email AS user_email
        FROM shifts
        JOIN jobs ON jobs.id = shifts.job_id
        JOIN users ON users.id = shifts.user_id
        ORDER BY shifts.starts_at ASC
      `)
    : env.SCHEDULER_DB.prepare(`
        SELECT shifts.id, shifts.job_id, shifts.user_id, shifts.starts_at, shifts.ends_at, shifts.status,
          shifts.public_notes, jobs.title AS job_title, jobs.location AS job_location,
          users.name AS user_name, users.email AS user_email
        FROM shifts
        JOIN jobs ON jobs.id = shifts.job_id
        JOIN users ON users.id = shifts.user_id
        WHERE shifts.user_id = ?
        ORDER BY shifts.starts_at ASC
      `).bind(user.id);

  const rows = await statement.all();
  return json(request, env, { shifts: rows.results ?? [] });
}

async function createShift(request, env) {
  const body = await readJson(request);
  const jobId = stringField(body.job_id, "job_id");
  const userId = stringField(body.user_id, "user_id");
  const startsAt = stringField(body.starts_at, "starts_at");
  const endsAt = nullableString(body.ends_at);
  const publicNotes = nullableString(body.public_notes);
  const status = enumField(body.status ?? "scheduled", "status", ["scheduled", "cancelled", "complete"]);
  const id = crypto.randomUUID();

  await env.SCHEDULER_DB.prepare(`
    INSERT INTO shifts (id, job_id, user_id, starts_at, ends_at, status, public_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, jobId, userId, startsAt, endsAt, status, publicNotes).run();

  return json(request, env, { shift: { id, job_id: jobId, user_id: userId, starts_at: startsAt, ends_at: endsAt, status, public_notes: publicNotes } }, { status: 201 });
}

async function listUsers(request, env) {
  const rows = await env.SCHEDULER_DB.prepare(`
    SELECT id, email, name, role, active, created_at, last_login_at
    FROM users
    ORDER BY active DESC, name COLLATE NOCASE, email COLLATE NOCASE
  `).all();

  return json(request, env, { users: rows.results ?? [] });
}

async function createUser(request, env) {
  const body = await readJson(request);
  const email = stringField(body.email, "email").toLowerCase();
  const name = nullableString(body.name);
  const role = enumField(body.role ?? "employee", "role", ["employee", "supervisor"]);
  const active = body.active === false || body.active === 0 ? 0 : 1;
  const id = crypto.randomUUID();

  await env.SCHEDULER_DB.prepare(`
    INSERT INTO users (id, email, name, role, active)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, email, name, role, active).run();

  const user = await env.SCHEDULER_DB.prepare(`
    SELECT id, email, name, role, active, created_at, last_login_at
    FROM users
    WHERE id = ?
  `).bind(id).first();

  return json(request, env, { user }, { status: 201 });
}

async function requireUser(request, env) {
  const token = getBearerToken(request) || getCookie(request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "Not authenticated");

  const payload = await verifySession(env, token);
  if (!payload?.sub) throw new HttpError(401, "Invalid session");

  const user = await env.SCHEDULER_DB.prepare(`
    SELECT id, email, name, role, active
    FROM users
    WHERE id = ?
    LIMIT 1
  `).bind(payload.sub).first();

  if (!user || user.active !== 1) throw new HttpError(401, "Not authenticated");

  return user;
}

function requireSupervisor(user) {
  if (user.role !== "supervisor") throw new HttpError(403, "Supervisor access required");
}

async function findActiveUserByEmail(env, email) {
  if (!email) return null;

  return env.SCHEDULER_DB.prepare(`
    SELECT id, email, name, role, active
    FROM users
    WHERE lower(email) = lower(?)
    LIMIT 1
  `).bind(email).first().then((user) => (user?.active === 1 ? user : null));
}

async function createSession(env, user) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };

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
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function stringField(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing ${field}`);
  }
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

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = new Set([DEFAULT_FRONTEND_ORIGIN, env.FRONTEND_ORIGIN, env.APP_ORIGIN].filter(Boolean));
  const headers = new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
    "Vary": "Origin",
  });

  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  return headers;
}

function json(request, env, body, options = {}) {
  const headers = corsHeaders(request, env);
  new Headers(options.headers).forEach((value, key) => headers.append(key, value));
  headers.set("Content-Type", "application/json; charset=utf-8");

  return Response.json(body, {
    status: options.status ?? 200,
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
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
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

function cookie(name, value, options = {}) {
  const parts = [
    `${name}=${value}`,
    "HttpOnly",
    "Secure",
    `SameSite=${options.sameSite || "Lax"}`,
    `Path=${options.path || "/"}`,
  ];

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
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
