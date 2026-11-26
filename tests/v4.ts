// Layout v4 tests (docs/REBUILD_R1_PLAN.md). Run by `npm test` after tests/index.ts.
//   npx tsx tests/v4.ts
import { VecRunnerV2 as Runner3 } from "../headless/src/v3/runner.js";
import { VecRunnerV2 as Runner4 } from "../headless/src/v4/runner.js";

let passed = 0, failed = 0;
function check(ok: boolean, name: string, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }
}

type R = Record<string, any>;

/** Play one slot to the end in a runner; returns the replay's command log, outcome and the per-decision teacher labels. */
function play(Runner: typeof Runner3 | typeof Runner4, slot: R, cap: number, extra: R = {}): { log: string; outcome: string; labels: string } {
  let replay: R | null = null;
  const r = new Runner({ onReplay: (_i, rp) => { replay ??= rp as R; } });
  const labels: unknown[] = [];
  let res: R = r.handle({ type: "reset_all", max_ticks: cap, critic: false, slots: [slot], ...extra });
  if (res.type === "error") throw new Error(res.message);
  let seats: R = res.slots[0].seats;
  for (let d = 0; d < cap && !replay; d++) {
    const act: R = {};
    for (const [side, s] of Object.entries(seats)) {
      labels.push([side, s.teacher, s.scoutTeacher ?? null]);
      if (s.teacher === null) act[side] = { econ: [0, 0, 0, 0], army: [0, 0, 0, 803, 0] };
    }
    res = r.handle({ type: "step", actions: [act] });
    if (res.type === "error") throw new Error(res.message);
    seats = res.slots[0].seats;
  }
  if (!replay) throw new Error("episode did not end");
  const rp = replay as R;
  return { log: JSON.stringify(rp.commandLog), outcome: JSON.stringify(rp.outcome), labels: JSON.stringify(labels) };
}

function equivalenceTests(): void {
  console.log("\nv4 scripted equivalence (same games as v3)");
  const cases: [R, number, R?][] = [
    [{ seed: 11, map: "shardfall", blue: "teach:backdoor", red: "teach:flank" }, 4000],
    [{ seed: 12, map: "ironreed", blue: "teach:hidden", red: "teach:swing" }, 4000],
    [{ seed: 13, map: "glimmerfen", blue: "bot:rush_post", red: "teach:macro" }, 8000],
    // A policy seat (no-op actions) with the scout teacher shadowing it, against a scripted bot.
    [{ seed: 14, map: "basalt-run", blue: "policy", red: "teach:backdoor" }, 4000, { scout_slot: true, scout_teacher: true }],
  ];
  for (const [slot, cap, extra] of cases) {
    const a = play(Runner3, slot, cap, extra), b = play(Runner4, slot, cap, extra);
    const name = `${slot.blue} v ${slot.red} on ${slot.map} (${cap} ticks)`;
    check(a.log === b.log && a.log.length > 1000, `${name}: same command log`, `${a.log.length} vs ${b.log.length} chars`);
    check(a.outcome === b.outcome, `${name}: same outcome`, `${a.outcome} vs ${b.outcome}`);
    check(a.labels === b.labels, `${name}: same teacher labels`);
  }
}

equivalenceTests();
console.log(`\nv4: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
