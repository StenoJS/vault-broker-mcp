# NOT node:20-alpine: Playwright's Chromium doesn't run reliably on musl
# libc/Alpine, and `playwright install --with-deps` only knows apt, not apk.
# Use the official Playwright image (same family as playwright-amazon-mcp/
# playwright-bol-mcp) — Chromium + OS deps already baked in, matching our
# pinned `playwright` npm version.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# Bitwarden CLI (talks to our self-hosted Vaultwarden instance).
# Pinned, NOT @latest: the newest official CLI can crash (WASM panic during
# decrypt) against an older self-hosted Vaultwarden API. Tested working
# against Vaultwarden 2025.12.0 — see README "Bekende valkuil".
RUN npm install -g @bitwarden/cli@2025.12.1

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js login.js ./

EXPOSE 3000
CMD ["node", "server.js"]
