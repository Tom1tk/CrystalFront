// Rebuild R1 S10 (docs/REBUILD_R1_PLAN.md): the events training/v2/scenarios.py picks scenario
// handovers from, in a saved replay, from one seat's point of view.
//
//   npx tsx headless/src/v4/scenarioEvents.ts <list.json>
//       list: [ { replay: <path>, seat: "blue"|"red" } ] → prints one JSON line per entry:
//       { outpost, builder, raid, decisions } (ticks, null when it never happened; decisions = the
//       replay's decision ticks)
//
//   outpost  the first enemy building within 900 px of the seat's crystal
//   builder  the first enemy worker in the seat's half (nearer its crystal than the enemy's) after 30 s
//   raid     the first tick with ≥ 3 enemy combat units within 700 px of the seat's crystal
import { readFileSync } from "node:fs";
import { replayCommandLog } from "./replayObs.js";

const TPS = 10;
const COMBAT = new Set(["skirmisher", "gunner", "bruiser", "medic", "bulwark"]);
type P = { x: number; y: number };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

export interface ScenarioEvents { outpost: number | null; builder: number | null; raid: number | null; decisions: number[] }

export function scenarioEvents(r: any, seat: "blue" | "red"): ScenarioEvents {
  const P = seat === "blue" ? r.bluePlayerId : r.redPlayerId, E = seat === "blue" ? r.redPlayerId : r.bluePlayerId;
  const ev: ScenarioEvents = { outpost: null, builder: null, raid: null, decisions: r.v2.actions.map((a: any) => a.tick) };
  let home: any = null, enemyHome: any = null;
  replayCommandLog(r, (m: any) => {
    const ents = [...m.entities.values()] as any[];
    home ??= ents.find((e) => e.type === "crystal" && e.ownerId === P);
    enemyHome ??= ents.find((e) => e.type === "crystal" && e.ownerId === E);
    if (!home || !enemyHome) return;
    const enemy = ents.filter((e) => e.ownerId === E);
    if (ev.outpost === null && enemy.some((e) => e.type === "building" && dist(e, home) < 900)) ev.outpost = m.tick;
    if (ev.builder === null && m.tick >= 30 * TPS && enemy.some((e) => e.type === "worker" && dist(e, home) < dist(e, enemyHome))) ev.builder = m.tick;
    if (ev.raid === null && enemy.filter((e) => COMBAT.has(e.type) && dist(e, home) < 700).length >= 3) ev.raid = m.tick;
  });
  return ev;
}

if (process.argv[1]?.endsWith("scenarioEvents.ts")) {
  const list = JSON.parse(readFileSync(process.argv[2], "utf8")) as Array<{ replay: string; seat: "blue" | "red" }>;
  for (const it of list) console.log(JSON.stringify(scenarioEvents(JSON.parse(readFileSync(it.replay, "utf8")), it.seat)));
}
