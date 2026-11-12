/**
 * G-10 M0 T9 (P-8): replay a v2 episode and rebuild its observations.
 *
 * `replayObservations` replays a `V2Replay` the way the runner played it
 * (worker autopilot, observe, masks, the recorded actions through applyV2Pair,
 * k ticks) and hands every decision's observations to `onDecision`. The
 * commands the engine accepts on the way must equal the replay's `commandLog`,
 * so a mismatch in the log is caught too. `replayCommandLog` replays only the
 * command log, as the server's ReplayRunner does.
 */
import { MatchEngine } from "../../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type MatchState, type PlayerSlot } from "../../../server/src/match/types.js";
import { episodeStatus } from "../episode.js";
import * as V2 from "./actions.js";
import * as OBS from "./observation.js";
import { fromWire, type V2Replay } from "./runner.js";

function players(r: V2Replay): [PlayerSlot, PlayerSlot] {
  return [
    { playerId: r.bluePlayerId, username: r.blue, color: "blue", score: 0 },
    { playerId: r.redPlayerId, username: r.red, color: "red", score: 0 },
  ];
}

export interface ReplayObsResult { decisions: number; ticks: number; match: MatchState }

export function replayObservations(
  r: V2Replay,
  onDecision: (i: number, tick: number, obs: [OBS.ObsV2, OBS.ObsV2], terminal: boolean) => void,
): ReplayObsResult {
  if (r.v2.obsSchemaVersion !== OBS.OBS_SCHEMA_VERSION) throw new Error(`replay obs schema ${r.v2.obsSchemaVersion}, this build ${OBS.OBS_SCHEMA_VERSION}`);
  const { k, cap, z } = r.v2;
  const engine = new MatchEngine();
  const match = engine.createMatch("v2-replay", players(r), { ...DEFAULT_CONFIG, mapId: r.mapId, maxTicks: cap }, r.seed);
  engine.startMatch(match.id);
  const ids = [r.bluePlayerId, r.redPlayerId];
  const seats: [V2.SeatState, V2.SeatState] = [V2.createSeatState(match, ids[0]), V2.createSeatState(match, ids[1])];
  const oss = [OBS.createObsState(match, seats[0]), OBS.createObsState(match, seats[1])];
  const observeBoth = () => [0, 1].map((i) => OBS.observe(match, seats[i], oss[i], { z: z[i], cap })) as [OBS.ObsV2, OBS.ObsV2];

  let decisions = 0;
  for (const a of r.v2.actions) {
    if (a.tick !== match.tick) throw new Error(`action recorded at tick ${a.tick}, replay is at ${match.tick}`);
    for (const s of seats) V2.workerAutopilot(engine, match, s);
    const obs = observeBoth();
    for (const s of seats) V2.computeMasks(match, s);
    onDecision(decisions++, match.tick, obs, false);
    const acts = [fromWire(a.blue), fromWire(a.red)];
    if (!acts[0] || !acts[1]) throw new Error(`malformed action at tick ${a.tick}`);
    V2.applyV2Pair(engine, match, seats, [acts[0], acts[1]]);
    let st = episodeStatus(match, cap);
    for (let t = 0; t < k && !st.terminated && !st.truncated; t++) {
      engine.tick(match.id);
      st = episodeStatus(match, cap);
    }
  }
  onDecision(decisions, match.tick, observeBoth(), true);
  const log = match.commandLog;
  for (let i = 0; i < Math.max(log.length, r.commandLog.length); i++) {
    if (JSON.stringify(log[i]) !== JSON.stringify(r.commandLog[i])) {
      throw new Error(`command ${i} differs: replay ${JSON.stringify(r.commandLog[i])}, replayed ${JSON.stringify(log[i])}`);
    }
  }
  if (match.tick !== r.outcome.ticks) throw new Error(`replay ended at tick ${r.outcome.ticks}, replayed to ${match.tick}`);
  return { decisions, ticks: match.tick, match };
}

/**
 * Replay only the command log, as the server's ReplayRunner does (same config,
 * same loop). The server's config has no tick cap, so a truncated episode's last
 * tick differs (the runner's match ends there); every earlier tick is the same.
 */
export function replayCommandLog(r: V2Replay, onTick?: (match: MatchState) => void): MatchState {
  const engine = new MatchEngine();
  const match = engine.createMatch("replay", players(r), { ...DEFAULT_CONFIG, mapId: r.mapId }, r.seed);
  engine.startMatch(match.id);
  const byTick = new Map<number, V2Replay["commandLog"]>();
  for (const e of r.commandLog) {
    if (!byTick.has(e.tick)) byTick.set(e.tick, []);
    byTick.get(e.tick)!.push(e);
  }
  while (match.phase === "playing" && match.tick < r.outcome.ticks) {
    for (const e of byTick.get(match.tick) ?? []) engine.processCommand(match.id, e.playerId, e.command as Parameters<MatchEngine["processCommand"]>[2]);
    engine.tick(match.id);
    onTick?.(match);
  }
  return match;
}
