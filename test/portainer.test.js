import test from "node:test";
import assert from "node:assert/strict";
import { injectIntoStack, mergeEnv, parseAllowedStacks, VAR_NAME_RE } from "../portainer.js";

test("mergeEnv replaces or appends, keeps others", () => {
  const out = mergeEnv([{ name: "A", value: "1" }, { name: "B", value: "2" }], "B", "x");
  assert.deepEqual(out, [{ name: "A", value: "1" }, { name: "B", value: "x" }]);
  assert.deepEqual(mergeEnv(undefined, "N", "v"), [{ name: "N", value: "v" }]);
});

test("parseAllowedStacks", () => {
  assert.deepEqual([...parseAllowedStacks("29, 30,abc,,-1,0")], [29, 30]);
  assert.equal(parseAllowedStacks(undefined).size, 0);
});

test("variable name rule", () => {
  assert.ok(VAR_NAME_RE.test("HW_BRIDGE_PW"));
  assert.ok(!VAR_NAME_RE.test("lower"));
  assert.ok(!VAR_NAME_RE.test("A"));
  assert.ok(!VAR_NAME_RE.test("X;rm -rf"));
});

function mockPortainer({ stack, putStatus = 200 }) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? "GET", body: opts.body, key: opts.headers?.["X-API-Key"] });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.endsWith("/api/stacks/29") && !opts.method) return json(stack);
    if (url.endsWith("/api/stacks/29/file")) return json({ StackFileContent: "services:\n  x:\n    environment:\n      PW: ${HW_BRIDGE_PW}\n" });
    if (opts.method === "PUT") return json({}, putStatus);
    return json({}, 404);
  };
  return { calls, fetchImpl };
}

test("injects into a string stack and keeps other env", async () => {
  const { calls, fetchImpl } = mockPortainer({
    stack: { Name: "mosquitto-hw", Type: 2, EndpointId: 1, GitConfig: null, Env: [{ name: "KEEP", value: "k" }] },
  });
  const r = await injectIntoStack({ baseUrl: "http://p:9000/", apiKey: "K", stackId: 29, varName: "HW_BRIDGE_PW", value: "s3cret", fetchImpl });
  assert.equal(r.stackName, "mosquitto-hw");
  assert.equal(r.referencedInCompose, true);
  const put = calls.find((c) => c.method === "PUT");
  assert.match(put.url, /\/api\/stacks\/29\?endpointId=1$/);
  assert.equal(put.key, "K");
  const body = JSON.parse(put.body);
  assert.deepEqual(body.Env, [{ name: "KEEP", value: "k" }, { name: "HW_BRIDGE_PW", value: "s3cret" }]);
  assert.match(body.StackFileContent, /HW_BRIDGE_PW/);
  assert.equal(JSON.stringify(r).includes("s3cret"), false);
});

test("refuses git stacks and non-compose stacks", async () => {
  for (const stack of [
    { Name: "g", Type: 2, EndpointId: 1, GitConfig: { URL: "x" }, Env: [] },
    { Name: "s", Type: 1, EndpointId: 1, GitConfig: null, Env: [] },
  ]) {
    const { calls, fetchImpl } = mockPortainer({ stack });
    await assert.rejects(injectIntoStack({ baseUrl: "http://p", apiKey: "K", stackId: 29, varName: "ABC_DEF", value: "v", fetchImpl }));
    assert.equal(calls.some((c) => c.method === "PUT"), false);
  }
});

test("errors never contain the secret", async () => {
  const { fetchImpl } = mockPortainer({
    stack: { Name: "n", Type: 2, EndpointId: 1, GitConfig: null, Env: [] },
    putStatus: 500,
  });
  await assert.rejects(
    injectIntoStack({ baseUrl: "http://p", apiKey: "K", stackId: 29, varName: "ABC_DEF", value: "TOPSECRET", fetchImpl }),
    (e) => !String(e.message).includes("TOPSECRET") && /HTTP 500/.test(e.message)
  );
});

test("invalid variable name is rejected before any request", async () => {
  const { calls, fetchImpl } = mockPortainer({ stack: {} });
  await assert.rejects(injectIntoStack({ baseUrl: "http://p", apiKey: "K", stackId: 29, varName: "bad name", value: "v", fetchImpl }));
  assert.equal(calls.length, 0);
});
