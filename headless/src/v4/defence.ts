// Rebuild R1 S7 (item 9): the defence teacher's label, from the scripted bots' own rules.
//
// While the condition holds, a policy seat gets the army order a scripted bot would give:
//   threat  (scripted.ts crystalThreat: an enemy combat unit within 600 px of the own crystal):
//           the largest of all_combat / army_a / army_b whose centre is more than RECALL_FAR px
//           from home attack-moves to the own base anchor;
//   raid    (scout.ts workerRaider: an enemy Outrider at the own workers): the worker guard
//           (scout.ts guardOrder), one unit guarding the raided spot.
// Threat comes first; with the army already home a raid still gets its guard. Only legal labels
// are returned (checked against the seat's masks). Pure: the same obs and masks give the same label.
import { GROUPS, ORDERS, type V2Masks } from "./actions.js";
import { ENTITY_FEATURES, type ObsV2 } from "./observation.js";
import { crystalThreat, ownCrystalAt, type BotContext } from "./scripted.js";
import { guardOrder, workerRaider } from "./scout.js";

const F = Object.fromEntries(ENTITY_FEATURES.map((n, i) => [n, i])) as Record<string, number>;
const COMBAT = ["skirmisher", "gunner", "bruiser", "medic", "bulwark"];
const O_AM = ORDERS.indexOf("attack_move");
const T_OWN_BASE = 0;
const RECALL_GROUPS = (["all_combat", "army_a", "army_b"] as const).map((g) => GROUPS.indexOf(g));
/** A group whose centre is this far (px) from the own crystal is away. */
export const RECALL_FAR = 900;

/** [group, order, unit, target] (unit 0 unless the group is `unit`), or null when no defence applies. */
export type DefenceLabel = [number, number, number, number];

export function defenceLabel(obs: ObsV2, m: V2Masks, ctx: BotContext): DefenceLabel | null {
  if (crystalThreat(obs, ctx)) {
    const home = ownCrystalAt(obs);
    const own = obs.entities.filter((e) => e[F.own] && COMBAT.some((u) => e[F[`type_${u}`]]));
    const members = [own, own.filter((e) => e[F.army_a]), own.filter((e) => e[F.army_b])];
    let best = -1, size = 0;
    members.forEach((es, k) => {
      const g = RECALL_GROUPS[k];
      if (es.length <= size || !m.group[g] || !m.order[g][O_AM] || !m.target[O_AM][T_OWN_BASE]) return;
      const cx = es.reduce((s, e) => s + e[F.x], 0) / es.length, cy = es.reduce((s, e) => s + e[F.y], 0) / es.length;
      if (Math.hypot((cx - home.x) * ctx.W, (cy - home.y) * ctx.H) <= RECALL_FAR) return;
      best = g; size = es.length;
    });
    if (best >= 0) return [best, O_AM, 0, T_OWN_BASE];
  }
  const raider = workerRaider(obs, ctx);
  const a = raider ? guardOrder(obs, m, raider, ctx) : null;
  return a ? [a.group, a.order, a.unit, a.target] : null;
}
