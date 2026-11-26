// Rebuild R1 S9 behaviour report (docs/REBUILD_R1_PLAN.md): what both seats did in an evaluation's
// saved replays. Replay-based and engine-level, so it works for any observation layout.
//
//   npx tsx headless/src/behaviourReport.ts docs/eval/r1-main-c2-hard64.json [--opps backdoor,flank]
//       [--replays replays] [--out report.json]
//
// Per seat ("policy" is the evaluated network, "opponent" the other seat), per game:
//   raid recall   the first incursion after 60 s: ≥ 3 visible enemy combat units within 700 px of
//                 the own crystal while ≥ 3 own combat units are over 1500 px from it. The value is the
//                 share of those away units that are over 150 px closer 10 / 20 / 40 s later.
//   builder       the first enemy worker in the own half (nearer the own crystal) after 50 s: killed
//                 before it gets within 1000 px of the own crystal (intercepted), or not.
//   outposts      enemy buildings within 1000 px of the own crystal: all destroyed before the first
//                 raid (≥ 3 enemy combat units within 700 px), or no raid came.
//   defused       builder intercepted or outposts cleared before the first raid.
//   Outrider      point orders to the own Outrider: seconds a destination is kept (a new one is over
//                 300 px from the last) and the reversal rate (successive hops with cos < −0.5).
//   no-order      share of decisions with army group 0 (from the replay's v2 action log).
//   switch        share of decisions in which a unit got a different order (another type, a point
//                 over 300 px away, another target) within 6 decisions of its last one.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replayCommandLog } from "./v4/replayObs.js";

const TPS = 10; // ticks per second
const COMBAT = new Set(["skirmisher", "gunner", "bruiser", "medic", "bulwark"]);
const ORDER_CMDS = new Set(["move", "attack_move", "attack", "guard", "retreat", "gather"]);
const SWITCH_TICKS = 48; // 6 decisions of 8 ticks
const FAR = 300;

type P = { x: number; y: number };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

interface SeatStats {
  recall: [number, number, number] | null;
  builder: "intercepted" | "reached" | null;
  outposts: "cleared" | "standing" | null;
  defused: boolean;
  outriderHoldS: number | null;
  outriderReversal: number | null;
  noOrder: number | null;
  switchRate: number | null;
}

function args() {
  const argv = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  return { evalPath: argv[0], opps: opt("--opps", ""), replays: opt("--replays", "replays"), out: opt("--out", "") };
}

/** One seat's per-tick tracking; `onTick` is fed every tick of a single replay pass. */
function tracker(P: string, E: string) {
  const st = {
    home: null as any, enemyHome: null as any, evT: -1, away: null as Map<string, number> | null, recall: [] as number[],
    wid: "", builder: null as SeatStats["builder"], raidT: -1, outDeadT: -1, outIds: new Set<string>(), outriders: new Set<string>(),
  };
  const onTick = (m: any) => {
    const ents = [...m.entities.values()];
    st.home ??= ents.find((e) => e.type === "crystal" && e.ownerId === P);
    st.enemyHome ??= ents.find((e) => e.type === "crystal" && e.ownerId === E);
    const { home, enemyHome } = st;
    if (!home || !enemyHome) return;
    for (const e of ents) if (e.type === "outrider" && e.ownerId === P) st.outriders.add(e.id);
    const vis: Set<string> = m.visibilityData?.get(P)?.entityIds ?? new Set();
    const near = ents.filter((e) => e.ownerId === E && COMBAT.has(e.type) && dist(e, home) < 700);
    if (st.raidT < 0 && near.length >= 3) st.raidT = m.tick;
    for (const e of ents) if (e.ownerId === E && e.type === "building" && dist(e, home) < 1000) st.outIds.add(e.id);
    if (st.outIds.size && st.outDeadT < 0 && [...st.outIds].every((id) => !m.entities.has(id))) st.outDeadT = m.tick;
    if (m.tick >= 50 * TPS && st.builder === null) {
      if (!st.wid) st.wid = ents.find((e) => e.ownerId === E && e.type === "worker" && dist(e, home) < dist(e, enemyHome))?.id ?? "";
      if (st.wid) {
        const w = m.entities.get(st.wid);
        if (!w) st.builder = "intercepted";
        else if (dist(w, home) < 1000) st.builder = "reached";
      }
    }
    if (m.tick < 60 * TPS || st.recall.length === 3) return;
    if (st.evT < 0) {
      const mine = ents.filter((e) => e.ownerId === P && COMBAT.has(e.type) && dist(e, home) > 1500);
      if (near.filter((e) => vis.has(e.id)).length >= 3 && mine.length >= 3) {
        st.evT = m.tick;
        st.away = new Map(mine.map((e) => [e.id, dist(e, home)]));
      }
      return;
    }
    for (const dt of [10, 20, 40]) if (m.tick === st.evT + dt * TPS) {
      let back = 0, n = 0;
      for (const [id, d0] of st.away!) {
        const e = m.entities.get(id);
        if (!e) continue;
        n++;
        if (dist(e, home) < d0 - 150) back++;
      }
      st.recall.push(n ? back / n : 0);
    }
  };
  return { st, onTick };
}

