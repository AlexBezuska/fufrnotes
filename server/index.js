import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(repoRoot, "public");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const TRUST_PROXY = (process.env.TRUST_PROXY || "1") === "1";

const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  // In dev, allow starting without DB so you can see an obvious error from the API.
  console.warn("Missing DATABASE_URL; API will error until set.");
}

const pool = new Pool({ connectionString: DATABASE_URL || undefined });

const PASSHROOM_BASE_URL = String(process.env.PASSHROOM_BASE_URL || "").trim();
const PASSHROOM_CLIENT_ID = String(process.env.PASSHROOM_CLIENT_ID || "").trim();
const PASSHROOM_CLIENT_SECRET = String(process.env.PASSHROOM_CLIENT_SECRET || "").trim();
// We support root callback as well as /auth/passhroom/callback.
const PASSHROOM_CALLBACK_URL = String(process.env.PASSHROOM_CALLBACK_URL || "").trim();

function normalizePasshroomCallbackUrl() {
  const raw = String(PASSHROOM_CALLBACK_URL || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    // If someone sets just an origin, ensure a stable root slash.
    if (!u.pathname || u.pathname === "") u.pathname = "/";
    // Preserve an explicit callback path, but normalize root to include trailing slash.
    if (u.pathname === "/") {
      return `${u.origin}/`;
    }
    return u.toString();
  } catch {
    // Best effort: ensure root form ends with '/'
    if (raw === raw.replace(/\/$/, "")) return `${raw}/`;
    return raw;
  }
}

const PASSHROOM_CALLBACK_URL_NORM = normalizePasshroomCallbackUrl();

const SESSION_COOKIE = process.env.SESSION_COOKIE || "fufnotes_sess";
const PASSHROOM_STATE_COOKIE = process.env.PASSHROOM_STATE_COOKIE || "fufnotes_ph_state";
const SESSION_TTL_SECONDS = Number.parseInt(process.env.SESSION_TTL_SECONDS || String(60 * 60 * 24 * 14), 10); // 14d

async function ensureSchema() {
  // Minimal “migration” on boot. Keep idempotent.
  await pool.query(`
    create table if not exists app_users (
      passhroom_user_id text primary key,
      email text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists notes (
      id text primary key,
      owner_user_id text not null,
      title text not null default '',
      content text not null default '',
      revision integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists notes_owner_updated_idx on notes (owner_user_id, updated_at desc);

    create table if not exists sessions (
      id text primary key,
      passhroom_user_id text not null references app_users(passhroom_user_id) on delete cascade,
      email text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
    create index if not exists sessions_expires_idx on sessions (expires_at);

    create table if not exists projects (
      id text primary key,
      owner_user_id text not null references app_users(passhroom_user_id) on delete cascade,
      title text not null default '',
      due_at timestamptz null,
      description text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists projects_owner_updated_idx on projects (owner_user_id, updated_at desc);

    create table if not exists project_lists (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      owner_user_id text not null references app_users(passhroom_user_id) on delete cascade,
      title text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists project_lists_project_idx on project_lists (project_id, created_at asc);

    create table if not exists todos (
      id text primary key,
      list_id text not null references project_lists(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      owner_user_id text not null references app_users(passhroom_user_id) on delete cascade,
      due_at timestamptz null,
      recurring text not null default '',
      notes text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists todos_list_created_idx on todos (list_id, created_at asc);

    create table if not exists project_todos (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      owner_user_id text not null references app_users(passhroom_user_id) on delete cascade,
      title text not null default '',
      due_at timestamptz null,
      done boolean not null default false,
      linked_note_id text null references notes(id) on delete set null,
      note_managed_title boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists project_todos_project_created_idx on project_todos (project_id, created_at asc);
  `);
}

function jsonError(res, status, payload) {
  res.status(status);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify({ ok: false, ...payload }));
}

function jsonOk(res, payload) {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify({ ok: true, ...payload }));
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function isRequestSecure(req) {
  // Explicit override (useful for local dev behind http)
  const override = String(process.env.COOKIE_SECURE || "");
  if (override === "1") return true;
  if (override === "0") return false;

  if (req && req.secure) return true;
  const xfProto = req?.headers?.["x-forwarded-proto"];
  if (typeof xfProto === "string") {
    const first = xfProto.split(",")[0]?.trim()?.toLowerCase();
    return first === "https";
  }
  return false;
}

function setCookie(req, res, name, value, { maxAgeSeconds = null } = {}) {
  const isSecure = isRequestSecure(req);
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    isSecure ? "Secure" : "",
  ].filter(Boolean);
  if (maxAgeSeconds != null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(req, res, name) {
  setCookie(req, res, name, "", { maxAgeSeconds: 0 });
}

async function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE] || "";
  if (!sid) return null;
  const { rows } = await pool.query(
    `select id, passhroom_user_id, email, expires_at from sessions where id=$1 limit 1`,
    [sid]
  );
  const row = rows[0];
  if (!row) return null;
  const expiresAt = new Date(row.expires_at);
  if (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
    await pool.query(`delete from sessions where id=$1`, [sid]);
    return null;
  }
  return { id: row.id, userId: row.passhroom_user_id, email: row.email };
}

