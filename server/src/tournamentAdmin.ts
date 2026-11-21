/**
 * Server admin for tournaments (docs/TOURNAMENT_SPEC.md §7). It talks to the running server, which
 * owns tournament state, using the secret the server writes to `tournaments/.admin-token` at
 * startup. Run it from the directory the server runs in (the repo root for the service).
 *
 *   npx tsx server/src/tournamentAdmin.ts list
 *   npx tsx server/src/tournamentAdmin.ts reassign <CODE>                    new token, printed
 *   npx tsx server/src/tournamentAdmin.ts reassign <CODE> --entrant <name>   that player's browser
 *   npx tsx server/src/tournamentAdmin.ts reassign <CODE> --token <token>    a given browser token
 *
 * Options: --port <n> (default $PORT or 3777), --dir <tournaments dir> (default ./tournaments).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) die(`--${name} needs a value.`);
  args.splice(i, 2);
  return v;
}
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const port = opt("port") ?? process.env.PORT ?? "3777";
const dir = path.resolve(opt("dir") ?? "tournaments");
const entrant = opt("entrant");
const token = opt("token");
const base = `http://127.0.0.1:${port}`;
const [cmd, code] = args;

if (cmd === "list") {
  const r = await fetch(`${base}/api/tournaments`).catch(() => die(`No server on port ${port}.`));
  const { tournaments } = (await r.json()) as { tournaments: Array<{ code: string; name: string; status: string; entrants: number; round: number; rounds: number }> };
  if (tournaments.length === 0) console.log("No tournaments.");
  for (const t of tournaments) console.log(`${t.code}  ${t.status.padEnd(11)} round ${t.round}/${t.rounds}  ${t.entrants} entrants  ${t.name}`);
} else if (cmd === "reassign" && code) {
  if (entrant !== undefined && token !== undefined) die("Use --entrant or --token, not both.");
  let secret: string;
  try { secret = readFileSync(path.join(dir, ".admin-token"), "utf8").trim(); } catch { die(`Can't read ${path.join(dir, ".admin-token")}: run this where the server runs, or pass --dir.`); }
  const r = await fetch(`${base}/api/admin/tournaments/${encodeURIComponent(code)}/manager`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": secret },
    body: JSON.stringify(entrant !== undefined ? { entrant } : token !== undefined ? { token } : {}),
  }).catch(() => die(`No server on port ${port}.`));
  const body = (await r.json()) as { error?: string; code: string; name: string; token: string };
  if (!r.ok) die(body.error ?? `Failed (${r.status}).`);
  console.log(`${body.code} (${body.name}): manager reassigned.`);
  if (entrant !== undefined) console.log(`${entrant}'s browser now manages it; they may need to reload the page.`);
  else if (token !== undefined) console.log("That browser now manages it; it may need to reload the page.");
  else {
    console.log(`New manager token: ${body.token}`);
    console.log("In the new manager's browser, open the site, run this in the developer console, then reload:");
    console.log(`  localStorage.setItem("cf.tournamentToken", "${body.token}")`);
  }
} else {
  die("Usage: tournamentAdmin.ts list | reassign <CODE> [--entrant <name> | --token <token>] [--port <n>] [--dir <path>]");
}
