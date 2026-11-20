/**
 * Army-versus-army fight test: do the counter multipliers hold at scale?
 *
 * Spawns two armies of equal resource cost in open ground on the default map,
 * attack-moves each at the other (or one side stands on Guard), and reports who is left.
 *
 *   npx tsx headless/src/v3/fightTest.ts            counter check against gunner masses
 *   npx tsx headless/src/v3/fightTest.ts --shield   bulwark (shield unit) prototype cases
 */
import { MatchEngine } from "../../../server/src/match/matchEngine.js";
import type { PlayerSlot } from "../../../server/src/match/types.js";
import { UNIT_DEFS, BUILDING_DEFS, BULWARK } from "@crystalfront/shared";

type U = "skirmisher" | "gunner" | "bruiser" | "medic" | "bulwark";
type Army = Partial<Record<U, number>>;
type Mode = "both" | "a_attacks" | "b_attacks";

const cost = (a: Army) => Object.entries(a).reduce((s, [u, n]) => s + UNIT_DEFS[u as U].cost * n!, 0);
const supply = (a: Army) => Object.entries(a).reduce((s, [u, n]) => s + UNIT_DEFS[u as U].supplyCost * n!, 0);

/** `turrets`: side B also has this many finished turrets in a line (not counted in its cost). */
function fight(a: Army, b: Army, mode: Mode, gap = 500, turrets = 0): { aLeft: number; bLeft: number; ticks: number; blocked: number; shots: number } {
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
    // Bulwarks: a line 30 px ahead of the block, spread evenly across its height.
    const s = army.bulwark ?? 0, h = rows * 26;
    for (let i = 0; i < s; i++) engine.debugSpawn(match.id, owner, "bulwark", x0 + dir * 30, cy - h / 2 + (i + 0.5) * h / s);
  };
  place("pa", a, cx - gap / 2, 1);
  place("pb", b, cx + gap / 2, -1);
  for (let i = 0; i < turrets; i++) engine.debugSpawn(match.id, "pb", "building", cx + gap / 2 - 40, cy + (i - (turrets - 1) / 2) * 60, "turret");
  const turretsLeft = () => [...match.entities.values()].filter((e) => e.ownerId === "pb" && e.buildingType === "turret" && e.health > 0);
  const units = (owner: string) => [...match.entities.values()].filter((e) => e.ownerId === owner && e.type !== "worker" && e.type !== "building" && e.health > 0 && (e.type as string) in UNIT_DEFS && e.type !== "crystal");
  const mine = (owner: string) => units(owner).filter((e) => ["skirmisher", "gunner", "bruiser", "medic", "bulwark"].includes(e.type as string));
  const order = (owner: string, x: number) => {
    for (const e of mine(owner)) engine.processCommand(match.id, owner, { type: "attack_move", entityId: e.id, targetX: x, targetY: cy } as never);
  };
  // The side that does not attack stands on a Guard order at its own position
  // (a unit with no order only reacts inside its weapon range, so idle melee units are shot for free).
  const guard = (owner: string, x: number) => engine.processCommand(match.id, owner, { type: "guard", entityIds: mine(owner).map((e) => e.id), targetX: x, targetY: cy } as never);
  if (mode === "b_attacks") guard("pa", cx - gap / 2);
  if (mode === "a_attacks") guard("pb", cx + gap / 2);
  let t = 0, blocked = 0, shots = 0;
  const armed = (owner: string) => mine(owner).filter((e) => e.type !== "medic" && e.type !== "bulwark").length;
  for (; t < 3000; t++) {
    if (t % 50 === 0) {
      if (mode !== "b_attacks") order("pa", cx + gap / 2);
      if (mode !== "a_attacks") order("pb", cx - gap / 2);
    }
    engine.tick(match.id);
    for (const ev of match.attackLog) if (ev.tick === match.tick - 1 && !ev.isHeal) { shots++; if (ev.blockedFor) blocked++; }
    if (armed("pa") === 0 || armed("pb") + turretsLeft().length === 0) break;
  }
  const val = (owner: string) => mine(owner).reduce((s, e) => s + UNIT_DEFS[e.type as U].cost * (e.health / e.maxHealth), 0);
  const tv = turretsLeft().reduce((s, e) => s + BUILDING_DEFS.turret.cost * (e.health / e.maxHealth), 0);
  return { aLeft: val("pa"), bLeft: val("pb") + tv, ticks: t, blocked, shots };
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

