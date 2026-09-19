// Audit finding 1: registerShutdown awaited db.end() and server.close() with no
// timeout, so a SIGTERM during a Railway deploy could hang until the platform
// force-killed the instance — and because the handlers were registered with
// process.once(), the second SIGTERM Railway sends had no listener left and fell
// through to Node's default kill, cutting the drain it was waiting for.
//
// Everything here runs against a fake `proc` (a plain EventEmitter with an exit
// spy), so no test ever installs a real signal handler or exits the runner.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerShutdown } from "../src/vakt.js";

const quiet = { log() {}, error() {} };

function fakeProc() {
  const proc = new EventEmitter();
  proc.exits = [];
  proc.exit = (code) => proc.exits.push(code);
  return proc;
}

const never = () => new Promise(() => {});

async function waitFor(predicate, { timeoutMs = 3000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("a clean shutdown closes everything in order and exits 0", async () => {
  const proc = fakeProc();
  const order = [];
  const db = { end: async () => void order.push("db.end") };
  const server = { close: (cb) => { order.push("server.close"); cb(); } };
  const dbLoop = { stop: () => order.push("dbLoop.stop") };
  const worker = { stop: () => order.push("worker.stop"), drain: async () => void order.push("worker.drain") };
  const apns = () => ({});
  apns.peek = () => ({ client: { close: () => order.push("apns.close") } });

  registerShutdown({ server, db, dbLoop, worker, apns, log: quiet, proc });
  proc.emit("SIGTERM");
  await waitFor(() => proc.exits.length > 0, { label: "exit" });

  assert.deepEqual(order, ["dbLoop.stop", "worker.stop", "worker.drain", "apns.close", "db.end", "server.close"]);
  assert.deepEqual(proc.exits, [0]);
});

test("a db.end() that never settles cannot hold SIGTERM open", async () => {
  const proc = fakeProc();
  let serverClosed = false;
  const db = { end: never };
  const server = { close: (cb) => { serverClosed = true; cb(); } };

  registerShutdown({ server, db, dbLoop: null, worker: null, apns: null, log: quiet, proc, closeWaitMs: 40 });
  proc.emit("SIGTERM");
  await waitFor(() => proc.exits.length > 0, { label: "exit despite a hung db.end()" });

  assert.deepEqual(proc.exits, [0]);
  assert.equal(serverClosed, true, "a stuck pool must not stop the listener from being closed");
});

test("a server.close() that never calls back cannot hold SIGTERM open", async () => {
  const proc = fakeProc();
  // The real case: Railway's edge holds a keep-alive connection, so close()'s
  // callback never fires because there is always one live socket.
  const server = { close: () => {} };
  const db = { end: async () => {} };

  registerShutdown({ server, db, dbLoop: null, worker: null, apns: null, log: quiet, proc, closeWaitMs: 40 });
  proc.emit("SIGTERM");
  await waitFor(() => proc.exits.length > 0, { label: "exit despite a hung server.close()" });

  assert.deepEqual(proc.exits, [0]);
});

test("the overall watchdog exits even when a step's own budget is far too long", async () => {
  const proc = fakeProc();
  const worker = { stop() {}, drain: never };

  // jobWaitMs is the spec's 20 s; the deadline is what stops the process from
  // sitting there for all of it when Railway is already counting down to SIGKILL.
  registerShutdown({
    server: null, db: { end: never }, dbLoop: null, worker, apns: null, log: quiet, proc,
    jobWaitMs: 20_000, closeWaitMs: 20_000, deadlineMs: 60,
  });
  proc.emit("SIGTERM");
  await waitFor(() => proc.exits.length > 0, { label: "watchdog exit" });

  assert.deepEqual(proc.exits, [0]);
});

test("a second SIGTERM is swallowed instead of killing the process mid-shutdown", async () => {
  const proc = fakeProc();
  let ends = 0;
  let closes = 0;
  const db = { end: async () => { ends++; } };
  const server = { close: (cb) => { closes++; setTimeout(cb, 20); } };

  registerShutdown({ server, db, dbLoop: null, worker: null, apns: null, log: quiet, proc, closeWaitMs: 500 });

  proc.emit("SIGTERM");
  assert.equal(
    proc.listenerCount("SIGTERM"),
    1,
    "the handler must stay registered, or the next SIGTERM falls through to Node's default kill",
  );

  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  await waitFor(() => proc.exits.length > 0, { label: "exit" });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(proc.exits, [0], "one shutdown, one exit");
  assert.equal(ends, 1, "db.end() must not run twice");
  assert.equal(closes, 1, "server.close() must not run twice");
});

test("a throwing step is logged and still exits 0", async () => {
  const proc = fakeProc();
  const errors = [];
  const db = { end: async () => { throw Object.assign(new Error("pool gone"), { code: "ECONNRESET" }); } };

  registerShutdown({
    server: null, db, dbLoop: null, worker: null, apns: null, proc, closeWaitMs: 200,
    log: { log() {}, error: (...a) => errors.push(a.join(" ")) },
  });
  proc.emit("SIGTERM");
  await waitFor(() => proc.exits.length > 0, { label: "exit" });

  assert.deepEqual(proc.exits, [0]);
  // The name of this test promises the failure is logged, so assert it: a step
  // that throws on the way out must leave a line in the deploy log.
  assert.ok(errors.some((line) => line.includes("db.end() failed") && line.includes("ECONNRESET")),
    `expected the failing step to be logged, got ${JSON.stringify(errors)}`);
});
