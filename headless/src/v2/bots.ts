// G-10 M0 T7: v2 bot interface and registry.
//
// A v2 bot sees exactly what the policy sees (its own fogged observation and
// masks) and is asked once per decision, so it is a fair opponent and an exact
// teacher. T8 adds the scripted bots (rush, turtle, macro, heavy, switchers);
//   idle    always no-op (the worker autopilot still gathers)
//   random  a uniformly random legal action, from its own seeded RNG
//   scripted (T8, scripted.ts): rush1–3, turtle, macro, heavy, hidden and the
//           four switchers; each plays a template with its own strategy token z
import { Rng } from "../../../server/src/match/engine/rng.js";
import { BUILDINGS, decodeEcon, ECON_TRAIN0, GROUPS, NOOP_ACTION, TRAIN_UNITS, type V2Action, type V2Masks } from "./actions.js";
import type { ObsV2 } from "./observation.js";
import { SCRIPTED, ScriptedV2Bot, type BotContext } from "./scripted.js";

export interface V2Bot {
  readonly name: string;
  /** Strategy token of the template being played (scripted bots only). */
  readonly z?: number;
  decide(obs: ObsV2, masks: V2Masks): V2Action;
}

export class IdleV2Bot implements V2Bot {
  readonly name = "idle";
  decide(): V2Action { return { ...NOOP_ACTION }; }
}

/** Random legal action; trains a unit 30% of the time when it can, else any legal economy entry. */
export class RandomV2Bot implements V2Bot {
  readonly name = "random";
  private rng: Rng;
  constructor(seed: number) { this.rng = new Rng(seed); }
  private pick(m: boolean[], lo = 0, hi = m.length): number {
    let n = 0;
    for (let i = lo; i < hi; i++) if (m[i]) n++;
    if (n === 0) return -1;
    let k = Math.floor(this.rng.random() * n);
    for (let i = lo; i < hi; i++) if (m[i] && k-- === 0) return i;
    return -1;
  }
  decide(_obs: ObsV2, m: V2Masks): V2Action {
    const r = this.rng.random();
    let econ = r < 0.3 ? this.pick(m.econ, ECON_TRAIN0, ECON_TRAIN0 + TRAIN_UNITS.length) : r < 0.6 ? this.pick(m.econ) : 0;
    if (econ < 0) econ = 0;
    const pk = (x: boolean[]) => Math.max(0, this.pick(x));
    const ea = decodeEcon(econ);
    const kind = ea.kind === "repair" ? 0 : ea.kind === "rally" ? 1 : ea.kind === "cancel" ? 2 : -1;
    const site = ea.kind === "build" ? pk(m.site[BUILDINGS.indexOf(ea.building)]) : 0;
    const econPtr = kind >= 0 ? pk(m.econPtr[kind]) : 0, econTarget = kind === 1 ? pk(m.econTarget) : 0;
    const group = this.pick(m.group), order = this.pick(m.order[group]);
    const unit = GROUPS[group] === "unit" ? pk(m.unit[order]) : 0;
    return { econ, site, econPtr, econTarget, group, order, unit, target: this.pick(m.target[order]), ptr: pk(m.ptr[order]) };
  }
}

export const V2_BOTS: readonly string[] = ["idle", "random", ...Object.keys(SCRIPTED)];

/**
 * Make a bot by name. `seed` should come from the episode seed and the bot's
 * role, never from the seat, so a seat-swapped game plays the mirrored game.
 */
export function makeV2Bot(name: string, seed: number, ctx?: BotContext, z = 0): V2Bot {
  switch (name) {
    case "idle": return new IdleV2Bot();
    case "random": return new RandomV2Bot(seed);
    default:
      if (SCRIPTED[name]) {
        if (!ctx) throw new Error(`scripted bot "${name}" needs a BotContext`);
        return new ScriptedV2Bot(name, seed, ctx, z);
      }
      throw new Error(`unknown v2 bot "${name}" (have: ${V2_BOTS.join(", ")})`);
  }
}
