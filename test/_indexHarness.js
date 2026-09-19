// ---------------------------------------------------------------------------
// Boots the REAL index.js inside the test process (helper, not a test file)
// ---------------------------------------------------------------------------
//
// The driver surface is what the phones in the vans depend on, so the regression
// tests for it must exercise the real file rather than a copy of its wiring — a
// re-implementation would keep passing after index.js drifted away from it.
//
// Two things stand between index.js and an offline test, and both are handled by
// a synchronous module hook (node:module registerHooks, in-process, no flags):
//
//   1. `import fetch from "node-fetch"` would really call api.airtable.com.
//      The package is replaced by a stub that calls `airtable.reply()`.
//   2. `import("./src/vakt.js")` in the listen callback would open a Postgres
//      pool, an SMTP egress probe and real SIGTERM handlers. The module is
//      replaced by one that throws, which is ALSO the case under test: a /v2
//      module that fails to load must leave /app/* and /health untouched.
//
// The listening port is taken from the server object itself (captured through
// net.Server.prototype.listen) rather than from a port picked in advance, so the
// harness cannot lose a race to another process.
//
// ESM loads index.js once per process, and requireAppToken reads its switches —
// APP_TOKEN, APP_ROUTES_ACCEPT_STAFF_JWT — at import, so the in-process boot can
// only ever run under ONE environment. Every other combination is a second
// index.js in a child process (bootIndexChild), given the same two hooks through
// test/_indexChildPreload.js.

import net from "node:net";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VAKT_URL = new URL("../src/vakt.js", import.meta.url).href;
const INDEX_URL = new URL("../index.js", import.meta.url);
const PRELOAD_URL = new URL("./_indexChildPreload.js", import.meta.url);

/// Every Airtable request index.js makes lands here. `reply` returns
/// `{ status, body }`; index.js reads only `ok`, `status` and `text()`.
export const airtable = {
  calls: [],
  reply: () => ({ status: 200, body: JSON.stringify({ records: [] }) }),
  reset() {
    airtable.calls.length = 0;
    airtable.reply = () => ({ status: 200, body: JSON.stringify({ records: [] }) });
  },
};

let hooksInstalled = false;

/// Exported for the child-process preload; idempotent.
export function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  globalThis.__bagbeeTestFetch = async (url, options = {}) => {
    airtable.calls.push({ url: String(url), options });
    const { status = 200, body = "" } = (await airtable.reply(String(url), options)) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return body;
      },
    };
  };

  registerHooks({
    load(url, context, nextLoad) {
      if (url === VAKT_URL) {
        return {
          format: "module",
          shortCircuit: true,
          source: 'throw Object.assign(new Error("simulated /v2 load failure"), { code: "ERR_TEST_VAKT" });',
        };
      }
      if (url.endsWith("/node-fetch/src/index.js")) {
        return {
          format: "module",
          shortCircuit: true,
          source: "export default (...args) => globalThis.__bagbeeTestFetch(...args);",
        };
      }
      return nextLoad(url, context);
    },
  });
}

export const APP_TOKEN = "harness-app-token-0123456789";
/// ≥ 32 chars, so the secrets rule (§2.2) counts it as configured. It is set for
/// the flag-OFF boot on purpose: the regression tests must show that it is the
/// flag, and not a missing secret, that keeps a staff JWT off /app/*.
export const STAFF_JWT_SECRET = "harness-staff-jwt-secret-0123456789abcdef";
const AIRTABLE_TOKEN = "harness-airtable-token";

/// The environment every boot starts from. The flag is pinned OFF here so a
/// developer's shell cannot flip the byte-identical guard by accident.
function baseEnv() {
  return {
    PORT: "0", // "0" is a valid port for listen(): the kernel picks a free one.
    APP_TOKEN,
    AIRTABLE_TOKEN,
    STAFF_JWT_SECRET,
    APP_ROUTES_ACCEPT_STAFF_JWT: "0",
  };
}

/// Imports index.js once per test process and hands back a client for it.
/// ESM caches the module, so a second call returns the same running server.
let booted = null;

export function bootIndex() {
  booted ??= bootOnce();
  return booted;
}

/// index.js sets v2LoadError from a .catch() on the dynamic import, so the stub
/// answers "starting" for a tick or two before it answers "vakt_unavailable".
async function waitForVaktStub(request) {
  for (let i = 0; i < 200; i++) {
    const body = await (await request("/v2/health")).json();
    if (body.error === "vakt_unavailable") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function bootOnce() {
  installHooks();

  Object.assign(process.env, baseEnv());

  const started = [];
  const origListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function capturedListen(...args) {
    started.push(this);
    return origListen.apply(this, args);
  };
  try {
    await import("../index.js");
  } finally {
    net.Server.prototype.listen = origListen;
  }

  const server = started[0];
  if (!server) throw new Error("index.js did not start a server");
  if (!server.listening) await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // Global fetch (undici) — deliberately NOT the stubbed node-fetch, so the test
  // client and the code under test cannot be confused for one another.
  const request = (path, init) => fetch(`${base}${path}`, init);

  await waitForVaktStub(request);

  return {
    port,
    server,
    request,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/// A SECOND real index.js, in a child process, under its own environment.
///
/// `overrides` are env vars on top of baseEnv(); a null value UNSETS the variable
/// (that is how "APP_TOKEN missing" is spelled). The child installs the same two
/// hooks through the preload; its Airtable stub answers `{records:[]}` to
/// everything and its calls stay in the child, so assert on status and body here
/// and leave call-counting to the in-process boot.
export async function bootIndexChild(overrides = {}) {
  const env = { ...process.env, ...baseEnv() };
  // node:test marks its own per-file children with this; the boot is not one.
  delete env.NODE_TEST_CONTEXT;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) delete env[key];
    else env[key] = String(value);
  }

  const child = spawn(process.execPath, ["--import", PRELOAD_URL.href, fileURLToPath(INDEX_URL)], {
    env,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Both streams are drained: a child blocked on a full pipe would never listen.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const m = /__harness_port__=(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`index.js child exited (${code ?? signal}) before listening\n${stderr}`));
    });
    setTimeout(() => reject(new Error(`index.js child did not listen within 15 s\n${stderr}`)), 15_000).unref();
  });

  const base = `http://127.0.0.1:${port}`;
  const request = (path, init) => fetch(`${base}${path}`, init);
  await waitForVaktStub(request);

  return {
    port,
    request,
    get stderr() {
      return stderr;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // With the Vakt module failed, index.js has no SIGTERM handler of its own,
      // so this is Node's default exit and needs no drain.
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}
