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
