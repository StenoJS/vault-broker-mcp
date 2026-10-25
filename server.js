// vault-broker-mcp — scoped MCP broker for Vaultwarden credentials.
//
// Hard rule this file exists to enforce: the plaintext value of any
// credential NEVER appears in an MCP tool response or a log line. Tools
// return either non-secret metadata, or a success/failure result after using
// a secret internally. If you're tempted to add a field like `password` to a
// response object, don't — that defeats the entire point of this service.
//
// Tools:
//   list_credentials   always   metadata only (name, username, URIs)
//   create_credential  always   generates the password server-side and stores
//                               it in the shared collection; never returns it
//   inject_secret      opt-in   writes a stored secret into ONE variable of an
//                               allow-listed Portainer stack; never returns it
//   login              opt-in   (ENABLE_LOGIN=true) fills a web login form via
//                               Playwright; off by default

import express from "express";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { generatePassword } from "./generate.js";
import { injectIntoStack, parseAllowedStacks, VAR_NAME_RE } from "./portainer.js";

const run = promisify(execFile);

const {
  BW_SERVER_URL,
  BW_CLIENTID,
  BW_CLIENTSECRET,
  BW_MASTERPASSWORD,
  VAULTWARDEN_ORG_ID,
  VAULTWARDEN_COLLECTION_ID,
  MCP_SSE_SECRET,
  PORTAINER_URL,
  PORTAINER_API_KEY,
  INJECT_ALLOWED_STACKS,
  ENABLE_LOGIN,
} = process.env;

