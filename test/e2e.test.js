import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const here = dirname(fileURLToPath(import.meta.url));
const ORG = "org-1", COLL = "coll-1", KEY = "test-key-123";
let broker, portainer, statePath, putBodies = [], brokerPort = 38933, portainerPort = 38934;

const seedItems = [
  { id: "item-ok", type: 1, name: "Existing", organizationId: ORG, collectionIds: [COLL],
    login: { username: "u", password: "EXISTING-SECRET-VALUE", uris: [{ uri: "https://example.org" }] } },
  { id: "item-other-coll", type: 1, name: "Elsewhere", organizationId: ORG, collectionIds: ["other"],
    login: { username: "u2", password: "OTHER-SECRET", uris: [] } },
  { id: "item-card", type: 3, name: "Card", organizationId: ORG, collectionIds: [COLL], card: { number: "4111" } },
];

async function start(extraEnv = {}) {
  broker = spawn("node", ["server.js"], {
    cwd: join(here, ".."),
    env: {
      ...process.env,
      PATH: `${join(here, "fakebin")}:${process.env.PATH}`,
      FAKE_BW_STATE: statePath,
      PORT: String(brokerPort),
      BW_SERVER_URL: "https://vw.example", BW_CLIENTID: "id", BW_CLIENTSECRET: "sec", BW_MASTERPASSWORD: "mp",
      VAULTWARDEN_ORG_ID: ORG, VAULTWARDEN_COLLECTION_ID: COLL, MCP_SSE_SECRET: KEY,
      PORTAINER_URL: `http://127.0.0.1:${portainerPort}`, PORTAINER_API_KEY: "pk", INJECT_ALLOWED_STACKS: "29",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  broker.logs = "";
  broker.stdout.on("data", (d) => (broker.logs += d));
  broker.stderr.on("data", (d) => (broker.logs += d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${brokerPort}/healthz`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("broker did not start: " + broker.logs);
}

async function connect() {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${brokerPort}/sse?key=${KEY}`)));
  return client;
}
const textOf = (r) => r.content[0].text;

before(async () => {
  statePath = join(mkdtempSync(join(tmpdir(), "vb-")), "state.json");
  writeFileSync(statePath, JSON.stringify({ items: seedItems, collectionId: COLL, argvLog: [] }));
  portainer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/stacks/29")
        return res.end(JSON.stringify({ Name: "mosquitto-hw", Type: 2, EndpointId: 1, GitConfig: null, Env: [{ name: "KEEP", value: "k" }] }));
      if (req.method === "GET" && req.url === "/api/stacks/29/file")
        return res.end(JSON.stringify({ StackFileContent: "x: ${HW_BRIDGE_PW}" }));
      if (req.method === "PUT" && req.url === "/api/stacks/29?endpointId=1") {
        putBodies.push(JSON.parse(body));
        return res.end("{}");
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => portainer.listen(portainerPort, "127.0.0.1", r));
  await start();
});

after(() => { if (process.env.DEBUG_LOGS) console.error("BROKER LOGS:\n" + broker?.logs); broker?.kill(); portainer?.close(); });

test("auth: wrong key is rejected", async () => {
  const r = await fetch(`http://127.0.0.1:${brokerPort}/sse?key=nope`);
  assert.equal(r.status, 401);
  const r2 = await fetch(`http://127.0.0.1:${brokerPort}/sse`);
  assert.equal(r2.status, 401);
});

test("tools: login is off by default, inject is on", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["create_credential", "inject_secret", "list_credentials"]);
  await c.close();
});

test("list_credentials: metadata only, logins only, no passwords", async () => {
  const c = await connect();
  const out = textOf(await c.callTool({ name: "list_credentials", arguments: {} }));
  assert.ok(out.includes("Existing"));
  assert.ok(!out.includes("Card"));
  assert.ok(!out.includes("EXISTING-SECRET-VALUE"));
  assert.ok(!/password/i.test(out));
  await c.close();
});

test("create_credential: stores a generated password, never returns it", async () => {
  const c = await connect();
  const r = await c.callTool({ name: "create_credential", arguments: { name: "Brug-wachtwoord", username: "hw-bridge", length: 32 } });
  const out = textOf(r);
  assert.ok(!r.isError, out);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const stored = state.items.find((i) => i.name === "Brug-wachtwoord");
  assert.ok(stored);
  assert.equal(stored.login.password.length, 32);
  assert.equal(stored.organizationId, ORG);
  assert.deepEqual(stored.collectionIds, [COLL]);
  assert.ok(!out.includes(stored.login.password));
  // secret must not appear in any bw argv either
  assert.ok(!JSON.stringify(state.argvLog).includes(stored.login.password));
  assert.ok(!broker.logs.includes(stored.login.password));
  // duplicate name refused
  const dup = await c.callTool({ name: "create_credential", arguments: { name: "brug-WACHTWOORD" } });
  assert.equal(dup.isError, true);
  await c.close();
});

test("inject_secret: secret reaches Portainer, not the response", async () => {
  const c = await connect();
  const r = await c.callTool({ name: "inject_secret", arguments: { credentialId: "item-ok", stackId: 29, variable: "HW_BRIDGE_PW" } });
  const out = textOf(r);
  assert.ok(!r.isError, out);
  assert.ok(!out.includes("EXISTING-SECRET-VALUE"));
  assert.ok(!broker.logs.includes("EXISTING-SECRET-VALUE"));
  assert.equal(putBodies.length, 1);
  assert.deepEqual(putBodies[0].Env, [{ name: "KEEP", value: "k" }, { name: "HW_BRIDGE_PW", value: "EXISTING-SECRET-VALUE" }]);
  await c.close();
});

test("inject_secret: allow-list, scope guard and item type are enforced", async () => {
  const c = await connect();
  const notAllowed = await c.callTool({ name: "inject_secret", arguments: { credentialId: "item-ok", stackId: 30, variable: "ABC_DEF" } });
  assert.equal(notAllowed.isError, true);
  const otherColl = await c.callTool({ name: "inject_secret", arguments: { credentialId: "item-other-coll", stackId: 29, variable: "ABC_DEF" } });
  assert.equal(otherColl.isError, true);
  assert.ok(!textOf(otherColl).includes("OTHER-SECRET"));
  const card = await c.callTool({ name: "inject_secret", arguments: { credentialId: "item-card", stackId: 29, variable: "ABC_DEF" } });
  assert.equal(card.isError, true);
  const badName = await c.callTool({ name: "inject_secret", arguments: { credentialId: "item-ok", stackId: 29, variable: "bad name" } }).catch((e) => ({ isError: true, e }));
  assert.equal(badName.isError, true);
  assert.equal(putBodies.length, 1, "no extra PUTs");
  await c.close();
});