/** Bulwark prototype: what does spending part of an army on shields buy? */
function shieldReport(title: string, a: Army, b: Army, turrets = 0): void {
  const ca = cost(a), cb = cost(b) + turrets * BUILDING_DEFS.turret.cost;
  const cells = (turrets ? ["a_attacks"] : ["both", "a_attacks", "b_attacks"] as Mode[]).map((m) => {
    const r = fight(a, b, m as Mode, 500, turrets);
    const w = r.aLeft / ca > r.bLeft / cb ? "A" : "B";
    return `${m === "both" ? "both attack" : m === "a_attacks" ? "A attacks" : "B attacks"}: ${w} keeps ${Math.round(100 * (w === "A" ? r.aLeft / ca : r.bLeft / cb))}% (${r.ticks}t, ${r.blocked}/${r.shots} shots blocked)`;
  });
  console.log(`${title.padEnd(22)} A: ${fmt(a).padEnd(40)} (${ca})  B: ${(fmt(b) + (turrets ? ` + ${turrets} turret` : "")).padEnd(30)} (${cb}) | ${cells.join(" | ")}`);
}
if (process.argv.includes("--shield")) {
  // Optional overrides for tuning: --hp N --cost N --width N (half-width of the shield front, px)
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i < 0 ? undefined : Number(process.argv[i + 1]); };
  if (arg("--hp")) UNIT_DEFS.bulwark.health = arg("--hp")!;
  if (arg("--cost")) UNIT_DEFS.bulwark.cost = arg("--cost")!;
  if (arg("--width")) (BULWARK as { halfWidth: number }).halfWidth = arg("--width")!;
  console.log(`bulwark: ${UNIT_DEFS.bulwark.health} hp, cost ${UNIT_DEFS.bulwark.cost}, front ±${BULWARK.halfWidth} px`);
  const B = UNIT_DEFS.bulwark.cost;
  const with_ = (u: U, res: number, s: number, extra: Army = {}): Army => ({ [u]: Math.round((res - s * B - cost(extra)) / UNIT_DEFS[u].cost), bulwark: s, ...extra });
  for (const n of [15, 30]) {
    const res = n * 75, g: Army = { gunner: n };
    console.log(`\n== ${res} resources (${n} gunners) ==`);
    for (const s of [0, n / 15, 2 * n / 15, 3 * n / 15, 4 * n / 15]) shieldReport(`gunners+${s} sh v gunners`, with_("gunner", res, s), g);
    for (const s of [0, 2 * n / 15, 4 * n / 15]) shieldReport(`gunners+${s} sh v skirm`, with_("gunner", res, s), { skirmisher: Math.round(res / 60) });
    for (const s of [0, 2 * n / 15]) shieldReport(`gunners+${s} sh v bruiser`, with_("gunner", res, s), { bruiser: Math.round(res / 100) });
    for (const s of [0, 2 * n / 15, 4 * n / 15]) shieldReport(`skirm+${s} sh v gunners`, with_("skirmisher", res, s), g);
    for (const s of [0, 2 * n / 15]) shieldReport(`bruiser+${s} sh v gunners`, with_("bruiser", res, s), g);
    shieldReport("shield mirror", with_("gunner", res, 2 * n / 15), with_("gunner", res, 2 * n / 15));
    shieldReport("sh+medic v gunners", with_("gunner", res, 2 * n / 15, { medic: n / 15 * 2 }), g);
    shieldReport("sh v gunner+medic", with_("gunner", res, 2 * n / 15), { gunner: Math.round((res - n / 15 * 2 * 60) / 75), medic: n / 15 * 2 });
    const tn = n / 5;
    for (const s of [0, n / 15, 2 * n / 15, 4 * n / 15]) shieldReport(`gunners+${s} sh v ${tn} turrets`, with_("gunner", res, s), {}, tn);
    for (const s of [0, 2 * n / 15]) shieldReport(`skirm+${s} sh v ${tn} turrets`, with_("skirmisher", res, s), {}, tn);
    for (const s of [0, 2 * n / 15]) shieldReport(`gunners+${s} sh v ${tn}t+gunners`, with_("gunner", res, s), { gunner: Math.round(n / 2) }, tn);
  }
} else
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
