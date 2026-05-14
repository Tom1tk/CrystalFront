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
  outcome: { winner: string | null; ticks: number };
  durationSecs: number;
  version: string;
  timestamp: number;
}

export interface ReplayFile extends ReplayMeta {
  commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }>;
}

export function ensureReplaysDir(): void {
  if (!existsSync(REPLAYS_DIR)) mkdirSync(REPLAYS_DIR, { recursive: true });
}

export function listReplays(): ReplayMeta[] {
  ensureReplaysDir();
  const files = readdirSync(REPLAYS_DIR).filter(f => f.endsWith(".json"));
  const metas: ReplayMeta[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(REPLAYS_DIR, file), "utf8"));
      metas.push({
        id: file.replace(/\.json$/, ""),
        seed: raw.seed,
        blue: raw.blue ?? "?",
        red: raw.red ?? "?",
        outcome: raw.outcome ?? { winner: null, ticks: 0 },
        durationSecs: ((raw.outcome?.ticks ?? 0) * SIMULATION.tickIntervalMs) / 1000,
        version: raw.version ?? "?",
        timestamp: raw.timestamp ?? 0,
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
    const blueId = "replay-blue";
    const redId  = "replay-red";

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