async function requireSession(req, res) {
  const dev = process.env.DEV_USER_ID;
  if (dev) return { id: "dev", userId: String(dev), email: "dev@example.com" };

  const session = await getSessionFromRequest(req);
  if (!session) {
    jsonError(res, 401, { error: "unauthorized" });
    return null;
  }
  return session;
}

function randomId() {
  // Hex-ish, similar to the PHP app ids.
  return randomBytes(16).toString("hex");
}

function firstNonEmptyLine(s) {
  const lines = String(s || "").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const t = String(line || "").trim();
    if (t) return t;
  }
  return "";
}

function parseOptionalDateOnlyToUtcMidnight(dateOnly) {
  const s = String(dateOnly || "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) return undefined;
  return d;
}

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.use(express.json({ limit: "2mb" }));

// --- Passhroom auth

function buildPasshroomRedirectUris() {
  const out = [];
  try {
    const u = new URL(PASSHROOM_CALLBACK_URL_NORM || PASSHROOM_CALLBACK_URL);
    const origin = u.origin;
    out.push(PASSHROOM_CALLBACK_URL_NORM || PASSHROOM_CALLBACK_URL);
    out.push(String(PASSHROOM_CALLBACK_URL_NORM || PASSHROOM_CALLBACK_URL || "").replace(/\/$/, ""));
    out.push(String(PASSHROOM_CALLBACK_URL_NORM || PASSHROOM_CALLBACK_URL || "").replace(/\/?$/, "/"));
    out.push(`${origin}/`);
    out.push(origin);
    out.push(`${origin}/auth/passhroom/callback`);
    out.push(`${origin}/auth/passhroom/callback/`);
  } catch {
    out.push(PASSHROOM_CALLBACK_URL_NORM || PASSHROOM_CALLBACK_URL);
  }
  const uniq = [];
  const seen = new Set();
  for (const v of out.map((s) => String(s || "").trim()).filter(Boolean)) {
    if (seen.has(v)) continue;
    seen.add(v);
    uniq.push(v);
  }
  return uniq;
}

async function exchangePasshroomCodeForToken({ code, req, res, allowStateCookieBypass = false, redirectUrisOverride = null }) {
  const tokenUrl = `${PASSHROOM_BASE_URL.replace(/\/$/, "")}/v1/auth/token`;
  const redirectUris = Array.isArray(redirectUrisOverride) && redirectUrisOverride.length
    ? redirectUrisOverride
    : buildPasshroomRedirectUris();

  let token = null;
  let tokenRaw = "";
  let lastStatus = 0;
  let lastPreview = "";
  let lastParsedError = "";
  for (const redirectUri of redirectUris) {
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PASSHROOM_CLIENT_ID,
        client_secret: PASSHROOM_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    lastStatus = r.status;
    tokenRaw = await r.text();
    token = (() => {
      try {
        return JSON.parse(tokenRaw);
      } catch {
        return null;
      }
    })();

    if (r.ok && token && token.user_id) {
      if (redirectUri !== PASSHROOM_CALLBACK_URL) {
        console.log("passhroom token ok using redirect_uri variant", redirectUri);
      }
      return { ok: true, token };
    }

    lastPreview = String(tokenRaw || "").slice(0, 300);
    if (token && typeof token.error === "string") lastParsedError = token.error;
    if (r.status === 401 || r.status === 403) {
      console.error("passhroom token failed", r.status, "unauthorized", lastPreview);
      if (!allowStateCookieBypass && req && res) clearCookie(req, res, PASSHROOM_STATE_COOKIE);
      return { ok: false, error: "passhroom_client_secret_invalid", status: 500 };
    }
  }

  console.error("passhroom token failed", lastStatus, "tried_redirect_uris=", redirectUris, lastPreview);
  if (!allowStateCookieBypass && req && res) clearCookie(req, res, PASSHROOM_STATE_COOKIE);

  if (lastParsedError) {
    // Surface Passhroom's exact error code to the client for clarity.
    return { ok: false, error: lastParsedError, status: lastStatus || 400 };
  }
  return { ok: false, error: "token_exchange_failed", status: lastStatus || 400 };
}

async function exchangePasshroomLoginCodeForAuthCode({ email, loginCode }) {
  const codeUrl = `${PASSHROOM_BASE_URL.replace(/\/$/, "")}/code`;
  const body = new URLSearchParams({
    email: String(email || "").trim().toLowerCase(),
    code: String(loginCode || ""),
  });

  const r = await fetch(codeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });

  if (r.status === 302 || r.status === 303) {
    const loc = r.headers.get("location") || "";
    if (!loc) return { ok: false, error: "passhroom_code_no_location", status: 502 };
    let u;
    try {
      u = new URL(loc);
    } catch {
      return { ok: false, error: "passhroom_code_bad_location", status: 502 };
    }

    const authCode = u.searchParams.get("code") || "";
    const state = u.searchParams.get("state") || "";
    const redirectUri = `${u.origin}${u.pathname || ""}`;
    if (!authCode || !state) return { ok: false, error: "passhroom_code_missing_params", status: 502 };
    return { ok: true, authCode, state, redirectUri };
  }

  const txt = await r.text().catch(() => "");
  if (r.status === 429) return { ok: false, error: "rate_limited", status: 429 };
  if (r.status === 400) {
    const preview = String(txt || "").slice(0, 400);
    if (/already used/i.test(preview)) return { ok: false, error: "code_used", status: 400 };
    if (/expired/i.test(preview)) return { ok: false, error: "code_expired", status: 400 };
    if (/invalid code/i.test(preview)) return { ok: false, error: "invalid_code", status: 400 };
    return { ok: false, error: "invalid_code", status: 400 };
  }

  console.error("passhroom /code failed", r.status, String(txt || "").slice(0, 300));
  return { ok: false, error: "passhroom_code_failed", status: 502 };
}

