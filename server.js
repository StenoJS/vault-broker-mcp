// vault-broker-mcp — scoped MCP broker for Vaultwarden credentials.
//
// Hard rule this file exists to enforce: the plaintext value of any
// credential NEVER appears in an MCP tool response. Tools return either
// non-secret metadata, or a success/failure result after using a secret
// internally. If you're tempted to add a field like `password` to a
// response object, don't — that defeats the entire point of this service.
//
// STATUS: `list_credentials` and `login` are both functional (assuming
// .env is filled in and the Vaultwarden-side setup from README.md is done).

import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { performLogin } from "./login.js";

const run = promisify(execFile);

const {
  BW_SERVER_URL,
  BW_CLIENTID,
  BW_CLIENTSECRET,
  BW_MASTERPASSWORD,
  VAULTWARDEN_ORG_ID,
  VAULTWARDEN_COLLECTION_ID,
  MCP_SSE_SECRET,
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

// --- MCP server ----------------------------------------------------------

const server = new McpServer({ name: "vault-broker-mcp", version: "0.1.0" });

server.registerTool(
  "list_credentials",
  {
    title: "List shared credentials",
    description:
      "Lists items in the 'Gedeeld met Claude' Vaultwarden collection. " +
      "Returns only non-secret metadata (name, username, URL) — never the password.",
    inputSchema: {},
  },
  async () => {
    const session = await bwUnlock();
    const { stdout } = await run("bw", [
      "list", "items",
      "--organizationid", VAULTWARDEN_ORG_ID,
      "--collectionid", VAULTWARDEN_COLLECTION_ID,
      "--session", session,
    ]);

    const items = JSON.parse(stdout)
      // Only login-type items (Bitwarden/Vaultwarden type 1). Cards (3),
      // identities (4) and secure notes (2) are never listed, let alone
      // used — financial/personal data must never reach the model's
      // context, not even as metadata. This is deliberate, not an
      // oversight: don't "improve" this to be more permissive.
      .filter((item) => item.type === 1)
      .map((item) => ({
        id: item.id,
        name: item.name,
        username: item.login?.username ?? null,
        uris: (item.login?.uris ?? []).map((u) => u.uri),
        // Deliberately no `password` field, even though `bw list items`
        // includes it in its raw output — strip it here, don't rely on the
        // caller not asking for it.
      }));

    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

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
    const { stdout } = await run("bw", ["get", "item", credentialId, "--session", session]);
    const item = JSON.parse(stdout);

    // Explicit guard, not just relying on `.login` being undefined for
    // other types: cards/identities/notes must never be touched by this
    // tool, on principle, regardless of what fields they happen to have.
    if (item.type !== 1) {
      return {
        content: [{ type: "text", text: "Refusing: this tool only handles login-type items, not cards/identities/notes." }],
        isError: true,
      };
    }

    const password = item.login?.password;
    const username = item.login?.username;

    if (!password) {
      return { content: [{ type: "text", text: "Credential has no password field." }], isError: true };
    }

    const targetUrl = url ?? item.login?.uris?.[0]?.uri;
    if (!targetUrl) {
      return { content: [{ type: "text", text: "No URL given and credential has none stored." }], isError: true };
    }

    // `password` (and `username`) live only in this function's local scope
    // and inside performLogin()/Playwright. Nothing below this point may
    // reference them directly in a returned value or a log line.
    const result = await performLogin({ url: targetUrl, username, password });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: result.success, finalUrl: result.finalUrl, reason: result.reason }),
      }],
      isError: !result.success,
    };
  }
);

// --- SSE transport, secret as query param (see README "Beveiligingsnotities") ---

const app = express();
const transports = new Map();

app.get("/sse", async (req, res) => {
  if (req.query.key !== MCP_SSE_SECRET) {
    res.status(401).end();
    return;
  }
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
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
