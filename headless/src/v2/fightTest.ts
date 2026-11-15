/**
 * Army-versus-army fight test: do the counter multipliers hold at scale?
 *
 * Spawns two armies of equal resource cost in open ground on the default map,
 * attack-moves each at the other (or one side stands on Guard), and reports who is left.
 *
 *   npx tsx headless/src/v2/fightTest.ts
 */
import { MatchEngine } from "../../../server/src/match/matchEngine.js";
import type { PlayerSlot } from "../../../server/src/match/types.js";
import { UNIT_DEFS } from "../../../shared/src/gameBalance.js";

type U = "skirmisher" | "gunner" | "bruiser" | "medic";
type Army = Partial<Record<U, number>>;
type Mode = "both" | "a_attacks" | "b_attacks";

const cost = (a: Army) => Object.entries(a).reduce((s, [u, n]) => s + UNIT_DEFS[u as U].cost * n!, 0);
const supply = (a: Army) => Object.entries(a).reduce((s, [u, n]) => s + UNIT_DEFS[u as U].supplyCost * n!, 0);

function fight(a: Army, b: Army, mode: Mode, gap = 500): { aLeft: number; bLeft: number; ticks: number } {
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "pa", username: "A", color: "blue", score: 0 },
    { playerId: "pb", username: "B", color: "red", score: 0 },
  ];
  const match = engine.createMatch("fight", players);
  engine.startMatch(match.id);
  const cx = match.config.mapWidth / 2, cy = match.config.mapHeight / 2;
  // Blocks 6 units deep, 26 px apart, melee units in front.
  const place = (owner: string, army: Army, x0: number, dir: number) => {
    const order: U[] = ["bruiser", "skirmisher", "gunner", "medic"];
    const list = order.flatMap((u) => Array<U>(army[u] ?? 0).fill(u));
    const rows = Math.max(1, Math.min(10, Math.ceil(Math.sqrt(list.length * 1.5))));
    list.forEach((u, i) => {
      const col = Math.floor(i / rows), row = i % rows;
      engine.debugSpawn(match.id, owner, u, x0 - dir * col * 26, cy + (row - (rows - 1) / 2) * 26);
    });
  };
  place("pa", a, cx - gap / 2, 1);
  place("pb", b, cx + gap / 2, -1);
  const units = (owner: string) => [...match.entities.values()].filter((e) => e.ownerId === owner && e.type !== "worker" && e.type !== "building" && e.health > 0 && (e.type as string) in UNIT_DEFS && e.type !== "crystal");
  const mine = (owner: string) => units(owner).filter((e) => ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type as string));
  const order = (owner: string, x: number) => {
    for (const e of mine(owner)) engine.processCommand(match.id, owner, { type: "attack_move", entityId: e.id, targetX: x, targetY: cy } as never);
  };
  // The side that does not attack stands on a Guard order at its own position
  // (a unit with no order only reacts inside its weapon range, so idle melee units are shot for free).
  const guard = (owner: string, x: number) => engine.processCommand(match.id, owner, { type: "guard", entityIds: mine(owner).map((e) => e.id), targetX: x, targetY: cy } as never);
  if (mode === "b_attacks") guard("pa", cx - gap / 2);
  if (mode === "a_attacks") guard("pb", cx + gap / 2);
  let t = 0;
  for (; t < 3000; t++) {
    if (t % 50 === 0) {
      if (mode !== "b_attacks") order("pa", cx + gap / 2);
      if (mode !== "a_attacks") order("pb", cx - gap / 2);
    }
    engine.tick(match.id);
    const fa = mine("pa").filter((e) => e.type !== "medic").length, fb = mine("pb").filter((e) => e.type !== "medic").length;
    if (fa === 0 || fb === 0) break;
  }
  const val = (owner: string) => mine(owner).reduce((s, e) => s + UNIT_DEFS[e.type as U].cost * (e.health / e.maxHealth), 0);
  return { aLeft: val("pa"), bLeft: val("pb"), ticks: t };
}

const fmt = (a: Army) => Object.entries(a).map(([u, n]) => `${n} ${u}`).join(" + ");
function report(title: string, a: Army, b: Army): void {
  const cells = (["both", "a_attacks", "b_attacks"] as Mode[]).map((m) => {
    const r = fight(a, b, m);
    const ca = cost(a), cb = cost(b);
    const w = r.aLeft > r.bLeft ? "A" : "B";
    return `${w} keeps ${Math.round(100 * (w === "A" ? r.aLeft / ca : r.bLeft / cb))}% (${r.ticks}t)`;
  });
  console.log(`${title.padEnd(14)} A: ${fmt(a).padEnd(34)} (${cost(a)}, ${supply(a)} sup)  B: ${fmt(b).padEnd(12)} (${cost(b)}, ${supply(b)} sup) | both attack: ${cells[0]} | A attacks, B guards: ${cells[1]} | B attacks, A guards: ${cells[2]}`);
}

for (const n of [5, 15, 30, 55]) {
  const g: Army = { gunner: n };
  const res = n * 75;
  console.log(`\n== ${n} gunners (${res} resources) ==`);
  report("equal cost", { skirmisher: Math.round(res / 60) }, g);
  report("equal supply", { skirmisher: n }, g);
  report("bruisers", { bruiser: Math.round(res / 100) }, g);
  const k = Math.round(res / 2 / 60), h = Math.round(res / 2 / 75);
  report("skirm+gunner", { skirmisher: k, gunner: h }, g);
  report("skirm+medic", { skirmisher: Math.round(res * 0.8 / 60), medic: Math.round(res * 0.2 / 60) }, g);
  report("mirror", { gunner: n }, g);
}
