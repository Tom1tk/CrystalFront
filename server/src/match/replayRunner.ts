import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { WebSocket } from "ws";
import { MatchEngine } from "./matchEngine.js";
import { DEFAULT_CONFIG } from "./types.js";
import { SIMULATION } from "@crystalfront/shared";

const REPLAYS_DIR = resolve(process.cwd(), "replays");

export interface ReplayMeta {
  id: string;        // filename without .json
  seed: number;
  blue: string;
  red: string;
  outcome: { winner: string | null; winType?: string | null; ticks: number };
  durationSecs: number;
  version: string;
  timestamp: number;
  // Phase 5 — enriched metadata extracted from commandLog
  winType?: string | null;
  blueUnits?: Record<string, number>;     // e.g. { skirmisher: 5, worker: 4 }
  redUnits?: Record<string, number>;
  blueBuildings?: Record<string, number>; // e.g. { barracks: 1, turret: 2 }
  redBuildings?: Record<string, number>;
  buildOrderBlue?: string[];              // first 6 buildings built, in order
  buildOrderRed?: string[];
  firstCombatTick?: number;               // first tick any combat unit was trained
  flags?: string[];                       // auto-flag: "fast", "lopsided", "resource_win"
}

export interface ReplayFile extends ReplayMeta {
  commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }>;
}

export function ensureReplaysDir(): void {
  if (!existsSync(REPLAYS_DIR)) mkdirSync(REPLAYS_DIR, { recursive: true });
}

/**
 * ── Phase 5 ── Analyse a replay's commandLog and extract enriched metadata.
 *
 * Build orders, unit composition, and first-combat-tick are derived from
 * the append-only command log.  This runs fast — just a single pass over
 * the command array.
 */
interface EnrichedMetadata {
  winType: string | null;
  blueUnits: Record<string, number>;
  redUnits: Record<string, number>;
  blueBuildings: Record<string, number>;
  redBuildings: Record<string, number>;
  buildOrderBlue: string[];
  buildOrderRed: string[];
  firstCombatTick: number | null;
  flags: string[];
}

const UNIT_TYPES = ["skirmisher", "gunner", "bruiser", "medic", "worker"];
const BUILDING_TYPES = ["barracks", "foundry", "supply_depot", "turret"];

const FLAG_FAST_TICKS    = 600;   // games ending before this get "fast" flag
const FLAG_LOPSIDED_MIN  = 6;     // unit-count disparity >= this gets "lopsided"
const FLAG_SCRAPPY_MIN   = 20;    // total combat units trained across both sides

function analyzeReplay(raw: Record<string, unknown>): EnrichedMetadata {
  const cmdLog = (raw.commandLog ?? []) as Array<{
    tick: number;
    playerId: string;
    command: Record<string, unknown>;
  }>;

  const blueId = (raw.bluePlayerId as string) ?? "headless-blue";
  const redId  = (raw.redPlayerId  as string) ?? "headless-red";

  const blueUnits: Record<string, number> = {};
  const redUnits: Record<string, number> = {};
  const blueBuildings: Record<string, number> = {};
  const redBuildings: Record<string, number> = {};
  const buildOrderBlue: string[] = [];
  const buildOrderRed: string[]   = [];
  let firstCombatTick: number | null = null;

  for (const entry of cmdLog) {
    const cmd = entry.command;
    const isBlue = entry.playerId === blueId;
    const isRed  = entry.playerId === redId;

    // Unit training
    if (cmd.type === "train_unit" && typeof cmd.unitType === "string") {
      if (isBlue) {
        blueUnits[cmd.unitType] = (blueUnits[cmd.unitType] ?? 0) + 1;
      } else if (isRed) {
        redUnits[cmd.unitType] = (redUnits[cmd.unitType] ?? 0) + 1;
      }
      // First combat unit trained
      if (firstCombatTick === null && UNIT_TYPES.slice(0, 4).includes(cmd.unitType)) {
        firstCombatTick = entry.tick;
      }
    }

    // Worker training
    if (cmd.type === "train_worker") {
      if (isBlue) blueUnits["worker"] = (blueUnits["worker"] ?? 0) + 1;
      else if (isRed) redUnits["worker"] = (redUnits["worker"] ?? 0) + 1;
    }

    // Building construction
    if (cmd.type === "build" && typeof cmd.buildingType === "string") {
      if (isBlue) {
        blueBuildings[cmd.buildingType] = (blueBuildings[cmd.buildingType] ?? 0) + 1;
        if (buildOrderBlue.length < 6) buildOrderBlue.push(cmd.buildingType);
      } else if (isRed) {
        redBuildings[cmd.buildingType] = (redBuildings[cmd.buildingType] ?? 0) + 1;
        if (buildOrderRed.length < 6) buildOrderRed.push(cmd.buildingType);
      }
    }
  }

  // Win type
  const outcome = raw.outcome as Record<string, unknown> | undefined;
  const winType = (outcome?.winType as string) ?? null;

  // Auto-flagging
  const ticks = (outcome?.ticks as number) ?? 0;
  const flags: string[] = [];
  if (ticks > 0 && ticks <= FLAG_FAST_TICKS) flags.push("fast");

  const COMBAT_TYPES = ["skirmisher", "gunner", "bruiser", "medic"] as const;
  const blueTotal   = Object.values(blueUnits).reduce((a, b) => a + b, 0);
  const redTotal    = Object.values(redUnits).reduce((a, b) => a + b, 0);
  if (Math.abs(blueTotal - redTotal) >= FLAG_LOPSIDED_MIN) flags.push("lopsided");
  if (winType === "resource") flags.push("resource_win");

  const blueCombat = COMBAT_TYPES.reduce((s, t) => s + (blueUnits[t] ?? 0), 0);
  const redCombat  = COMBAT_TYPES.reduce((s, t) => s + (redUnits[t] ?? 0), 0);
  if (blueCombat + redCombat >= FLAG_SCRAPPY_MIN) flags.push("scrappy");

  return {
    winType,
    blueUnits, redUnits,
    blueBuildings, redBuildings,
    buildOrderBlue, buildOrderRed,
    firstCombatTick,
    flags,
  };
}

