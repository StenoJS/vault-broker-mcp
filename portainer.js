// portainer.js — writes one secret into one environment variable of one
// Portainer compose stack. The value is only ever used in the PUT body.
// Error messages are built from HTTP status codes only, never from request
// or response bodies, so a secret cannot leak through an exception.

export const VAR_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function mergeEnv(env, name, value) {
  const kept = (Array.isArray(env) ? env : []).filter((e) => e.name !== name);
  kept.push({ name, value });
  return kept;
}

export function parseAllowedStacks(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
}

export async function injectIntoStack({
  baseUrl,
  apiKey,
  stackId,
  varName,
  value,
  fetchImpl = fetch,
}) {
  if (!VAR_NAME_RE.test(varName)) throw new Error("invalid variable name");
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { "X-API-Key": apiKey };

  const getJson = async (path) => {
    const res = await fetchImpl(`${base}/api${path}`, { headers });
    if (!res.ok) throw new Error(`Portainer GET ${path} failed with HTTP ${res.status}`);
    return res.json();
  };

  const stack = await getJson(`/stacks/${stackId}`);
  if (stack.GitConfig) {
    throw new Error("stack is git-deployed; only string/file compose stacks are supported");
  }
  if (stack.Type !== 2) {
    throw new Error("stack is not a standalone compose stack");
  }

  const file = await getJson(`/stacks/${stackId}/file`);
  const compose = String(file.StackFileContent ?? "");

  const body = {
    StackFileContent: compose,
    Env: mergeEnv(stack.Env, varName, value),
    Prune: false,
    PullImage: false,
  };

  const res = await fetchImpl(
    `${base}/api/stacks/${stackId}?endpointId=${stack.EndpointId}`,
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`Portainer PUT failed with HTTP ${res.status}`);

  return {
    stackName: stack.Name,
    // A variable nobody references does nothing; tell the caller.
    referencedInCompose: compose.includes("${" + varName) || compose.includes("$" + varName),
  };
}
