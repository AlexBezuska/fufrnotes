# Servertron: New App Database (Postgres) — the Passhroom way

This guide documents the **exact pattern** used by Passhroom on Servertron, generalized so you can spin up a new Postgres DB for a new app without the permissions / role / restore weirdness.

It is specific to your Servertron layout:

- Host: `<your-server-host>`
- Root: `<servertron-root>/<app>/`
- Uses `docker compose` projects per app
- Postgres runs **inside Docker**, not exposed to the LAN
- Backups/restores are streamed over SSH and executed **inside the Postgres container**

---

## Why this pattern avoids the common problems

- **No host bind-mount for PGDATA**: we use a **named Docker volume** for `/var/lib/postgresql/data`.
  - This avoids the classic “Postgres can’t `chown`/write its data dir” problems on external/mounted disks.
- **Stable `container_name`**: scripts can reliably `docker exec` the DB container.
  - Without this, Compose may create names like `myapp-myapp-db-1` and your automation becomes fragile.
- **Restore-safe dumps**: we use `pg_dump -Fc` and restore with `pg_restore --clean --if-exists --no-owner --no-acl`.
  - This avoids role/permission mismatch issues when restoring into a fresh container.

---

## Option A (recommended): fully automated scaffold (run from local)

This repo includes a script that creates the server folder, generates a password, writes a minimal compose, and starts Postgres.

Run from your local machine:

- `scripts/servertron/scaffold-postgres-app.sh --app <app-slug>`

Example:

- `scripts/servertron/scaffold-postgres-app.sh --app notes`

What it creates on the server:

- `<servertron-root>/<app>/docker-compose.yml`
- `<servertron-root>/<app>/.env` (chmod `600`, generated password)
- `<servertron-root>/<app>/.env.example`

Overrides (if you want different names):

- `--db-name`, `--db-user`, `--db-container`, `--remote-dir`, `--password-var`

---

## Option B: manual setup (copy/paste)

### 1) Create the app folder

On the server:

- `mkdir -p <servertron-root>/<app>`

### 2) Create `<servertron-root>/<app>/.env`

Use a dedicated var name for the password (pattern: `<APP>_DB_PASSWORD`). Example for `notes`:

```sh
NOTES_DB_PASSWORD=your-long-random-password
```

Ensure permissions:

- `chmod 600 <servertron-root>/<app>/.env`

### 3) Create `<servertron-root>/<app>/docker-compose.yml`

Template (replace `notes` everywhere with your app slug):

```yaml
services:
  notes-db:
    image: postgres:16
    container_name: notes-db
    environment:
      POSTGRES_DB: notes
      POSTGRES_USER: notes
      POSTGRES_PASSWORD: ${NOTES_DB_PASSWORD}
    volumes:
      - notes_db_data:/var/lib/postgresql/data
    networks:
      - notes_internal

volumes:
  notes_db_data:

networks:
  notes_internal:
    driver: bridge
```

### 4) Start the DB

On the server:

```sh
cd <servertron-root>/<app>
docker compose --env-file .env -f docker-compose.yml up -d
```

### 5) Smoke test

```sh
docker exec -it <app>-db psql -U <app> -d <app> -c 'select 1;'
```

---

## Wiring your app container to Postgres

Inside the app’s **API container**, connect using Docker DNS with the **service name** (not the `container_name`):

- Host should be `<app>-db` (the compose service name)
- Port `5432`

Example `DATABASE_URL`:

- `postgres://notes:${NOTES_DB_PASSWORD}@notes-db:5432/notes`

Notes:

- If your app is in the same compose project, put your API service on the same internal network as the DB.
- Don’t publish Postgres ports to the host unless you truly need to.

---

## Backups (one command from your local machine)

This repo’s backup script is now generic via env overrides.

Example:

```sh
SERVER=<user>@<host> \
REMOTE_DIR=<servertron-root>/notes \
DB_CONTAINER=notes-db DB_USER=notes DB_NAME=notes \
OUT=backups/notes-$(date -u +%Y%m%dT%H%M%SZ).dump \
npm run db:backup
```

What it does:

- Runs `pg_dump -Fc` inside the DB container
- Streams the dump over SSH into `./backups/…` locally

---

## Restores (one command from your local machine)

Example (if you have an API container to stop):

```sh
SERVER=<user>@<host> \
REMOTE_DIR=<servertron-root>/notes \
DB_CONTAINER=notes-db DB_USER=notes DB_NAME=notes \
STOP_SERVICE=notes-api \
BACKUP_FILE=backups/notes-YYYYMMDDTHHMMSSZ.dump \
npm run db:restore
```

Example (DB-only project, nothing to stop/start):

```sh
SERVER=<user>@<host> \
REMOTE_DIR=<servertron-root>/notes \
DB_CONTAINER=notes-db DB_USER=notes DB_NAME=notes \
STOP_SERVICE= \
BACKUP_FILE=backups/notes-YYYYMMDDTHHMMSSZ.dump \
npm run db:restore
```

Restore behavior:

- Uses `pg_restore --clean --if-exists --no-owner --no-acl`
- This is meant for “catastrophic restore” scenarios (wipe & restore)

---

## Operational notes (practical gotchas)

- Prefer `docker compose` (plugin) consistently on Servertron.
- Keep the `.env` at the **project root** (`<servertron-root>/<app>/.env`).
- Use a **named volume** for PGDATA. Don’t bind-mount PGDATA onto `<servertron-root>/...` unless you enjoy permissions debugging.
- If you later add your API service, `depends_on` is not readiness; apps should retry DB connections at startup.