export function listReplays(): ReplayMeta[] {
  ensureReplaysDir();
  const files = readdirSync(REPLAYS_DIR).filter(f => f.endsWith(".json"));
  const metas: ReplayMeta[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(REPLAYS_DIR, file), "utf8"));
      const enriched = analyzeReplay(raw);
      const outcome = raw.outcome ?? { winner: null, ticks: 0 };
      metas.push({
        id: file.replace(/\.json$/, ""),
        seed: raw.seed,
        blue: raw.blue ?? "?",
        red: raw.red ?? "?",
        outcome: {
          winner: outcome.winner ?? null,
          winType: outcome.winType ?? null,
          ticks: outcome.ticks ?? 0,
        },
        durationSecs: ((outcome.ticks ?? 0) * SIMULATION.tickIntervalMs) / 1000,
        version: raw.version ?? "?",
        timestamp: raw.timestamp ?? 0,
        winType: enriched.winType,
        blueUnits: enriched.blueUnits,
        redUnits: enriched.redUnits,
        blueBuildings: enriched.blueBuildings,
        redBuildings: enriched.redBuildings,
        buildOrderBlue: enriched.buildOrderBlue,
        buildOrderRed: enriched.buildOrderRed,
        firstCombatTick: enriched.firstCombatTick ?? undefined,
        flags: enriched.flags,
      });
    } catch {
      // skip corrupt files
    }
  }

  return metas.sort((a, b) => b.timestamp - a.timestamp);
}

