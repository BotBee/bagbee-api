// ---------------------------------------------------------------------------
// `node --import` preload for bootIndexChild (test/_indexHarness.js) — not a test
// ---------------------------------------------------------------------------
//
// Runs in the child before index.js: installs the same two module hooks the
// in-process boot uses (Airtable stubbed, src/vakt.js made to throw) and reports
// the port the kernel picked, since index.js itself only ever logs PORT ("0").

import net from "node:net";
import { installHooks } from "./_indexHarness.js";

installHooks();

const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function capturedListen(...args) {
  this.once("listening", () => {
    process.stdout.write(`__harness_port__=${this.address().port}\n`);
  });
  return origListen.apply(this, args);
};
