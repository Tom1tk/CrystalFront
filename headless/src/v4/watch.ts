/**
 * "Watch" a saved v2 replay: re-run its command log through the engine and print
 * what happened — army snapshots, battles (where, who lost what), and who did
 * the damage to whom.
 *
 *   npx tsx headless/src/v4/watch.ts replays/<id>.json [--every 600]
 *
 * Damage attribution: an entity's health loss in a tick is split between the
 * enemies that had it as their attack target and fired that tick (cooldown went
 * up). Splash, or a shooter that switched target the same tick, can go
 * unattributed ("?").
 */
import { readFileSync } from "node:fs";
import { UNIT_DEFS, BUILDING_DEFS } from "@crystalfront/shared";
import type { MatchState, MatchEntity } from "../../../server/src/match/types.js";
import { replayCommandLog } from "./replayObs.js";
import type { V2Replay } from "./runner.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"))!;
const every = Number(args[args.indexOf("--every") + 1]) || 600;
const r: V2Replay = JSON.parse(readFileSync(file, "utf8"));
const ids = [r.bluePlayerId, r.redPlayerId];
const name = (pid: string) => (pid === ids[0] ? `blue(${r.blue})` : `red(${r.red})`);
const ARMY = ["skirmisher", "gunner", "bruiser", "medic", "bulwark"];
const kind = (e: MatchEntity) => (e.type === "building" ? e.buildingType! : e.type);
const value = (e: MatchEntity) => (e.type === "building" ? BUILDING_DEFS[e.buildingType!]?.cost ?? 0 : UNIT_DEFS[e.type]?.cost ?? 0);
const sec = (t: number) => `${Math.floor(t / 600)}:${String(Math.floor((t % 600) / 10)).padStart(2, "0")}`;

interface Snap { hp: number; cd: number; target?: string; owner: string; kind: string; x: number; y: number; value: number }
let prev = new Map<string, Snap>();
const dmg = new Map<string, number>(); // "attackerOwner|attackerKind>victimKind" → damage
const deaths: Array<{ t: number; owner: string; kind: string; x: number; value: number }> = [];
const built: string[] = [];
let W = 5000;

function snapshot(m: MatchState) {
  console.log(`\n── ${sec(m.tick)} (tick ${m.tick}) ──`);
  for (const [i, pid] of ids.entries()) {
    const own = [...m.entities.values()].filter((e) => e.ownerId === pid);
    const count = (k: string) => own.filter((e) => kind(e) === k && (e.type !== "building" || e.constructionProgress >= 1)).length;
    const army = own.filter((e) => ARMY.includes(e.type));
    const fwd = army.filter((e) => (i === 0 ? e.x > W / 2 : e.x < W / 2)).length;
    const meanX = army.length ? army.reduce((s, e) => s + e.x, 0) / army.length : NaN;
    const depth = isNaN(meanX) ? "-" : `${Math.round(100 * (i === 0 ? meanX / W : 1 - meanX / W))}%`;
    const cr = own.find((e) => e.type === "crystal");
    // In contact: army units with an enemy unit or building inside their own weapon range.
    const foes = [...m.entities.values()].filter((e) => e.ownerId !== pid && e.type !== "resource_node" && ids.includes(e.ownerId));
    const contact = army.filter((u) => foes.some((f) => Math.hypot(f.x - u.x, f.y - u.y) <= (UNIT_DEFS[u.type].range || 0) + u.radius + f.radius + 4)).length;
    const bld = ["barracks", "foundry", "turret", "outpost", "supply_depot"].map((b) => `${b.slice(0, 4)} ${count(b)}`).join(" ");
    console.log(`  ${name(pid).padEnd(24)} res ${String(Math.round(m.economy[i]!.resources)).padStart(4)}  workers ${String(count("worker")).padStart(2)}  army ${String(army.length).padStart(2)} [${ARMY.map((u) => `${u.slice(0, 3)} ${count(u)}`).join(", ")}]  depth ${depth} (${fwd} past centre, ${contact} in contact)  ${bld}  crystal ${cr ? Math.round(cr.health) : "dead"}`);
  }
}

