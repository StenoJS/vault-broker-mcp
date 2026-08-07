# vault-broker-mcp

Kleine, zelf-gehoste MCP-server die Claude *scoped, indirecte* toegang geeft tot
credentials in Vaultwarden — zonder dat Claude ooit een plaintext wachtwoord
in zijn context krijgt.

## Waarom deze opzet

Claude mag geen wachtwoorden lezen en zelf in formulieren typen. Deze broker
lost dat op door **acties** aan te bieden in plaats van **waardes**:

- `list_credentials` → geeft alleen niet-geheime metadata terug (naam,
  gebruikersnaam, URL). Nooit het wachtwoord-veld.
- `login` → krijgt een credential-ID + doel-URL, haalt het wachtwoord
  *intern* op, vult het formulier zelf in (via Playwright) en geeft alleen
  `{success, url}` terug. Het secret verlaat de container nooit.

Zo blijft de scheiding hard: Claude kiest *welk* item gebruikt wordt, de
broker is de enige die de waarde ooit ziet.

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

- `Dockerfile` — Node 20, installeert de Bitwarden CLI (`bw`).
- `server.js` — MCP-server (SSE), twee tools: `list_credentials`, `login`
  (login is nu een stub met TODO's, zie hieronder).
- `docker-compose.yml` — draait op het gedeelde `hassio`-netwerk, net als je
  andere self-hosted MCP-servers. **Niet** publiek via NPM ontsluiten — dit
  is een secrets-gateway, alleen intern/via Tailscale bereikbaar houden.

### Nog te doen voordat dit bruikbaar is

- [ ] `.env` invullen (zie `.env.example`) zodra stap 1–6 hierboven klaar zijn.
- [ ] `login`-tool afmaken: nu roept hij nog geen echte Playwright-instance
  aan. Meest voor de hand liggend: laten praten met je bestaande
  `playwright-mcp`-containers (`playwright-amazon-mcp`, `playwright-bol-mcp`)
  of een eigen headless Playwright-instance in dezelfde container.
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

Tweede addertje: `bw config server` weigert te wijzigen zolang de CLI al
ingelogd is ("Logout required before server config update") — het lokale
`bw`-datadir (`~/.config/Bitwarden CLI` / `%APPDATA%\Bitwarden CLI`) onthoudt
de sessie ook tussen verschillende CLI-versies in. Altijd `bw logout`
(fouten negeren) vóór `bw config server` in scripts.

## Beveiligingsnotities

- MCP SSE-endpoint verwacht het secret als **query-param** (`?key=...`), niet
  als pad-prefix — zie de bekende valkuil met `ah-mcp` (root-relatieve
  callback-paden breken anders).
- `list_credentials` filtert serverside altijd het `login.password`-veld
  eruit, ook als de Bitwarden CLI het teruggeeft — nooit vertrouwen op "de
  aanroeper vraagt er toch niet om".
- Container draait met een `.env`-bestand dat **niet** in git komt
  (`.gitignore` sluit 'm uit).
