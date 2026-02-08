# fufnotes (JS + Postgres)

This repo has been refactored to:

- Frontend: static SPA in `public/`
- Backend: Node (Express) app in `server/`
- Storage: Postgres (Docker)
- Auth: Passhroom magic-link sign-in + app session cookie

Auth is handled via Passhroom magic-link sign-in:
- The user enters their email
- The server calls Passhroom to send the magic link
- On callback, the server exchanges the code for a Passhroom `user_id` and sets an httpOnly session cookie

## Docs

- [docs/login-flow-user-stories.md](docs/login-flow-user-stories.md)
- [docs/notes-view-user-stories.md](docs/notes-view-user-stories.md)
- [docs/projects-and-lists-user-stories.md](docs/projects-and-lists-user-stories.md)
- [docs/navigation-user-stories.md](docs/navigation-user-stories.md)
- [docs/pashroom-app-integration-guide.md](docs/pashroom-app-integration-guide.md)
- [docs/servertron/README.md](docs/servertron/README.md)
- [docs/servertron-new-app-database.md](docs/servertron-new-app-database.md)

## Folder layout

- `public/` static app (`index.html`, `app.js`, `styles.css`, `assets/`)
- `server/` Node server (serves SPA + `/api`)
- `scripts/servertron/` Servertron automation (deploy, nginx+SSL, db backup/restore)

Images are linked via markdown (external URLs). No file uploads/attachments.

Postgres is the source of truth; no `data/` writes are required.

## Local dev

You need a Postgres database and `DATABASE_URL`.

- For quick local smoke testing without Passhroom, set `DEV_USER_ID` (the server will treat that as the authenticated user).

Example (env vars):

```bash
export DEV_USER_ID=dev-user
export DATABASE_URL='postgres://fufnotes:pass@127.0.0.1:5432/fufnotes'
npm run dev
```

## Tailwind CSS build

Tailwind is only used at build time.

```bash
npm run build:css
```

This generates `public/styles.css`.

## Servertron deploy (automated)

The intended deployment is on Servertron behind nginx, with SSL managed by certbot.

See also: [docs/servertron/README.md](docs/servertron/README.md)

1) Bootstrap everything (directory + .env + deploy + nginx + SSL):

```bash
npm run servertron:bootstrap
```

2) Or run individually:

```bash
npm run servertron:deploy
npm run servertron:setup-domain-ssl -- --domain "$DOMAIN" --proxy-pass "$PROXY_PASS"
```

Auth expectation:

- Server-side env must include `PASSHROOM_CLIENT_SECRET`.
- The API enforces row ownership by `owner_user_id` (the Passhroom `user_id`).

## Conflict behavior (optimistic concurrency)

Each note has a `revision` integer in Postgres.

- Client loads a note and remembers `baseRevision`.
- Client saves with `{ baseRevision }`.
- Server compares `baseRevision` with current `revision`.
  - If they match: save succeeds and server increments `revision`.
  - If they mismatch: server returns HTTP `409` with `{ error:"conflict", meta, content }`.

The UI then offers:

- **Use server version**: replace local content with server content.
- **Overwrite with mine**: re-save using the server revision + `force:true`.
- **Save mine as copy**: creates a new note and saves your content there.

## Notes

- Images are linked using markdown: `![alt](https://example.com/image.png)`.
- Markdown preview is a small built-in parser in `public/app.js` (no external vendored library).

## Troubleshooting

- If you see “Not authenticated”: you likely don’t have a valid session cookie yet. Use the email sign-in flow, or set `DEV_USER_ID` in dev.
- If API returns `db_schema` or `server_error`: confirm `DATABASE_URL` is set and reachable.
