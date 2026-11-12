#!/usr/bin/env node
// G-10 M0 T7: stdio entry for the protocol-v2 runner (see runner.ts for the protocol).
// Built by `npm run build:headless` to headless/dist/v2/vecRunner.js.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VecRunnerV2, setGameVersion } from "./runner.js";

const here = dirname(fileURLToPath(import.meta.url));
for (const p of ["../../package.json", "../../../package.json"]) {
  try { setGameVersion(JSON.parse(readFileSync(resolve(here, p), "utf8")).version); break; } catch { /* next */ }
}

const runner = new VecRunnerV2();
const send = (m: Record<string, unknown>) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(line); } catch (e) { send({ type: "error", message: `bad JSON: ${(e as Error).message}` }); return; }
  if (msg.type === "close") process.exit(0);
  send(runner.handle(msg));
});
rl.on("close", () => process.exit(0));
