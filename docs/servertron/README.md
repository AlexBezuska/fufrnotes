# Servertron scripts (fufnotes)

Servertron scripts for fufnotes.

- One-command bootstrap: `npm run servertron:bootstrap`
- Deploy app: `npm run servertron:deploy`
	- Safe-by-default: does not delete remote files.
	- Mirror mode (includes deletions): `npm run servertron:deploy -- --mirror`
- Setup domain + SSL: `npm run servertron:setup-domain-ssl -- --domain "$DOMAIN" --proxy-pass "$PROXY_PASS"`
	- Safe-by-default: skips certbot if a cert already exists.
	- Force certbot: `npm run servertron:setup-domain-ssl -- --force-certbot --domain "$DOMAIN" --proxy-pass "$PROXY_PASS"`
- DB backup/restore: `npm run db:backup`, `npm run db:restore`
	- Restore is destructive and requires confirmation: `npm run db:restore -- --yes`

Notes:
- The compose project lives at `$REMOTE_DIR`.
- The nginx site folder lives at `$WEBSERVER_ROOT/site/<domain>/`.

These scripts assume the Servertron layout documented in [../servertron-new-app-database.md](../servertron-new-app-database.md).
