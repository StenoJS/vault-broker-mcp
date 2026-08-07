#!/usr/bin/env bash
# Local smoke test for list_credentials — never echoes the session key or
# any password field. Reads secrets from .env via `source`, so they never
# appear as literal text in this script or in any command Claude writes.
set -euo pipefail

cd "$(dirname "$0")"
set -a
source .env
set +a

bw() { npx --yes @bitwarden/cli@2025.12.1 "$@"; }

bw logout >/dev/null 2>&1 || true
bw config server "$BW_SERVER_URL" >/dev/null

# Ignore "already logged in" failures
bw login --apikey >/dev/null 2>&1 || true

SESSION="$(bw unlock --passwordenv BW_MASTERPASSWORD --raw)"

bw sync --session "$SESSION" >/dev/null

bw list items \
  --organizationid "$VAULTWARDEN_ORG_ID" \
  --collectionid "$VAULTWARDEN_COLLECTION_ID" \
  --session "$SESSION" \
  | node -e '
      const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
      // Login-only (type 1) — mirrors server.js, keep in sync.
      const filtered = data.filter(i => i.type === 1).map(i => ({
        id: i.id,
        name: i.name,
        username: i.login?.username ?? null,
        uris: (i.login?.uris ?? []).map(u => u.uri),
      }));
      console.log(JSON.stringify(filtered, null, 2));
    '
