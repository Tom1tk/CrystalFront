import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
import { indexToAction, legalMask, ACTION_SPACE_SIZE } from "../actionIndex.js";
import * as ort from "onnxruntime-node";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// models/ lives at repo root — two levels above headless/src/bots/
const MODEL_PATH = resolve(__dirname, "..", "..", "..", "models", "policy-v0.3.2-ML.onnx");

// Global keys in the canonical order matching crystalfront_env.py:GLOBAL_KEYS
const GLOBAL_KEYS = [
  "ownResources", "ownSupply", "ownMaxSupply", "oppVisibleSupply",
  "tick", "scoreDiff",
  "ownCrystalHealthFrac", "oppCrystalHealthFrac",
  "ownResourcesWinFrac", "oppResourcesWinFrac",
  "ownLifetimeResourcesFrac", "oppLifetimeResourcesFrac",
  "enemyWorkerCount", "enemySkirmisherCount", "enemyBruiserCount",
  "enemyBarracksCount", "enemyTurretCount", "enemyForwardUnitFrac",
  "nearestEnemyToCrystalDistNorm", "ownCombatInOwnHalf",
  "enemyCombatInOwnHalf", "totalVisibleEnemyCombat",
] as const;

const MAX_ENTITIES = 64;
const MAX_NODES    = 8;
const GLOBAL_DIM   = GLOBAL_KEYS.length; // 22

/**
 * MlBot — in-game agent backed by the v0.3.2-ML ONNX policy.
 *
 * Empirical win-rates (100 deterministic episodes, full 6000px map):
 *   idle           100%   passive        100%
 *   rush_weak       86%   rush_weak_medium 99%
 *   rush_medium      0%   rush             1%
 *   turtle           0%   macro           99%
 *
 * Intended difficulty tier: easy/medium (beats passive and weak-rush reliably).
 *
 * Async note: ONNX inference is async but step() is sync (BotPlayer requirement).
 * Strategy: return lastAction immediately, update it after the async result
 * arrives. The 1-tick lag is imperceptible at the game's tick rate.
 */
export class MlBot implements Agent {
  private session: ort.InferenceSession | null = null;
  private lastAction: MacroAction = { type: "noop" };
  private pendingInference = false;

  static async create(): Promise<MlBot> {
    const bot = new MlBot();
    bot.session = await ort.InferenceSession.create(MODEL_PATH);
    return bot;
  }

  private isRed = false;

  init(playerId: string, match: MatchState): void {
    this.lastAction = { type: "noop" };
    this.pendingInference = false;
    const playerIdx = match?.players?.findIndex((p: any) => p?.playerId === playerId) ?? -1;
    this.isRed = playerIdx >= 0 && (match.players[playerIdx] as any)?.color === "red";
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    if (!this.session || this.pendingInference) {
      return [this.lastAction];
    }

    const feeds = this._buildFeeds(obs);
    const mask  = legalMask(legal);

    this.pendingInference = true;
    this.session.run(feeds).then(results => {
      const logits = results["action_logits"].data as Float32Array;

      // Apply legal-action mask: illegal → -1e9
      let bestIdx = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < ACTION_SPACE_SIZE; i++) {
        const v = mask[i] ? logits[i] : -1e9;
        if (v > bestVal) { bestVal = v; bestIdx = i; }
      }

      this.lastAction = indexToAction(bestIdx);
      this.pendingInference = false;
    }).catch(() => {
      this.pendingInference = false;
    });

    return [this.lastAction];
  }

  private _buildFeeds(obs: PlayerObservation): Record<string, ort.Tensor> {
    // Policy trained as blue (left side, low xNorm). Mirror x when playing as red.
    const mx = this.isRed ? (x: number) => 1 - x : (x: number) => x;
    const g  = obs.global as Record<string, number>;

    // Global vector — 22 floats in canonical key order
    const globalArr = new Float32Array(GLOBAL_DIM);
    for (let i = 0; i < GLOBAL_KEYS.length; i++) {
      globalArr[i] = g[GLOBAL_KEYS[i]] ?? 0;
    }

    // Entity matrix — (MAX_ENTITIES, 12)
    const entityArr  = new Float32Array(MAX_ENTITIES * 12);
    const maskArr    = new Uint8Array(MAX_ENTITIES);   // bool as uint8
    const ents = (obs as any).entities as any[] ?? [];
    const n = Math.min(ents.length, MAX_ENTITIES);
    for (let i = 0; i < n; i++) {
      const e = ents[i];
      const base = i * 12;
      entityArr[base + 0]  = e.typeIndex         ?? 0;
      entityArr[base + 1]  = e.owner             ?? 0;
      entityArr[base + 2]  = mx(e.xNorm          ?? 0);  // mirrored when red
      entityArr[base + 3]  = e.yNorm             ?? 0;
      entityArr[base + 4]  = e.healthFrac        ?? 0;
      entityArr[base + 5]  = e.constructionFrac  ?? 0;
      entityArr[base + 6]  = e.isAttacking ? 1 : 0;
      entityArr[base + 7]  = e.isMoving    ? 1 : 0;
      entityArr[base + 8]  = e.isGathering ? 1 : 0;
      entityArr[base + 9]  = e.isBuilding  ? 1 : 0;
      entityArr[base + 10] = e.attackCooldownNorm ?? 0;
      entityArr[base + 11] = e.inAttackRange ? 1 : 0;
      maskArr[i] = 1;
    }

    // Node matrix — (MAX_NODES, 5)
    const nodeArr     = new Float32Array(MAX_NODES * 5);
    const nodeMaskArr = new Uint8Array(MAX_NODES);
    const nodeList = (obs as any).nodes as any[] ?? [];
    const nn = Math.min(nodeList.length, MAX_NODES);
    for (let i = 0; i < nn; i++) {
      const nd = nodeList[i];
      const base = i * 5;
      nodeArr[base + 0] = mx(nd.xNorm       ?? 0);  // mirrored when red
      nodeArr[base + 1] = nd.yNorm          ?? 0;
      nodeArr[base + 2] = nd.remainingFrac  ?? 0;
      nodeArr[base + 3] = nd.gathererCount  ?? 0;
      nodeArr[base + 4] = nd.isContested ? 1 : 0;
      nodeMaskArr[i] = 1;
    }

    return {
      "global":      new ort.Tensor("float32", globalArr,  [1, GLOBAL_DIM]),
      "entities":    new ort.Tensor("float32", entityArr,  [1, MAX_ENTITIES, 12]),
      "entity_mask": new ort.Tensor("bool",    maskArr,    [1, MAX_ENTITIES]),
      "nodes":       new ort.Tensor("float32", nodeArr,    [1, MAX_NODES, 5]),
      "node_mask":   new ort.Tensor("bool",    nodeMaskArr,[1, MAX_NODES]),
    };
  }
}
