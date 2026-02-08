# Passhroom app integration (minimal guide)

This is a super minimal guide for hooking up an app to use Passhroom for auth.

The goal:
- Your app supports **multiple users**
- Each user has **separate private data** in your app

## 0) One-time setup (in Passhroom Admin → Apps)

Create an app in Passhroom:
- **App ID** (`client_id`): a short identifier you choose (example: `my-app`)
- **Callback URL** (`redirect_uri`): the URL in *your app* that receives `?code=…&state=…`
- Copy the one-time **App secret** (`client_secret`) into your app config (server-side only)

Suggested env vars in your app:
- `PASSHROOM_BASE_URL=https://passhroom.example.com`
- `PASSHROOM_CLIENT_ID=my-app`
- `PASSHROOM_CLIENT_SECRET=...` (server-only)
- `PASSHROOM_CALLBACK_URL=https://yourapp.com/auth/passhroom/callback`

## 1) Start sign-in (user enters email)

When the user types their email in your app, your **server** calls Passhroom:

`POST {PASSHROOM_BASE_URL}/v1/auth/start`

```json
{
  "client_id": "my-app",
  "email": "user@example.com",
  "redirect_uri": "https://yourapp.com/auth/passhroom/callback",
  "state": "random_string_you_generate"
}
```

Notes:
- Generate a random `state` and store it temporarily (simplest: in an httpOnly cookie or your server session).
- Passhroom emails the user both:
  - A magic link
  - A sign-in code (a random mushroom common name)

The user can either:
- Click the magic link, or
- Paste the code into your app (recommended)

Using either option invalidates the other.

## 2) Handle the callback (your app receives code + state)

After the user completes sign-in (via magic link or via the code entry page), the browser is redirected to your callback URL:

`GET /auth/passhroom/callback?code=...&state=...`

If the user is using **copy/paste**, your app can also accept the code directly:

`POST /auth/passhroom/code { code: "..." }`

In that case, your server skips the callback route and goes straight to the token exchange.

Your server must:
1) **Verify `state`** matches what you generated (CSRF protection)
2) Exchange `code` for the user identity by calling Passhroom

`POST {PASSHROOM_BASE_URL}/v1/auth/token`

```json
{
  "client_id": "my-app",
  "client_secret": "YOUR_SERVER_SECRET",
  "code": "CODE_FROM_QUERYSTRING",
  "redirect_uri": "https://yourapp.com/auth/passhroom/callback"
}
```

Response:

```json
{
  "user_id": "uuid",
  "email": "user@example.com",
  "issued_at": "2026-02-07T...",
  "expires_in": 900
}
```

Important:
- Passhroom proves **who** the user is.
- Your app should create its own session/cookie after this succeeds.

## 3) Create your app session

After `/v1/auth/token` succeeds:
- Create a session in your app (cookie/session/JWT—whatever you already use)
- Store at least the Passhroom `user_id`

Example session fields:
- `session.userId = response.user_id`
- `session.email = response.email` (optional)

## 4) Enforce private data per user

In your app’s database, every private row should have an owner field, for example:
- `owner_user_id` = Passhroom `user_id`

Rule of thumb:
- Every read query includes: `WHERE owner_user_id = session.userId`
- Every insert sets: `owner_user_id = session.userId`

Examples:
- Fetch notes: `SELECT * FROM notes WHERE owner_user_id = $1`
- Insert note: `INSERT INTO notes (owner_user_id, body) VALUES ($1, $2)`

That’s what guarantees “each user has their own separate private data”.

## 5) Common gotchas

- `redirect_uri` must **exactly match** an allowlisted Callback URL in Passhroom Apps.
- Keep `client_secret` **server-side only** (never ship it to browsers).
- If you change your app domain/path, update the allowlist in Passhroom.
