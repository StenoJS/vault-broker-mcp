# Slim Node 22 image. The Bitwarden CLI (2025.12.x) needs Node >= 20.19
# (it require()s an ES module); the old Playwright jammy image shipped
# Node 20.18 and `bw` crashed there with ERR_REQUIRE_ESM before it could log in.
# Playwright's Chromium is NOT included: the optional `login` tool
# (ENABLE_LOGIN=true) needs an image that has it — see README.
FROM node:22-bookworm-slim

# Bitwarden CLI (talks to our self-hosted Vaultwarden instance).
# Pinned, NOT @latest: the newest official CLI can crash (WASM panic during
# decrypt) against an older self-hosted Vaultwarden API. Tested working
# against Vaultwarden 2025.12.0 — see README "Bekende valkuil".
RUN npm install -g @bitwarden/cli@2025.12.1

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force
COPY *.js ./

# Run unprivileged; `bw` keeps its session data under $HOME.
USER node
ENV HOME=/home/node
EXPOSE 3000
CMD ["node", "server.js"]