async function createAppSessionFromPasshroomToken({ token, req, res, redirectToRoot = false }) {
  const passhroomUserId = String(token.user_id);
  const email = String(token.email || "").toLowerCase();

  await pool.query(
    `insert into app_users (passhroom_user_id, email)
     values ($1, $2)
     on conflict (passhroom_user_id) do update set email=excluded.email`,
    [passhroomUserId, email]
  );

  const sid = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await pool.query(
    `insert into sessions (id, passhroom_user_id, email, expires_at) values ($1, $2, $3, $4)`,
    [sid, passhroomUserId, email, expiresAt.toISOString()]
  );

  setCookie(req, res, SESSION_COOKIE, sid, { maxAgeSeconds: SESSION_TTL_SECONDS });
  clearCookie(req, res, PASSHROOM_STATE_COOKIE);
  if (redirectToRoot) return res.redirect("/");
  return jsonOk(res, {});
}

app.post("/auth/passhroom/start", async (req, res) => {
  try {
    await ensureSchema();
  } catch {
    return jsonError(res, 500, { error: "db_schema" });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 254) {
    return jsonError(res, 400, { error: "bad_email" });
  }

  const state = randomBytes(16).toString("hex");

  const url = `${PASSHROOM_BASE_URL.replace(/\/$/, "")}/v1/auth/start`;
  const body = {
    client_id: PASSHROOM_CLIENT_ID,
    email,
    redirect_uri: PASSHROOM_CALLBACK_URL_NORM || PASSHROOM_CALLBACK_URL,
    state,
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(txt);
    } catch {
      parsed = null;
    }

    if (!r.ok) {
      if (r.status === 429 && parsed && parsed.status === "cooldown") {
        return jsonOk(res, { cooldown: true, message: parsed.message || "" });
      }
      console.error("passhroom start failed", r.status, txt.slice(0, 300));
      return jsonError(res, 502, { error: "passhroom_start_failed" });
    }

    setCookie(req, res, PASSHROOM_STATE_COOKIE, state, { maxAgeSeconds: 10 * 60 });
  } catch (e) {
    console.error("passhroom start error", e);
    return jsonError(res, 502, { error: "passhroom_unreachable" });
  }

  return jsonOk(res, {});
});