export function getReplay(id: string): ReplayFile | null {
  ensureReplaysDir();
  const filePath = join(REPLAYS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    return {
      id,
      seed: raw.seed,
      blue: raw.blue ?? "?",
      red: raw.red ?? "?",
      outcome: raw.outcome ?? { winner: null, ticks: 0 },
      durationSecs: ((raw.outcome?.ticks ?? 0) * SIMULATION.tickIntervalMs) / 1000,
      version: raw.version ?? "?",
      timestamp: raw.timestamp ?? 0,
      commandLog: raw.commandLog ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Streams a replay to a single WebSocket observer at real-time speed.
 * The observer receives MATCH_START then GAME_STATE each tick (full/unfiltered state).
 */
export class ReplayRunner {
  private intervals = new Map<string, NodeJS.Timeout>();
  private engine = new MatchEngine();

  start(
    replay: ReplayFile,
    ws: WebSocket,
    onEnd: (matchId: string) => void
  ): string {
    // Use the original player IDs so entity ownership checks in processCommand pass.
    const blueId = (replay as { bluePlayerId?: string }).bluePlayerId ?? "headless-blue";
    const redId  = (replay as { redPlayerId?: string }).redPlayerId  ?? "headless-red";

    const players: [import("./types.js").PlayerSlot | null, import("./types.js").PlayerSlot | null] = [
      { playerId: blueId, username: replay.blue, color: "blue", score: 0 },
      { playerId: redId,  username: replay.red,  color: "red",  score: 0 },
    ];

    const match = this.engine.createMatch("replay", players, DEFAULT_CONFIG, replay.seed);
    this.engine.startMatch(match.id);

    // Group commandLog by tick for fast lookup
    const cmdsByTick = new Map<number, Array<{ playerId: string; command: Record<string, unknown> }>>();
    for (const entry of replay.commandLog) {
      if (!cmdsByTick.has(entry.tick)) cmdsByTick.set(entry.tick, []);
      cmdsByTick.get(entry.tick)!.push({ playerId: entry.playerId, command: entry.command });
    }

    const totalTicks = replay.outcome.ticks;

    // Send MATCH_START immediately
    send(ws, {
      type: "match_start",
      payload: { match: serializeMatch(match) },
    });

    let subStepCount = 0;
    const subStepMs = SIMULATION.subStepMs;
    const fullTickMs = 100;
    const stepsPerTick = fullTickMs / subStepMs;

    const interval = setInterval(() => {
      const m = this.engine.getMatch(match.id);
      if (!m || m.phase !== "playing") {
        this._finish(match.id, interval, ws, m?.tick ?? 0, m?.result?.winner ?? null, onEnd);
        return;
      }

      subStepCount++;
      if (subStepCount % stepsPerTick === 0) {
        // Apply commands for this tick
        const cmds = cmdsByTick.get(m.tick) ?? [];
        for (const { playerId, command } of cmds) {
          this.engine.processCommand(match.id, playerId, command as Parameters<MatchEngine["processCommand"]>[2]);
        }

        this.engine.tick(match.id);

        send(ws, {
          type: "game_state",
          payload: { match: serializeMatch(this.engine.getMatch(match.id) ?? m), isReplay: true },
        });

        // End when we've replayed all recorded ticks
        if (m.tick >= totalTicks) {
          this._finish(match.id, interval, ws, m.tick, m.result?.winner ?? null, onEnd);
        }
      } else {
        this.engine.subStepMovement(match.id);
      }
    }, subStepMs);

    this.intervals.set(match.id, interval);
    return match.id;
  }

  stop(matchId: string): void {
    const interval = this.intervals.get(matchId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(matchId);
    }
    this.engine.destroyMatch(matchId);
  }

  private _finish(
    matchId: string,
    interval: NodeJS.Timeout,
    ws: WebSocket,
    ticks: number,
    winner: string | null,
    onEnd: (matchId: string) => void
  ): void {
    clearInterval(interval);
    this.intervals.delete(matchId);
    send(ws, { type: "replay_end", payload: { ticks, winner } });
    this.engine.destroyMatch(matchId);
    onEnd(matchId);
  }
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Minimal serialisation for replay — includes full entity list (observer view, no fog). */
function serializeMatch(match: import("./types.js").MatchState | undefined): Record<string, unknown> {
  if (!match) return {};
  return {
    id: match.id,
    lobbyCode: match.lobbyCode,
    phase: match.phase,
    tick: match.tick,
    tickIntervalMs: match.tickIntervalMs,
    stateTimestamp: Date.now(),
    players: match.players,
    entities: Array.from(match.entities.values()).map(e => ({
      id: e.id, type: e.type, ownerId: e.ownerId,
      x: e.x, y: e.y, health: e.health, maxHealth: e.maxHealth,
      radius: e.radius, color: e.color,
      buildingType: e.buildingType,
      constructionProgress: e.constructionProgress,
      buildWorkerIds: e.buildWorkerIds ? Array.from(e.buildWorkerIds) : undefined,
      buildTargetId: e.buildTargetId,
      gatheringNodeId: e.gatheringNodeId,
      productionQueue: e.productionQueue,
      repairTargetId: e.repairTargetId,
      moveTarget: e.moveTarget,
      attackTargetId: e.attackTargetId,
      attackCooldown: e.attackCooldown,
      healTargetId: e.healTargetId,
      autoAttackEnabled: e.autoAttackEnabled,
      rallyPoint: e.rallyPoint,
    })),
    attackLog: match.attackLog,
    result: match.result,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    economy: match.economy,
    resourceNodes: match.resourceNodes.map(n => ({
      id: n.id, x: n.x, y: n.y, radius: n.radius,
      color: n.color, capacity: n.capacity, remaining: n.remaining,
    })),
    config: {
      mapWidth: match.config.mapWidth,
      mapHeight: match.config.mapHeight,
      viewportWidth: match.config.viewportWidth,
      viewportHeight: match.config.viewportHeight,
    },
    mapWidth: match.config.mapWidth,
    mapHeight: match.config.mapHeight,
  };
}
