/**
 * Mirror-invariance test infrastructure (Appendix C, experiment 4).
 *
 * mirrorState() reflects a MatchState across the map's vertical midline:
 *   - every x coordinate (entities, moveTargets, rallyPoints, resource
 *     nodes) becomes mapWidth - x
 *   - player slots 0/1 are swapped (players, economy, rng), so "blue" and
 *     "red" trade places
 * Entity ownerId values, ids, idGen, seed and tick are left untouched —
 * each entity keeps its playerId, which now lives in the other slot.
 *
 * Property under test: tick(mirrorState(s)) ~= mirrorState(tick(s)),
 * up to the epsilon/exclusions documented at each call site (see
 * docs/REVIVAL_PLAN.md Appendix C).
 */
import type {
  MatchState,
  MatchEntity,
  ResourceNode,
  PlayerSlot,
  PlayerEconomy,
} from "../types.js";
import type { Rng } from "./rng.js";
import type { IdGen } from "./idGen.js";

function shallowClone<T extends object>(obj: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj);
}

function cloneEntity(e: MatchEntity): MatchEntity {
  return {
    ...e,
    moveTarget: e.moveTarget ? { ...e.moveTarget } : undefined,
    rallyPoint: e.rallyPoint ? { ...e.rallyPoint } : undefined,
    buildWorkerIds: e.buildWorkerIds ? new Set(e.buildWorkerIds) : undefined,
    productionQueue: e.productionQueue.map((q) => ({ ...q })),
  };
}

function cloneNode(n: ResourceNode): ResourceNode {
  return { ...n, gathererSlots: new Set(n.gathererSlots) };
}

export function deepCloneMatchState(match: MatchState): MatchState {
  return {
    ...match,
    players: match.players.map((p) => (p ? { ...p } : null)) as [
      PlayerSlot | null,
      PlayerSlot | null,
    ],
    economy: match.economy.map((e) => (e ? { ...e } : null)) as [
      PlayerEconomy | null,
      PlayerEconomy | null,
    ],
    entities: new Map([...match.entities].map(([id, e]) => [id, cloneEntity(e)])),
    resourceNodes: match.resourceNodes.map(cloneNode),
    attackLog: match.attackLog.map((a) => ({ ...a })),
    commandLog: match.commandLog.map((c) => ({ ...c })),
    config: { ...match.config },
    rng: [shallowClone(match.rng[0]), shallowClone(match.rng[1])] as [Rng, Rng],
    idGen: shallowClone(match.idGen) as IdGen,
    visibilityData: undefined,
  };
}

/**
 * Reflect a match state left-right and swap player slots 0/1 (players,
 * economy, rng). Entity ownerId values are untouched — they continue to
 * name the same playerId, which now lives in the other slot.
 */
export function mirrorState(match: MatchState): MatchState {
  const clone = deepCloneMatchState(match);
  const mapW = clone.mapWidth;
  const mirrorX = (x: number) => mapW - x;

  for (const e of clone.entities.values()) {
    e.x = mirrorX(e.x);
    if (e.moveTarget) e.moveTarget.x = mirrorX(e.moveTarget.x);
    if (e.rallyPoint) e.rallyPoint.x = mirrorX(e.rallyPoint.x);
  }
  for (const n of clone.resourceNodes) {
    n.x = mirrorX(n.x);
  }

  return {
    ...clone,
    players: [clone.players[1], clone.players[0]],
    economy: [clone.economy[1], clone.economy[0]],
    rng: [clone.rng[1], clone.rng[0]],
  };
}

export interface MirrorDiff {
  system: string;
  detail: string;
}

const DEFAULT_EPS = 1e-6;

/**
 * Diff two states that are expected to be mirror images of each other
 * (typically `expected = mirrorState(tick(s))` and `actual = tick(mirrorState(s))`).
 *
 * `preExistingIds` is the set of entity ids present in `s` *before* the
 * tick — entities created during the tick (unit spawns) are excluded from
 * position comparisons, since `spawnOutside`'s RNG angle is isotropic but
 * not mirror-equivariant (a known, non-biasing source of divergence).
 */