app.post("/auth/passhroom/code", async (req, res) => {
  try {
    await ensureSchema();
  } catch {
    return jsonError(res, 500, { error: "db_schema" });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const loginCode = String(req.body?.code || "").trim();
  if (!email || !email.includes("@") || email.length > 254) return jsonError(res, 400, { error: "bad_email" });
  if (!loginCode || loginCode.length > 2048) return jsonError(res, 400, { error: "bad_code" });

  if (!PASSHROOM_CLIENT_SECRET) {
    return jsonError(res, 500, { error: "missing_passhroom_client_secret" });
  }

  // Step 1: convert the user-facing “mushroom name” login code into a real auth code + state.
  let minted;
  try {
    minted = await exchangePasshroomLoginCodeForAuthCode({ email, loginCode });
  } catch (e) {
    console.error("passhroom code exchange error", e);
    return jsonError(res, 502, { error: "passhroom_unreachable" });
  }

  if (!minted.ok) return jsonError(res, minted.status || 400, { error: minted.error || "invalid_code" });

  // Step 2: verify state cookie (CSRF protection) using the minted redirect state.
  const cookies = parseCookies(req);
  const expected = cookies[PASSHROOM_STATE_COOKIE] || "";
  if (!expected || expected !== minted.state) {
    clearCookie(req, res, PASSHROOM_STATE_COOKIE);
    return jsonError(res, 400, { error: "bad_state" });
  }

  // Step 3: exchange the minted auth code for user identity.
  let exchanged;
  try {
    exchanged = await exchangePasshroomCodeForToken({
      code: minted.authCode,
      req,
      res,
      allowStateCookieBypass: false,
      redirectUrisOverride: [minted.redirectUri],
    });
  } catch (e) {
    console.error("passhroom token error", e);
    return jsonError(res, 502, { error: "passhroom_unreachable" });
  }

  if (!exchanged.ok) return jsonError(res, exchanged.status || 400, { error: exchanged.error || "token_exchange_failed" });
  return await createAppSessionFromPasshroomToken({ token: exchanged.token, req, res, redirectToRoot: false });
});

async function handlePasshroomCallback(req, res) {
  try {
    await ensureSchema();
  } catch {
    return res.status(500).send("db_schema");
  }

  try {
    const host = String(req.headers.host || "");
    const xfProto = String(req.headers["x-forwarded-proto"] || "");
    const hasStateCookie = Object.prototype.hasOwnProperty.call(parseCookies(req), PASSHROOM_STATE_COOKIE);
    console.log("passhroom callback", {
      host,
      xfProto,
      hasCode: typeof req.query.code === "string" && req.query.code.length > 0,
      hasState: typeof req.query.state === "string" && req.query.state.length > 0,
      hasStateCookie,
    });
  } catch {
    // ignore
  }

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (!code || !state) {
    return res.redirect("/");
  }

  const cookies = parseCookies(req);
  const expected = cookies[PASSHROOM_STATE_COOKIE] || "";
  if (!expected || expected !== state) {
    clearCookie(req, res, PASSHROOM_STATE_COOKIE);
    return res.status(400).send("bad_state");
  }

  if (!PASSHROOM_CLIENT_SECRET) {
    clearCookie(req, res, PASSHROOM_STATE_COOKIE);
    return res.status(500).send("missing_passhroom_client_secret");
  }

  let exchanged;
  try {
    exchanged = await exchangePasshroomCodeForToken({ code, req, res, allowStateCookieBypass: false });
  } catch (e) {
    console.error("passhroom token error", e);
    clearCookie(req, res, PASSHROOM_STATE_COOKIE);
    return res.status(502).send("passhroom_unreachable");
  }

  if (!exchanged.ok) {
    if (exchanged.error === "passhroom_client_secret_invalid") return res.status(500).send("passhroom_client_secret_invalid");
    return res.status(400).send("token_exchange_failed");
  }

  return await createAppSessionFromPasshroomToken({ token: exchanged.token, req, res, redirectToRoot: true });
}

app.get("/auth/passhroom/callback", handlePasshroomCallback);

// Root callback support (for Passhroom apps allowlisted with a root redirect_uri)
app.get("/", (req, res, next) => {
  if (req.query && typeof req.query.code === "string" && typeof req.query.state === "string") {
    return void handlePasshroomCallback(req, res);
  }
  next();
});

// SPA static files
app.use(express.static(publicDir, { extensions: ["html"] }));

// --- API: keep the existing action= shape.
async function handleApi(req, res) {
  const action = String(req.query.action || "");

  // boot-time schema check, but only when actually hit.
  try {
    await ensureSchema();
  } catch (e) {
    console.error("schema error", e);
    return jsonError(res, 500, { error: "db_schema" });
  }

  if (!action) return jsonError(res, 400, { error: "missing_action" });

  if (action === "login") {
    const session = await requireSession(req, res);
    if (!session) return;
    return jsonOk(res, { email: session.email });
  }

  if (action === "logout") {
    const cookies = parseCookies(req);
    const sid = cookies[SESSION_COOKIE] || "";
    if (sid) {
      await pool.query(`delete from sessions where id=$1`, [sid]).catch(() => {});
    }
    clearCookie(req, res, SESSION_COOKIE);
    return jsonOk(res, {});
  }

  const session = await requireSession(req, res);
  if (!session) return;
  const userId = session.userId;

  try {
    if (action === "list") {
      const { rows } = await pool.query(
        `select id, title, revision, updated_at from notes where owner_user_id=$1 order by updated_at desc`,
        [userId]
      );
      const notes = rows.map((r) => ({
        id: r.id,
        title: r.title,
        revision: Number(r.revision),
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
      return jsonOk(res, { notes });
    }

    if (action === "get") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });

      const { rows } = await pool.query(
        `select id, title, content, revision, updated_at from notes where id=$1 and owner_user_id=$2 limit 1`,
        [id, userId]
      );
      const row = rows[0];
      if (!row) return jsonError(res, 404, { error: "not_found" });

      const meta = {
        id: row.id,
        title: row.title,
        revision: Number(row.revision),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
      return jsonOk(res, { meta, content: row.content || "" });
    }

    if (action === "create") {
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });
      const title = String(req.body?.title || "Untitled");
      const id = randomId();
      const { rows } = await pool.query(
        `insert into notes (id, owner_user_id, title, content, revision) values ($1,$2,$3,$4,1)
         returning id, title, revision, updated_at`,
        [id, userId, title, ""]
      );
      const row = rows[0];
      const meta = {
        id: row.id,
        title: row.title,
        revision: Number(row.revision),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
      return jsonOk(res, { meta });
    }

    if (action === "save") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });

      const title = String(req.body?.title || "");
      const content = String(req.body?.content || "");
      const baseRevision = Number(req.body?.baseRevision || 0);
      const force = !!req.body?.force;

      if (!Number.isFinite(baseRevision) || baseRevision < 0) {
        return jsonError(res, 400, { error: "bad_revision" });
      }

      if (force) {
        const { rows } = await pool.query(
          `update notes
             set title=$1, content=$2, revision=revision+1, updated_at=now()
           where id=$3 and owner_user_id=$4
           returning id, title, revision, updated_at`,
          [title, content, id, userId]
        );
        const row = rows[0];
        if (!row) return jsonError(res, 404, { error: "not_found" });
        const meta = {
          id: row.id,
          title: row.title,
          revision: Number(row.revision),
          updatedAt: new Date(row.updated_at).toISOString(),
        };
        return jsonOk(res, { meta });
      }

      const { rows } = await pool.query(
        `update notes
           set title=$1, content=$2, revision=revision+1, updated_at=now()
         where id=$3 and owner_user_id=$4 and revision=$5
         returning id, title, revision, updated_at`,
        [title, content, id, userId, baseRevision]
      );

      if (rows.length === 0) {
        const cur = await pool.query(
          `select id, title, content, revision, updated_at from notes where id=$1 and owner_user_id=$2 limit 1`,
          [id, userId]
        );
        const row = cur.rows[0];
        if (!row) return jsonError(res, 404, { error: "not_found" });

        const meta = {
          id: row.id,
          title: row.title,
          revision: Number(row.revision),
          updatedAt: new Date(row.updated_at).toISOString(),
        };
        // Conflict shape matches the PHP backend.
        return jsonError(res, 409, { error: "conflict", meta, content: row.content || "" });
      }

      const row = rows[0];
      const meta = {
        id: row.id,
        title: row.title,
        revision: Number(row.revision),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
      return jsonOk(res, { meta });
    }

    if (action === "delete") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });
      await pool.query(`delete from notes where id=$1 and owner_user_id=$2`, [id, userId]);
      return jsonOk(res, {});
    }

    if (action === "projects_list") {
      const { rows } = await pool.query(
        `select id, title, due_at, created_at, updated_at
           from projects
          where owner_user_id=$1
          order by updated_at desc`,
        [userId]
      );
      const projects = rows.map((r) => ({
        id: r.id,
        title: r.title,
        dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
      return jsonOk(res, { projects });
    }

    if (action === "projects_get") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });

      const p = await pool.query(
        `select id, title, due_at, description, created_at, updated_at
           from projects
          where id=$1 and owner_user_id=$2
          limit 1`,
        [id, userId]
      );
      const prow = p.rows[0];
      if (!prow) return jsonError(res, 404, { error: "not_found" });

      // New model: a project has a single lean todo list.
      // Best-effort migration: if a project has legacy todos but no project_todos yet,
      // create project_todos rows with titles derived from the legacy notes field.
      const hasNew = await pool.query(
        `select 1 from project_todos where project_id=$1 and owner_user_id=$2 limit 1`,
        [id, userId]
      );
      if (!hasNew.rows[0]) {
        const legacy = await pool.query(
          `select t.due_at, t.notes, t.created_at
             from todos t
            where t.project_id=$1 and t.owner_user_id=$2
            order by t.created_at asc`,
          [id, userId]
        );
        if (legacy.rows.length) {
          for (const row of legacy.rows) {
            const title = firstNonEmptyLine(row.notes) || "Todo";
            await pool.query(
              `insert into project_todos (id, project_id, owner_user_id, title, due_at, done)
               values ($1,$2,$3,$4,$5,false)`,
              [randomId(), id, userId, title.slice(0, 200), row.due_at]
            );
          }
        }
      }

      const ptTodosQ = await pool.query(
        `select pt.id, pt.title, pt.due_at, pt.done, pt.linked_note_id, n.title as linked_note_title, pt.created_at
           from project_todos pt
           left join notes n on n.id = pt.linked_note_id and n.owner_user_id = pt.owner_user_id
          where pt.project_id=$1 and pt.owner_user_id=$2
          order by pt.created_at asc`,
        [id, userId]
      );

      // Legacy: keep returning lists for old clients.
      const listsQ = await pool.query(
        `select id, title, created_at
           from project_lists
          where project_id=$1 and owner_user_id=$2
          order by created_at asc`,
        [id, userId]
      );
      const legacyTodosQ = await pool.query(
        `select id, list_id, due_at, recurring, notes, created_at
           from todos
          where project_id=$1 and owner_user_id=$2
          order by created_at asc`,
        [id, userId]
      );

      const todosByList = new Map();
      for (const t of legacyTodosQ.rows) {
        const arr = todosByList.get(t.list_id) || [];
        arr.push({
          id: t.id,
          listId: t.list_id,
          dueAt: t.due_at ? new Date(t.due_at).toISOString() : null,
          recurring: t.recurring || "",
          notes: t.notes || "",
          createdAt: new Date(t.created_at).toISOString(),
        });
        todosByList.set(t.list_id, arr);
      }

      const lists = listsQ.rows.map((l) => ({
        id: l.id,
        title: l.title,
        createdAt: new Date(l.created_at).toISOString(),
        todos: todosByList.get(l.id) || [],
      }));

      const project = {
        id: prow.id,
        title: prow.title,
        dueAt: prow.due_at ? new Date(prow.due_at).toISOString() : null,
        description: prow.description || "",
        createdAt: new Date(prow.created_at).toISOString(),
        updatedAt: new Date(prow.updated_at).toISOString(),
      };
      const todos = ptTodosQ.rows.map((t) => ({
        id: t.id,
        title: t.title || "",
        dueAt: t.due_at ? new Date(t.due_at).toISOString() : null,
        done: !!t.done,
        linkedNoteId: t.linked_note_id || "",
        linkedNoteTitle: t.linked_note_title || "",
        createdAt: new Date(t.created_at).toISOString(),
      }));

      return jsonOk(res, { project, todos, lists });
    }

    if (action === "projects_create") {
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });
      const title = String(req.body?.title || "").trim() || "Untitled project";
      if (title.length > 200) return jsonError(res, 400, { error: "title_too_long" });
      const description = String(req.body?.description || "");
      if (description.length > 200000) return jsonError(res, 400, { error: "description_too_long" });

      const dueParsed = parseOptionalDateOnlyToUtcMidnight(req.body?.dueAt);
      if (dueParsed === undefined) return jsonError(res, 400, { error: "bad_due_date" });

      const id = randomId();
      const { rows } = await pool.query(
        `insert into projects (id, owner_user_id, title, due_at, description)
         values ($1,$2,$3,$4,$5)
         returning id, title, due_at, description, created_at, updated_at`,
        [id, userId, title, dueParsed, description]
      );
      const r = rows[0];
      return jsonOk(res, {
        project: {
          id: r.id,
          title: r.title,
          dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
          description: r.description || "",
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
        },
      });
    }

    if (action === "projects_update") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });

      const prev = await pool.query(
        `select title from projects where id=$1 and owner_user_id=$2 limit 1`,
        [id, userId]
      );
      const prevTitle = prev.rows[0]?.title || "";

      const title = String(req.body?.title || "").trim() || "Untitled project";
      if (title.length > 200) return jsonError(res, 400, { error: "title_too_long" });
      const description = String(req.body?.description || "");
      if (description.length > 200000) return jsonError(res, 400, { error: "description_too_long" });

      const dueParsed = parseOptionalDateOnlyToUtcMidnight(req.body?.dueAt);
      if (dueParsed === undefined) return jsonError(res, 400, { error: "bad_due_date" });

      const { rows } = await pool.query(
        `update projects
            set title=$1, due_at=$2, description=$3, updated_at=now()
          where id=$4 and owner_user_id=$5
          returning id, title, due_at, description, created_at, updated_at`,
        [title, dueParsed, description, id, userId]
      );
      const r = rows[0];
      if (!r) return jsonError(res, 404, { error: "not_found" });

      if (prevTitle !== title) {
        // Keep managed linked note titles in sync when the project title changes.
        await pool.query(
          `update notes n
              set title = $1 || ' — ' || pt.title,
                  updated_at = now(),
                  revision = revision + 1
             from project_todos pt
            where pt.project_id=$2
              and pt.owner_user_id=$3
              and pt.note_managed_title = true
              and pt.linked_note_id is not null
              and n.id = pt.linked_note_id
              and n.owner_user_id = pt.owner_user_id`,
          [title, id, userId]
        ).catch(() => {});
      }
      return jsonOk(res, {
        project: {
          id: r.id,
          title: r.title,
          dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
          description: r.description || "",
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
        },
      });
    }

    if (action === "project_todos_create") {
      const projectId = String(req.query.projectId || "");
      if (!projectId) return jsonError(res, 400, { error: "missing_project_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });

      const title = String(req.body?.title || "").trim() || "Todo";
      if (title.length > 200) return jsonError(res, 400, { error: "title_too_long" });
      const dueParsed = parseOptionalDateOnlyToUtcMidnight(req.body?.dueAt);
      if (dueParsed === undefined) return jsonError(res, 400, { error: "bad_due_date" });

      const ok = await pool.query(`select 1 from projects where id=$1 and owner_user_id=$2 limit 1`, [projectId, userId]);
      if (!ok.rows[0]) return jsonError(res, 404, { error: "not_found" });

      const id = randomId();
      const { rows } = await pool.query(
        `insert into project_todos (id, project_id, owner_user_id, title, due_at, done)
         values ($1,$2,$3,$4,$5,false)
         returning id, title, due_at, done, linked_note_id, created_at`,
        [id, projectId, userId, title, dueParsed]
      );
      await pool.query(`update projects set updated_at=now() where id=$1 and owner_user_id=$2`, [projectId, userId]);
      const r = rows[0];
      return jsonOk(res, {
        todo: {
          id: r.id,
          title: r.title,
          dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
          done: !!r.done,
          linkedNoteId: r.linked_note_id || "",
          createdAt: new Date(r.created_at).toISOString(),
        },
      });
    }

    if (action === "project_todos_update") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });

      const title = req.body?.title != null ? String(req.body.title).trim() : null;
      if (title != null && title.length > 200) return jsonError(res, 400, { error: "title_too_long" });
      const done = req.body?.done != null ? !!req.body.done : null;
      const hasDue = Object.prototype.hasOwnProperty.call(req.body || {}, "dueAt");
      const dueParsed = hasDue ? parseOptionalDateOnlyToUtcMidnight(req.body?.dueAt) : null;
      if (hasDue && dueParsed === undefined) return jsonError(res, 400, { error: "bad_due_date" });
      const linkedNoteId = req.body?.linkedNoteId != null ? String(req.body.linkedNoteId || "") : null;

      if (linkedNoteId) {
        const okNote = await pool.query(`select 1 from notes where id=$1 and owner_user_id=$2 limit 1`, [linkedNoteId, userId]);
        if (!okNote.rows[0]) return jsonError(res, 404, { error: "note_not_found" });
      }

      const current = await pool.query(
        `select id, project_id, title, linked_note_id, note_managed_title
                , due_at, done
           from project_todos
          where id=$1 and owner_user_id=$2
          limit 1`,
        [id, userId]
      );
      const cur = current.rows[0];
      if (!cur) return jsonError(res, 404, { error: "not_found" });

      const nextTitle = title != null ? (title || "Todo") : cur.title;
      const nextDueAt = hasDue ? dueParsed : cur.due_at;
      const nextDone = done != null ? done : !!cur.done;
      const nextLinkedNoteId = linkedNoteId != null ? (linkedNoteId || null) : cur.linked_note_id;
      const { rows } = await pool.query(
        `update project_todos
            set title=$1,
                due_at=$2,
                done=$3,
                linked_note_id=$4,
                updated_at=now()
          where id=$5 and owner_user_id=$6
          returning id, project_id, title, due_at, done, linked_note_id`,
        [
          nextTitle,
          nextDueAt,
          nextDone,
          nextLinkedNoteId,
          id,
          userId,
        ]
      );
      const r = rows[0];
      await pool.query(`update projects set updated_at=now() where id=$1 and owner_user_id=$2`, [r.project_id, userId]);

      const shouldRename = !!(cur.note_managed_title && r.linked_note_id && (cur.title !== r.title));
      if (shouldRename) {
        const p = await pool.query(`select title from projects where id=$1 and owner_user_id=$2 limit 1`, [r.project_id, userId]);
        const projectTitle = p.rows[0]?.title || "";
        await pool.query(
          `update notes set title=$1, updated_at=now(), revision=revision+1 where id=$2 and owner_user_id=$3`,
          [`${projectTitle} — ${r.title || "Todo"}`, r.linked_note_id, userId]
        ).catch(() => {});
      }

      return jsonOk(res, {
        todo: {
          id: r.id,
          projectId: r.project_id,
          title: r.title || "",
          dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
          done: !!r.done,
          linkedNoteId: r.linked_note_id || "",
        },
      });
    }

    if (action === "project_todos_add_note") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });

      const tq = await pool.query(
        `select pt.id, pt.project_id, pt.title, pt.linked_note_id, p.title as project_title
           from project_todos pt
           join projects p on p.id = pt.project_id and p.owner_user_id = pt.owner_user_id
          where pt.id=$1 and pt.owner_user_id=$2
          limit 1`,
        [id, userId]
      );
      const t = tq.rows[0];
      if (!t) return jsonError(res, 404, { error: "not_found" });
      if (t.linked_note_id) {
        return jsonOk(res, { note: { id: t.linked_note_id } });
      }

      const noteTitle = `${t.project_title || "Project"} — ${t.title || "Todo"}`.slice(0, 200);
      const noteId = randomId();
      const { rows } = await pool.query(
        `insert into notes (id, owner_user_id, title, content, revision) values ($1,$2,$3,$4,1)
         returning id, title, revision, updated_at`,
        [noteId, userId, noteTitle, ""]
      );

      await pool.query(
        `update project_todos
            set linked_note_id=$1, note_managed_title=true, updated_at=now()
          where id=$2 and owner_user_id=$3`,
        [noteId, id, userId]
      );
      await pool.query(`update projects set updated_at=now() where id=$1 and owner_user_id=$2`, [t.project_id, userId]);
      const r = rows[0];
      return jsonOk(res, {
        note: {
          id: r.id,
          title: r.title,
          revision: Number(r.revision),
          updatedAt: new Date(r.updated_at).toISOString(),
        },
      });
    }

    if (action === "lists_create") {
      const projectId = String(req.query.projectId || "");
      if (!projectId) return jsonError(res, 400, { error: "missing_project_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });
      const title = String(req.body?.title || "").trim() || "List";
      if (title.length > 200) return jsonError(res, 400, { error: "title_too_long" });

      const ok = await pool.query(`select 1 from projects where id=$1 and owner_user_id=$2 limit 1`, [projectId, userId]);
      if (!ok.rows[0]) return jsonError(res, 404, { error: "not_found" });

      const id = randomId();
      const { rows } = await pool.query(
        `insert into project_lists (id, project_id, owner_user_id, title)
         values ($1,$2,$3,$4)
         returning id, title, created_at`,
        [id, projectId, userId, title]
      );
      await pool.query(`update projects set updated_at=now() where id=$1 and owner_user_id=$2`, [projectId, userId]);
      const r = rows[0];
      return jsonOk(res, { list: { id: r.id, title: r.title, createdAt: new Date(r.created_at).toISOString() } });
    }

    if (action === "todos_create") {
      const listId = String(req.query.listId || "");
      if (!listId) return jsonError(res, 400, { error: "missing_list_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });

      const notes = String(req.body?.notes || "");
      if (notes.length > 200000) return jsonError(res, 400, { error: "notes_too_long" });
      const recurring = String(req.body?.recurring || "");
      if (recurring.length > 200) return jsonError(res, 400, { error: "recurring_too_long" });

      const dueParsed = parseOptionalDateOnlyToUtcMidnight(req.body?.dueAt);
      if (dueParsed === undefined) return jsonError(res, 400, { error: "bad_due_date" });

      const lq = await pool.query(
        `select id, project_id from project_lists where id=$1 and owner_user_id=$2 limit 1`,
        [listId, userId]
      );
      const lrow = lq.rows[0];
      if (!lrow) return jsonError(res, 404, { error: "not_found" });

      const id = randomId();
      const { rows } = await pool.query(
        `insert into todos (id, list_id, project_id, owner_user_id, due_at, recurring, notes)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, list_id, due_at, recurring, notes, created_at`,
        [id, listId, lrow.project_id, userId, dueParsed, recurring, notes]
      );
      await pool.query(`update projects set updated_at=now() where id=$1 and owner_user_id=$2`, [lrow.project_id, userId]);
      await pool.query(`update project_lists set updated_at=now() where id=$1 and owner_user_id=$2`, [listId, userId]);
      const r = rows[0];
      return jsonOk(res, {
        todo: {
          id: r.id,
          listId: r.list_id,
          dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
          recurring: r.recurring || "",
          notes: r.notes || "",
          createdAt: new Date(r.created_at).toISOString(),
        },
      });
    }

    if (action === "todos_update") {
      const id = String(req.query.id || "");
      if (!id) return jsonError(res, 400, { error: "missing_id" });
      if (req.method !== "POST") return jsonError(res, 405, { error: "method_not_allowed" });

      const notes = String(req.body?.notes || "");
      if (notes.length > 200000) return jsonError(res, 400, { error: "notes_too_long" });
      const recurring = String(req.body?.recurring || "");
      if (recurring.length > 200) return jsonError(res, 400, { error: "recurring_too_long" });

      const dueParsed = parseOptionalDateOnlyToUtcMidnight(req.body?.dueAt);
      if (dueParsed === undefined) return jsonError(res, 400, { error: "bad_due_date" });

      const { rows } = await pool.query(
        `update todos
            set due_at=$1, recurring=$2, notes=$3, updated_at=now()
          where id=$4 and owner_user_id=$5
          returning id, list_id, project_id`,
        [dueParsed, recurring, notes, id, userId]
      );
      const r = rows[0];
      if (!r) return jsonError(res, 404, { error: "not_found" });
      await pool.query(`update projects set updated_at=now() where id=$1 and owner_user_id=$2`, [r.project_id, userId]);
      await pool.query(`update project_lists set updated_at=now() where id=$1 and owner_user_id=$2`, [r.list_id, userId]);
      return jsonOk(res, {});
    }

    return jsonError(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("api error", { action }, e);
    return jsonError(res, 500, { error: "server_error" });
  }
}

app.all("/api", handleApi);
// Compatibility alias for older clients that still call /api/api.php
app.all("/api/api.php", handleApi);

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[fufnotes] listening on :${PORT}`);
});

// Best-effort schema init on boot so deploys bring new tables live quickly.
// Keep non-fatal: the app already runs ensureSchema per-request.
void (async () => {
  if (!DATABASE_URL) return;
  for (let i = 0; i < 15; i++) {
    try {
      await ensureSchema();
      console.log("[fufnotes] schema ok");
      return;
    } catch (e) {
      if (i === 0) console.warn("[fufnotes] schema init failed; will retry", e?.message || e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.warn("[fufnotes] schema init still failing after retries; API will keep retrying per-request");
})();
