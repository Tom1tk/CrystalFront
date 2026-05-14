import type { MatchEngine } from "./matchEngine.js";
import type { MatchState } from "./types.js";

// Import from headless package — relative path since workspaces symlink it
import type { Agent } from "../../../headless/src/types.js";
import { buildObservation } from "../../../headless/src/observation.js";
import { getLegalActions } from "../../../headless/src/legalActions.js";
import { expandMacroAction } from "../../../headless/src/actionSpace.js";

/**
 * Drives a headless Agent in the live server each game tick.
 * Created per-match; call tick() from the LiveMatchRunner's onTick callback.
 */
export class BotPlayer {
  private agent: Agent;
  private botPlayerId: string;
  private matchId: string;
  private engine: MatchEngine;
  private initialised = false;

  constructor(agent: Agent, botPlayerId: string, matchId: string, engine: MatchEngine) {
    this.agent = agent;
    this.botPlayerId = botPlayerId;
    this.matchId = matchId;
    this.engine = engine;
  }

  /** Call this once after the match starts. */
  init(): void {
    if (this.initialised) return;
    const match = this.engine.getMatch(this.matchId);
    if (!match) return;
    this.agent.init(this.botPlayerId, match);
    this.initialised = true;
  }

  /** Call this each tick from the LiveMatchRunner's onTick. */
  tick(): void {
    if (!this.initialised) this.init();
    const match = this.engine.getMatch(this.matchId);
    if (!match || match.phase !== "playing") return;

    const obs = buildObservation(match, this.botPlayerId);
    const legal = getLegalActions(match, this.botPlayerId);
    const actions = this.agent.step(obs, legal);

    for (const action of actions) {
      const commands = expandMacroAction(action, match, this.botPlayerId);
      for (const cmd of commands) {
        this.engine.processCommand(
          this.matchId,
          this.botPlayerId,
          cmd as Parameters<MatchEngine["processCommand"]>[2]
        );
      }
    }
  }
}