for (const [name, val] of Object.entries({
  BW_SERVER_URL, BW_CLIENTID, BW_CLIENTSECRET, BW_MASTERPASSWORD,
  VAULTWARDEN_ORG_ID, VAULTWARDEN_COLLECTION_ID, MCP_SSE_SECRET,
})) {
  if (!val) {
    console.error(`Missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
}

const allowedStacks = parseAllowedStacks(INJECT_ALLOWED_STACKS);
const injectEnabled = Boolean(PORTAINER_URL && PORTAINER_API_KEY && allowedStacks.size > 0);
const loginEnabled = ENABLE_LOGIN === "true";

// --- Bitwarden CLI session handling -----------------------------------
// Session key lives only in memory for this process, never logged, never
// returned in any tool response.
let bwSessionKey = null;

async function bwUnlock() {
  if (bwSessionKey) return bwSessionKey;

  await run("bw", ["config", "server", BW_SERVER_URL]);

  try {
    await run("bw", ["login", "--apikey"], {
      env: { ...process.env, BW_CLIENTID, BW_CLIENTSECRET },
    });
  } catch (err) {
    // "You are already logged in" is not fatal — bw exits non-zero for it.
    if (!/already logged in/i.test(err.stderr ?? "")) throw err;
  }

  const { stdout } = await run("bw", ["unlock", "--passwordenv", "BW_MASTERPASSWORD", "--raw"], {
    env: { ...process.env, BW_MASTERPASSWORD },
  });
  bwSessionKey = stdout.trim();

  await run("bw", ["sync", "--session", bwSessionKey]);
  return bwSessionKey;
}

// Runs `bw` with the JSON payload on stdin, so secrets never appear in the
// process arguments.
async function bwWithStdin(args, input) {
  const p = run("bw", args);
  p.child.stdin.end(input);
  return p;
}

// --- Scope guard ------------------------------------------------------
// Everything this service touches must be a login-type item that lives in
// the one shared organisation + collection. Cards, identities and notes are
// never listed, used or modified — not even as metadata.
function inScope(item) {
  return (
    item?.type === 1 &&
    item.organizationId === VAULTWARDEN_ORG_ID &&
    Array.isArray(item.collectionIds) &&
    item.collectionIds.includes(VAULTWARDEN_COLLECTION_ID)
  );
}

async function listScopedItems(session) {
  const { stdout } = await run("bw", [
    "list", "items",
    "--organizationid", VAULTWARDEN_ORG_ID,
    "--collectionid", VAULTWARDEN_COLLECTION_ID,
    "--session", session,
  ]);
  return JSON.parse(stdout).filter((item) => item.type === 1);
}

async function getScopedLogin(credentialId, session) {
  const { stdout } = await run("bw", ["get", "item", credentialId, "--session", session]);
  const item = JSON.parse(stdout);
  return inScope(item) ? item : null;
}

const text = (obj, isError = false) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

// Tool errors must not echo child-process output, which could contain the
// payload. Report a fixed message plus the tool name.
const failed = (what) => text(`${what} failed. Check the broker's container logs.`, true);

// --- MCP server ----------------------------------------------------------

// A McpServer instance can only be connected to ONE transport. Every SSE
// connection therefore gets its own instance from this factory; sharing one
// instance crashes the process on the second (re)connect.
const loginModule = loginEnabled ? await import("./login.js") : null;

if (!injectEnabled) {
  console.log("inject_secret disabled (set PORTAINER_URL, PORTAINER_API_KEY and INJECT_ALLOWED_STACKS to enable)");
}
if (!loginEnabled) console.log("login tool disabled (ENABLE_LOGIN is not 'true')");

function createServer() {
const server = new McpServer({ name: "vault-broker-mcp", version: "0.2.0" });

server.registerTool(
  "list_credentials",
  {
    title: "List shared credentials",
    description:
      "Lists login items in the 'Gedeeld met Claude' Vaultwarden collection. " +
      "Returns only non-secret metadata (id, name, username, URLs) — never the password.",
    inputSchema: {},
  },
  async () => {
    const session = await bwUnlock();
    const items = (await listScopedItems(session)).map((item) => ({
      id: item.id,
      name: item.name,
      username: item.login?.username ?? null,
      uris: (item.login?.uris ?? []).map((u) => u.uri),
      // Deliberately no `password` field, even though `bw list items`
      // includes it in its raw output — strip it here, don't rely on the
      // caller not asking for it.
    }));
    return text(items);
  }
);

server.registerTool(
  "create_credential",
  {
    title: "Create a credential with a generated password",
    description:
      "Generates a strong random password inside the broker and stores it as a new login " +
      "item in the shared collection. The password is NOT returned. Refuses if an item " +
      "with the same name already exists. Use inject_secret to put it somewhere.",
    inputSchema: {
      name: z.string().min(1).max(100),
      username: z.string().max(200).optional(),
      url: z.string().url().optional(),
      length: z.number().int().min(16).max(128).optional(),
      symbols: z.boolean().optional(),
    },
  },
  async ({ name, username, url, length, symbols }) => {
    try {
      const session = await bwUnlock();

      const existing = await listScopedItems(session);
      if (existing.some((i) => i.name.trim().toLowerCase() === name.trim().toLowerCase())) {
        return text(`An item named "${name}" already exists in the collection; choose another name.`, true);
      }

      const password = generatePassword({ length: length ?? 24, symbols: symbols ?? false });
      const payload = {
        organizationId: VAULTWARDEN_ORG_ID,
        collectionIds: [VAULTWARDEN_COLLECTION_ID],
        folderId: null,
        type: 1,
        name,
        notes: null,
        favorite: false,
        fields: [],
        reprompt: 0,
        login: {
          username: username ?? null,
          password,
          totp: null,
          uris: url ? [{ match: null, uri: url }] : [],
        },
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
      const { stdout } = await bwWithStdin(["create", "item", "--session", session], encoded);
      const created = JSON.parse(stdout);

      return text({
        created: true,
        id: created.id,
        name: created.name,
        username: created.login?.username ?? null,
        uris: (created.login?.uris ?? []).map((u) => u.uri),
        passwordStored: true,
        passwordLength: password.length,
      });
    } catch {
      return failed("create_credential");
    }
  }
);

if (injectEnabled) {
  server.registerTool(
    "inject_secret",
    {
      title: "Inject a stored secret into a Portainer stack variable",
      description:
        "Writes the stored password of a credential into ONE environment variable of an " +
        "allow-listed standalone Portainer stack (which redeploys that stack). The value is " +
        "never returned. The stack's compose file must reference the variable as ${NAME}. " +
        `Allowed stack IDs: ${[...allowedStacks].join(", ")}.`,
      inputSchema: {
        credentialId: z.string(),
        stackId: z.number().int().positive(),
        variable: z.string().regex(VAR_NAME_RE, "UPPER_SNAKE_CASE, 2-64 chars"),
      },
    },
    async ({ credentialId, stackId, variable }) => {
      if (!allowedStacks.has(stackId)) {
        return text(`Stack ${stackId} is not on the allow-list (INJECT_ALLOWED_STACKS).`, true);
      }
      try {
        const session = await bwUnlock();
        const item = await getScopedLogin(credentialId, session);
        if (!item) return text("Credential not found in the shared collection.", true);
        const password = item.login?.password;
        if (!password) return text("Credential has no password field.", true);

        const result = await injectIntoStack({
          baseUrl: PORTAINER_URL,
          apiKey: PORTAINER_API_KEY,
          stackId,
          varName: variable,
          value: password,
        });
        return text({
          injected: true,
          stack: result.stackName,
          variable,
          referencedInCompose: result.referencedInCompose,
          note: result.referencedInCompose
            ? "Stack is being redeployed with the new value."
            : "Variable was set, but the compose file does not reference it yet.",
        });
      } catch (err) {
        // err.message is built from HTTP status codes only (see portainer.js).
        return text(`inject_secret failed: ${err.message}`, true);
      }
    }
  );
}

if (loginEnabled) {
  const { performLogin } = loginModule;
  server.registerTool(
    "login",
    {
      title: "Log in to a website using a stored credential",
      description:
        "Given a credential ID (from list_credentials) and an optional target URL " +
        "(defaults to the credential's stored URI), logs in using Playwright. " +
        "The password is used internally and never returned — only success/failure.",
      inputSchema: {
        credentialId: z.string(),
        url: z.string().url().optional(),
      },
    },
    async ({ credentialId, url }) => {
      const session = await bwUnlock();
      const item = await getScopedLogin(credentialId, session);
      if (!item) return text("Credential not found in the shared collection.", true);

      const password = item.login?.password;
      const username = item.login?.username;
      if (!password) return text("Credential has no password field.", true);

      const targetUrl = url ?? item.login?.uris?.[0]?.uri;
      if (!targetUrl) return text("No URL given and credential has none stored.", true);

      // `password` (and `username`) live only in this function's local scope
      // and inside performLogin()/Playwright.
      const result = await performLogin({ url: targetUrl, username, password });
      return text(
        { success: result.success, finalUrl: result.finalUrl, reason: result.reason },
        !result.success
      );
    }
  );
}

return server;
}

// --- SSE transport, secret as query param (see README "Beveiligingsnotities") ---

function keyMatches(provided) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(MCP_SSE_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
const transports = new Map();

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get("/sse", async (req, res) => {
  if (!keyMatches(req.query.key)) {
    res.status(401).end();
    return;
  }
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await createServer().connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const transport = transports.get(req.query.sessionId);
  if (!transport) {
    res.status(400).send("Unknown session");
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`vault-broker-mcp listening on :${port}`));
