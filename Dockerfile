FROM node:20-alpine

# Bitwarden CLI (talks to our self-hosted Vaultwarden instance).
# Pinned, NOT @latest: the newest official CLI can crash (WASM panic during
# decrypt) against an older self-hosted Vaultwarden API. Tested working
# against Vaultwarden 2025.12.0 — see README "Bekende valkuil".
RUN npm install -g @bitwarden/cli@2025.12.1

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium
COPY server.js login.js ./

EXPOSE 3000
CMD ["node", "server.js"]