function finish(r: any, P: string, seat: "blue" | "red", st: ReturnType<typeof tracker>["st"]): SeatStats {
  const { recall, builder, raidT, outDeadT, outIds, outriders } = st;
  const outposts: SeatStats["outposts"] = !outIds.size ? null
    : outDeadT >= 0 && (raidT < 0 || outDeadT < raidT) ? "cleared" : "standing";

  // Orders from the command log.
  const cmds = r.commandLog.filter((e: any) => e.playerId === P && ORDER_CMDS.has(e.command.type));
  const ids = (c: any): string[] => c.entityIds ?? (c.entityId ? [c.entityId] : []);
  const pt = (c: any): P | null => (typeof c.targetX === "number" ? { x: c.targetX, y: c.targetY } : null);
  // Outrider destinations
  const dests: Array<{ t: number; p: P }> = [];
  for (const e of cmds) {
    const p = pt(e.command);
    if (!p || !ids(e.command).some((id) => outriders.has(id))) continue;
    if (!dests.length || dist(dests[dests.length - 1].p, p) > FAR) dests.push({ t: e.tick, p });
  }
  let outriderHoldS: number | null = null, outriderReversal: number | null = null;
  if (dests.length >= 2) {
    const holds = dests.slice(1).map((d, i) => (d.t - dests[i].t) / TPS);
    outriderHoldS = holds.reduce((s, x) => s + x, 0) / holds.length;
  }
  if (dests.length >= 3) {
    let rev = 0;
    for (let i = 0; i + 2 < dests.length; i++) {
      const a = dests[i].p, b = dests[i + 1].p, c = dests[i + 2].p;
      const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
      rev += (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)) < -0.5 ? 1 : 0;
    }
    outriderReversal = rev / (dests.length - 2);
  }
  // No-order and switch rates, per decision.
  const acts = (r.v2?.actions ?? []).filter((a: any) => a[seat]?.army);
  const noOrder = acts.length ? acts.filter((a: any) => a[seat].army[0] === 0).length / acts.length : null;
  let switchRate: number | null = null;
  if (acts.length) {
    const last = new Map<string, { t: number; type: string; p: P | null; tgt: string | null }>();
    const switchTicks = new Set<number>();
    for (const e of cmds) {
      const c = e.command, p = pt(c), tgt = c.targetEntityId ?? null;
      for (const id of ids(c)) {
        const prev = last.get(id);
        if (prev && e.tick - prev.t <= SWITCH_TICKS) {
          const far = !!p !== !!prev.p || (!!p && !!prev.p && dist(p, prev.p) > FAR);
          if (prev.type !== c.type || far || prev.tgt !== tgt) switchTicks.add(e.tick);
        }
        last.set(id, { t: e.tick, type: c.type, p, tgt });
      }
    }
    switchRate = switchTicks.size / acts.length;
  }
  return {
    recall: recall.length === 3 ? (recall as [number, number, number]) : null, builder, outposts,
    defused: builder === "intercepted" || outposts === "cleared", outriderHoldS, outriderReversal, noOrder, switchRate,
  };
}