export function diffStates(
  expected: MatchState,
  actual: MatchState,
  preExistingIds: Set<string>,
  eps: number = DEFAULT_EPS,
): MirrorDiff[] {
  const diffs: MirrorDiff[] = [];
  const close = (a: number, b: number) => Math.abs(a - b) <= eps;

  // ── Economy ──────────────────────────────────────────────────────────
  for (let i = 0; i < 2; i++) {
    const e = expected.economy[i];
    const a = actual.economy[i];
    if (!e || !a) {
      if (e !== a) diffs.push({ system: "economy", detail: `slot ${i}: presence mismatch` });
      continue;
    }
    for (const key of ["resources", "supply", "maxSupply", "lifetimeResources"] as const) {
      if (!close(e[key], a[key])) {
        diffs.push({ system: "gathering", detail: `economy[${i}].${key}: ${e[key]} vs ${a[key]}` });
      }
    }
  }

  // ── Resource nodes ───────────────────────────────────────────────────
  const expectedNodes = new Map(expected.resourceNodes.map((n) => [n.id, n]));
  const actualNodes = new Map(actual.resourceNodes.map((n) => [n.id, n]));
  for (const [id, en] of expectedNodes) {
    const an = actualNodes.get(id);
    if (!an) { diffs.push({ system: "gathering", detail: `node ${id}: missing in actual` }); continue; }
    if (!close(en.x, an.x)) diffs.push({ system: "movement", detail: `node ${id}.x: ${en.x} vs ${an.x}` });
    if (!close(en.remaining, an.remaining)) diffs.push({ system: "gathering", detail: `node ${id}.remaining: ${en.remaining} vs ${an.remaining}` });
    if (!close(en.accumulatedGather ?? 0, an.accumulatedGather ?? 0)) {
      diffs.push({ system: "gathering", detail: `node ${id}.accumulatedGather: ${en.accumulatedGather} vs ${an.accumulatedGather}` });
    }
    const eSlots = JSON.stringify([...en.gathererSlots].sort());
    const aSlots = JSON.stringify([...an.gathererSlots].sort());
    if (eSlots !== aSlots) diffs.push({ system: "gathering", detail: `node ${id}.gathererSlots: ${eSlots} vs ${aSlots}` });
  }

  // ── Entities ─────────────────────────────────────────────────────────
  const expectedIds = new Set(expected.entities.keys());
  const actualIds = new Set(actual.entities.keys());

  for (const id of expectedIds) {
    if (!actualIds.has(id)) {
      diffs.push({ system: "combat", detail: `entity ${id}: present in mirror(tick(s)) but missing in tick(mirror(s)) (death asymmetry)` });
      continue;
    }
    const ee = expected.entities.get(id)!;
    const ae = actual.entities.get(id)!;

    if (ee.ownerId !== ae.ownerId) diffs.push({ system: "internal", detail: `entity ${id}.ownerId: ${ee.ownerId} vs ${ae.ownerId}` });

    if (!preExistingIds.has(id)) continue; // newly spawned this tick — see spawnOutside note above

    if (!close(ee.x, ae.x)) diffs.push({ system: "movement", detail: `entity ${id} (${ee.type}).x: ${ee.x} vs ${ae.x}` });
    if (!close(ee.y, ae.y)) diffs.push({ system: "movement", detail: `entity ${id} (${ee.type}).y: ${ee.y} vs ${ae.y}` });
    if (!close(ee.health, ae.health)) diffs.push({ system: "combat", detail: `entity ${id} (${ee.type}).health: ${ee.health} vs ${ae.health}` });
    if (!close(ee.attackCooldown, ae.attackCooldown)) diffs.push({ system: "combat", detail: `entity ${id} (${ee.type}).attackCooldown: ${ee.attackCooldown} vs ${ae.attackCooldown}` });
    if ((ee.attackTargetId ?? null) !== (ae.attackTargetId ?? null)) diffs.push({ system: "combat", detail: `entity ${id} (${ee.type}).attackTargetId: ${ee.attackTargetId} vs ${ae.attackTargetId}` });
    if ((ee.healTargetId ?? null) !== (ae.healTargetId ?? null)) diffs.push({ system: "combat", detail: `entity ${id} (${ee.type}).healTargetId: ${ee.healTargetId} vs ${ae.healTargetId}` });

    if ((ee.gatheringNodeId ?? null) !== (ae.gatheringNodeId ?? null)) diffs.push({ system: "gathering", detail: `entity ${id} (${ee.type}).gatheringNodeId: ${ee.gatheringNodeId} vs ${ae.gatheringNodeId}` });

    if ((ee.buildTargetId ?? null) !== (ae.buildTargetId ?? null)) diffs.push({ system: "construction", detail: `entity ${id} (${ee.type}).buildTargetId: ${ee.buildTargetId} vs ${ae.buildTargetId}` });
    if (!close(ee.constructionProgress, ae.constructionProgress)) diffs.push({ system: "construction", detail: `entity ${id} (${ee.type}).constructionProgress: ${ee.constructionProgress} vs ${ae.constructionProgress}` });
    if (JSON.stringify(ee.productionQueue) !== JSON.stringify(ae.productionQueue)) diffs.push({ system: "construction", detail: `entity ${id} (${ee.type}).productionQueue differs` });
    const eWorkers = JSON.stringify([...(ee.buildWorkerIds ?? [])].sort());
    const aWorkers = JSON.stringify([...(ae.buildWorkerIds ?? [])].sort());
    if (eWorkers !== aWorkers) diffs.push({ system: "construction", detail: `entity ${id} (${ee.type}).buildWorkerIds: ${eWorkers} vs ${aWorkers}` });

    if (!close(ee.repairProgress, ae.repairProgress)) diffs.push({ system: "repair", detail: `entity ${id} (${ee.type}).repairProgress: ${ee.repairProgress} vs ${ae.repairProgress}` });
    if ((ee.repairTargetId ?? null) !== (ae.repairTargetId ?? null)) diffs.push({ system: "repair", detail: `entity ${id} (${ee.type}).repairTargetId: ${ee.repairTargetId} vs ${ae.repairTargetId}` });

    const eMove = ee.moveTarget ? `${ee.moveTarget.x},${ee.moveTarget.y}` : null;
    const aMove = ae.moveTarget ? `${ae.moveTarget.x},${ae.moveTarget.y}` : null;
    if (eMove !== aMove) {
      // Allow epsilon slack on coordinates before flagging
      if (!ee.moveTarget || !ae.moveTarget || !close(ee.moveTarget.x, ae.moveTarget.x) || !close(ee.moveTarget.y, ae.moveTarget.y)) {
        diffs.push({ system: "movement", detail: `entity ${id} (${ee.type}).moveTarget: ${eMove} vs ${aMove}` });
      }
    }
  }

  for (const id of actualIds) {
    if (!expectedIds.has(id) && preExistingIds.has(id)) {
      diffs.push({ system: "combat", detail: `entity ${id}: present in tick(mirror(s)) but missing in mirror(tick(s)) (death asymmetry)` });
    }
  }

  // ── Match-level result ───────────────────────────────────────────────
  if (expected.phase !== actual.phase) diffs.push({ system: "result", detail: `phase: ${expected.phase} vs ${actual.phase}` });
  if (JSON.stringify(expected.result) !== JSON.stringify(actual.result)) {
    diffs.push({ system: "result", detail: `result: ${JSON.stringify(expected.result)} vs ${JSON.stringify(actual.result)}` });
  }

  return diffs;
}
