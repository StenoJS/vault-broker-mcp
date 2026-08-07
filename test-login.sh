#!/usr/bin/env bash
# Local smoke test for the login tool. Same discipline as
# test-list-credentials.sh: secrets flow from .env / the Bitwarden item
# straight into shell/env variables and Node's env — never printed, never
# written literally into this script.
set -euo pipefail

cd "$(dirname "$0")"
set -a
source .env
set +a

CREDENTIAL_ID="${1:?Usage: ./test-login.sh <credentialId>}"

bw() { npx --yes @bitwarden/cli@2025.12.1 "$@"; }

bw logout >/dev/null 2>&1 || true
bw config server "$BW_SERVER_URL" >/dev/null
bw login --apikey >/dev/null 2>&1 || true
SESSION="$(bw unlock --passwordenv BW_MASTERPASSWORD --raw)"
bw sync --session "$SESSION" >/dev/null

ITEM_JSON="$(bw get item "$CREDENTIAL_ID" --session "$SESSION")"

extract() {
  node -e "const i=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write($1||'')" <<< "$ITEM_JSON"
}

LOGIN_URL="$(extract 'i.login.uris && i.login.uris[0] && i.login.uris[0].uri')"
LOGIN_USERNAME="$(extract 'i.login.username')"
LOGIN_PASSWORD="$(extract 'i.login.password')"

LOGIN_URL="$LOGIN_URL" LOGIN_USERNAME="$LOGIN_USERNAME" LOGIN_PASSWORD="$LOGIN_PASSWORD" node test-login.mjs
