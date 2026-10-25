# vault-broker-mcp

Kleine, zelf-gehoste MCP-server die Claude *scoped, indirecte* toegang geeft tot
credentials in Vaultwarden — zonder dat Claude ooit een plaintext wachtwoord
in zijn context krijgt.

## Waarom deze opzet

Claude mag geen wachtwoorden lezen en zelf in formulieren typen. Deze broker
lost dat op door **acties** aan te bieden in plaats van **waardes**: Claude
kiest *welk* item gebruikt wordt, de broker is de enige die de waarde ooit ziet.

## Tools (v0.2)

| Tool | Standaard | Wat het doet |
| --- | --- | --- |
| `list_credentials` | aan | Alleen metadata (id, naam, gebruikersnaam, URL's) van login-items in de gedeelde collectie. Nooit een wachtwoord. |
| `create_credential` | aan | Genereert een sterk wachtwoord **in de broker** en slaat het op als nieuw login-item in de collectie. Geeft het wachtwoord niet terug. Weigert een bestaande naam (geen overschrijven). |
| `inject_secret` | alleen met `PORTAINER_URL`, `PORTAINER_API_KEY` en `INJECT_ALLOWED_STACKS` | Zet het opgeslagen wachtwoord in **één** variabele van een stack uit de allow-list (herdeployt die stack). Geeft de waarde niet terug. Alleen standalone compose-stacks, geen git-stacks. |
| `login` | **uit** (`ENABLE_LOGIN=true` om aan te zetten) | Vult een webformulier in via Playwright en geeft alleen succes/falen terug. Werkt alleen in een image mét Playwright/Chromium; de standaard-image (`node:22-bookworm-slim`) heeft die niet. |

Gemeenschappelijke regels:

- Alles is beperkt tot **één organisatie + één collectie** en tot items van het
  type *login*. Kaarten, identiteiten en notities worden nooit getoond of gebruikt.
- Een geheim komt nooit in een tool-antwoord, foutmelding of logregel, en niet in
  de argumenten van een `bw`-proces (payload gaat via stdin).
- Transport is **Streamable HTTP, stateless**: `POST /mcp?key=...`. Elk verzoek
  krijgt een eigen `McpServer`-instantie (één gedeelde instantie liet de
  container crashen bij de tweede verbinding). Legacy SSE (`/sse`,
  `/messages`) wordt niet meer geserveerd. De variabele heet nog
  `MCP_SSE_SECRET` om bestaande stack-omgevingen niet te breken.

## Vaultwarden-kant (handmatig, door Steno)

Dit deel kan Claude niet voor je doen (accounts aanmaken / wachtwoorden
instellen is voor Claude verboden terrein, ook met toestemming).

1. In de bestaande Vaultwarden-instance (container `app_a0d7b954_bitwarden`,
   poort 7277 op het `hassio`-netwerk — waarschijnlijk ontsloten via
   `secure.steno.nl`, even checken in NPM): maak een organisatie **of**
   hergebruik een bestaande, met een nieuwe collectie, bijv. `Gedeeld met Claude`.
2. Maak een aparte login aan voor de agent-identiteit, bijv.
   `steenhagen.jeroen+claude@gmail.com`, met een eigen sterk wachtwoord + 2FA.
3. Nodig die identiteit uit in de organisatie met toegang tot **alleen** de
   collectie `Gedeeld met Claude`.
4. Zet de items die je wilt delen in die collectie (kopiëren/delen, niet per
   se verplaatsen).
5. Maak voor die identiteit een **API key** aan (Account settings → Security →
   Keys) — dat is wat de broker gebruikt om in te loggen, niet het master
   password rechtstreeks.
6. Geef mij: de vault-URL, de organisatie-ID en de collectie-ID (allemaal
   niet-geheime waardes, te vinden in de URL/admin-UI). De echte secrets
   (API key, master password) zet je zelf in `.env` op de server — die stuur
   je niet naar mij door.

## Broker-kant (dit scaffold)

- `Dockerfile` — `node:22-bookworm-slim`, installeert de Bitwarden CLI (`bw`), draait als gebruiker `node`.
- `server.js` — MCP-server (SSE), tools: zie tabel hierboven.
- `generate.js` / `portainer.js` — wachtwoordgenerator en Portainer-injectie.
- `test/` — `npm test` (unit + end-to-end met een nep-`bw` en nep-Portainer).
- `docker-compose.yml` — draait op het gedeelde `hassio`-netwerk, net als je
  andere self-hosted MCP-servers. **Niet** publiek via NPM ontsluiten — dit
  is een secrets-gateway, alleen intern/via Tailscale bereikbaar houden.

### Nog te doen voordat dit bruikbaar is

- [ ] `.env` invullen (zie `.env.example`) zodra stap 1–6 hierboven klaar zijn.
- [ ] `create_credential` (aanmaken in een organisatie-collectie via
  `bw create item`) is getest tegen een nep-`bw`, **nog niet tegen de echte
  Vaultwarden**. Eerste echte test: één item aanmaken en in de UI controleren.
- [ ] Testen met één laag-risico item voordat er meer gedeeld wordt.
- [ ] Pas als dit werkt: als Portainer-stack deployen (met jouw akkoord, dit
  raak ik niet zelf aan zonder te vragen).

## Bekende valkuil: bw CLI-versie vs. Vaultwarden-versie

`@bitwarden/cli@latest` (getest: 2026.7.0) crasht met een WASM-panic
("invalid type: JsValue(Object(...)), expected a string") bij `bw list items`
tegen onze Vaultwarden-instance (versie 2025.12.0, te checken via
`GET /api/config`, publiek/niet-geheim endpoint). Oorzaak: de nieuwste
officiële CLI verwacht een response-schema dat deze Vaultwarden-versie nog
niet levert.

**Fix**: CLI-versie dicht bij de serverversie pinnen — getest en werkend met
`@bitwarden/cli@2025.12.1`. Dockerfile en `test-list-credentials.sh` gebruiken
deze pin. Bij een Vaultwarden-upgrade: eerst opnieuw testen voordat je de
CLI-pin optrekt.

**Tweede addertje**: `bw config server` weigert te wijzigen zolang de CLI al
ingelogd is ("Logout required before server config update") — het lokale
`bw`-datadir (`~/.config/Bitwarden CLI` / `%APPDATA%\Bitwarden CLI`) onthoudt
de sessie ook tussen verschillende CLI-versies in. Altijd `bw logout`
(fouten negeren) vóór `bw config server` in scripts.

**Vierde addertje (opgelost in v0.2)**: de `bw`-CLI 2025.12.x heeft Node ≥ 20.19 nodig. In de oude `playwright:v1.48.0-jammy`-image (Node 20.18) crashte elk `bw`-commando met `ERR_REQUIRE_ESM`, dus de broker kon nooit inloggen. Daarom nu `node:22-bookworm-slim`.

**Derde addertje** (historisch, gold voor de oude image): `node:20-alpine` als base image laat de build wel
slagen, maar Playwright's Chromium draait niet betrouwbaar op musl
libc/Alpine, en `playwright install --with-deps` kent alleen `apt`, geen
`apk`. Ontdekt pas bij de eerste Portainer-deploy (lokaal getest zonder
Docker, dus dit verschil bleef onzichtbaar tot de echte build). Fix:
`mcr.microsoft.com/playwright:v1.48.0-jammy` als base image (zelfde familie
als `playwright-amazon-mcp`/`playwright-bol-mcp`), Chromium + OS-deps al
ingebakken.

## Beveiligingsnotities

- Het MCP-endpoint (`/mcp`) verwacht het secret als **query-param**
  (`?key=...`), niet als pad-prefix. In NPM staat er bovendien dezelfde
  sleutelcontrole plus de Anthropic-allowlist voor.
- `list_credentials` filtert serverside altijd het `login.password`-veld
  eruit, ook als de Bitwarden CLI het teruggeeft — nooit vertrouwen op "de
  aanroeper vraagt er toch niet om".
- Container draait met een `.env`-bestand dat **niet** in git komt
  (`.gitignore` sluit 'm uit).