const final = replayCommandLog(r, (m) => {
  W = m.config.mapWidth;
  const now = new Map<string, Snap>();
  for (const e of m.entities.values()) {
    if (e.type === "resource_node") continue;
    now.set(e.id, { hp: e.health, cd: e.attackCooldown, target: e.attackTargetId, owner: e.ownerId, kind: kind(e), x: e.x, y: e.y, value: value(e) });
    if (!prev.has(e.id) && m.tick > 1 && e.type === "building") built.push(`${sec(m.tick)} ${name(e.ownerId)} starts ${e.buildingType} at x=${Math.round(100 * e.x / W)}%`);
  }
  for (const [id, p] of prev) {
    const n = now.get(id);
    const lost = p.hp - (n ? n.hp : 0);
    if (lost > 0) {
      const shooters = [...now.entries()].filter(([sid, s]) => s.owner !== p.owner && s.target === id && s.cd > (prev.get(sid)?.cd ?? 0));
      if (shooters.length === 0) dmg.set(`${p.owner === ids[0] ? ids[1] : ids[0]}|?>${p.kind}`, (dmg.get(`${p.owner === ids[0] ? ids[1] : ids[0]}|?>${p.kind}`) ?? 0) + lost);
      for (const [, s] of shooters) dmg.set(`${s.owner}|${s.kind}>${p.kind}`, (dmg.get(`${s.owner}|${s.kind}>${p.kind}`) ?? 0) + lost / shooters.length);
    }
    if (!n) deaths.push({ t: m.tick, owner: p.owner, kind: p.kind, x: p.x, value: p.value });
  }
  prev = now;
  if (m.tick % every === 0) snapshot(m);
});
snapshot(final);

console.log(`\nResult: ${r.outcome.winner ? name(ids[r.outcome.winner === "blue" ? 0 : 1]) : "draw"} (${r.outcome.winType}) at ${sec(r.outcome.ticks)}  map ${r.mapId}`);

console.log("\nBuildings started:");
for (const b of built) console.log("  " + b);

// Battles: deaths of combat units/buildings grouped while gaps stay under 150 ticks.
console.log("\nBattles (≥3 deaths; x = % of map from blue's side):");
const relevant = deaths.filter((d) => d.kind !== "placeholder");
let group: typeof deaths = [];
const flush = () => {
  if (group.length >= 3) {
    const side = (pid: string) => {
      const g = group.filter((d) => d.owner === pid);
      const by: Record<string, number> = {};
      for (const d of g) by[d.kind] = (by[d.kind] ?? 0) + 1;
      return `${g.reduce((s, d) => s + d.value, 0)} value [${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}]`;
    };
    const xs = group.map((d) => d.x).sort((a, b) => a - b);
    console.log(`  ${sec(group[0].t)}–${sec(group[group.length - 1].t)} at x≈${Math.round(100 * xs[xs.length >> 1] / W)}%  blue lost ${side(ids[0])} | red lost ${side(ids[1])}`);
  }
  group = [];
};
for (const d of relevant) {
  if (group.length && d.t - group[group.length - 1].t > 150) flush();
  group.push(d);
}
flush();

console.log("\nDamage dealt (attacker → victim):");
for (const pid of ids) {
  const rows = [...dmg.entries()].filter(([k]) => k.startsWith(pid + "|")).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, [, v]) => s + v, 0);
  console.log(`  ${name(pid)}: ${Math.round(total)} total`);
  for (const [k, v] of rows.slice(0, 10)) console.log(`    ${k.split("|")[1].padEnd(24)} ${String(Math.round(v)).padStart(6)}  ${Math.round(100 * v / total)}%`);
}