const median = (x: number[]) => { if (!x.length) return NaN; const s = [...x].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mean = (x: number[]) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN);
const f2 = (x: number) => (Number.isNaN(x) ? "  -  " : x.toFixed(2).padStart(5));

function summarise(rows: SeatStats[]) {
  const rec = rows.filter((r) => r.recall);
  const bld = rows.filter((r) => r.builder);
  const out = rows.filter((r) => r.outposts);
  const val = (k: keyof SeatStats) => rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
  return {
    games: rows.length,
    incursions: rec.length,
    recall10: median(rec.map((r) => r.recall![0])), recall20: median(rec.map((r) => r.recall![1])), recall40: median(rec.map((r) => r.recall![2])),
    builderTrips: bld.length, builderIntercepted: bld.filter((r) => r.builder === "intercepted").length / (bld.length || NaN),
    outpostGames: out.length, outpostsCleared: out.filter((r) => r.outposts === "cleared").length / (out.length || NaN),
    defused: rows.filter((r) => r.defused).length / rows.length,
    outriderHoldS: median(val("outriderHoldS")), outriderReversal: median(val("outriderReversal")),
    noOrder: mean(val("noOrder")), switchRate: mean(val("switchRate")),
  };
}

function main() {
  const a = args();
  const want = new Set(a.opps.split(",").filter(Boolean));
  const games = JSON.parse(readFileSync(a.evalPath, "utf8")).games.filter((g: any) => g.replayId && (!want.size || want.has(g.opp)));
  if (!games.length) throw new Error("no games with replays (evaluate with --save-replays)");
  const by: Record<string, { policy: SeatStats[]; opponent: SeatStats[]; wins: number }> = {};
  for (const g of games) {
    const r = JSON.parse(readFileSync(join(a.replays, `${g.replayId}.json`), "utf8"));
    const me = g.side as "blue" | "red", other = me === "blue" ? "red" : "blue";
    const P = me === "blue" ? r.bluePlayerId : r.redPlayerId, E = me === "blue" ? r.redPlayerId : r.bluePlayerId;
    const tp = tracker(P, E), to = tracker(E, P);
    replayCommandLog(r, (m) => { tp.onTick(m); to.onTick(m); });
    const b = (by[g.opp] ??= { policy: [], opponent: [], wins: 0 });
    b.policy.push(finish(r, P, me, tp.st));
    b.opponent.push(finish(r, E, other, to.st));
    b.wins += g.result === "win" ? 1 : 0;
  }
  const report: Record<string, any> = {};
  console.log("opponent     seat      games win   incur recall 10/20/40s   builder int  outposts clr  defused  Outrider hold s/rev  no-order switch");
  const all = { policy: [] as SeatStats[], opponent: [] as SeatStats[], wins: 0 };
  for (const [opp, b] of [...Object.entries(by), ["(all)", all] as const]) {
    if (opp !== "(all)") { all.policy.push(...b.policy); all.opponent.push(...b.opponent); all.wins += b.wins; }
    report[opp] = { win: b.wins / b.policy.length };
    for (const seat of ["policy", "opponent"] as const) {
      const s = summarise(b[seat]);
      report[opp][seat] = s;
      console.log(`${opp.padEnd(12)} ${seat.padEnd(9)} ${String(s.games).padStart(5)} ${seat === "policy" ? f2(b.wins / b.policy.length) : "     "} ${String(s.incursions).padStart(5)} ${f2(s.recall10)} ${f2(s.recall20)} ${f2(s.recall40)}  ${f2(s.builderIntercepted)} (${String(s.builderTrips).padStart(2)})  ${f2(s.outpostsCleared)} (${String(s.outpostGames).padStart(2)})  ${f2(s.defused)}   ${f2(s.outriderHoldS)} ${f2(s.outriderReversal)}      ${f2(s.noOrder)}  ${f2(s.switchRate)}`);
    }
  }
  if (a.out) writeFileSync(a.out, JSON.stringify(report, null, 1));
}

main();
