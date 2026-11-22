/** Tournament state shared by server and client (docs/TOURNAMENT_SPEC.md). Tokens never leave the server. */
import type { TournamentFormat } from "./bracket.js";

export type SeriesLength = 1 | 3 | 5;

export interface TournamentSettings {
  name: string;
  /** Fixed at the start. Tournaments saved before formats existed are Swiss. */
  format: TournamentFormat;
  /** Planned rounds (Swiss: the manager can add or remove remaining ones; other formats: set at the start). */
  rounds: number;
  seeding: "random" | "manual";
  bestOf: SeriesLength;
  /** Per-round override of `bestOf`, keyed by round number (1-based). */
  roundBestOf: Record<number, SeriesLength>;
  mapPool: string[];
  readySeconds: number;
  /** Next round starts after `advanceSeconds` (true) or waits for the manager (false). */
  autoAdvance: boolean;
  advanceSeconds: number;
  /** Spectator delay, 30–60 s. */
  spectatorDelay: number;
}

export interface TournamentEntrant {
  id: string;
  name: string;
  seed: number;
  /** Server bot id (scripted, neural 0.9, neural beta); unset for humans. */
  bot?: string;
  withdrawn?: boolean;
  /** Round the entrant joined before (1 = from the start). */
  joinedRound: number;
}

export type GameOutcome = "a" | "b" | "draw";

export interface TournamentGame {
  map: string;
  /** Entrant id of blue in this game. */
  blue: string;
  result?: GameOutcome;
  winType?: string;
  replayId?: string;
  /** Live match id while it is being played. */
  matchId?: string;
  /** How the result was decided when not by play. */
  decided?: "no_show" | "forfeit" | "adjudicated";
}

export type SeriesStatus = "waiting" | "ready_check" | "playing" | "interrupted" | "done";

export interface TournamentSeries {
  slot: number;
  /** Blue in game 1. */
  a: string;
  /** null = bye. */
  b: string | null;
  bestOf: SeriesLength;
  status: SeriesStatus;
  games: TournamentGame[];
  /** Ready-check state for the next game. */
  ready: { a: boolean; b: boolean };
  /** Ready-check deadline (ms epoch). */
  deadline?: number;
  result?: "a" | "b" | "draw" | "both_lose" | "void";
  /** Elimination: the bracket node this series plays, and its name ("Semi-final", "Losers R2"). */
  node?: string;
  label?: string;
}

export interface TournamentRound {
  number: number;
  map: string;
  bestOf: SeriesLength;
  series: TournamentSeries[];
}

export type TournamentStatus = "registering" | "running" | "finished" | "cancelled";

export interface TournamentStanding {
  id: string;
  rank: number;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  buchholz: number;
  sb: number;
  gameDiff: number;
  /** Elimination: where this player was knocked out. */
  outIn?: string;
}

/** What every viewer receives. */
export interface TournamentPublicState {
  id: string;
  code: string;
  status: TournamentStatus;
  settings: TournamentSettings;
  entrants: TournamentEntrant[];
  locked: boolean;
  paused: boolean;
  rounds: TournamentRound[];
  standings: TournamentStanding[];
  /** When the next round will be paired (auto-advance countdown), ms epoch. */
  nextRoundAt?: number;
  createdAt: number;
  finishedAt?: number;
  /** Manager's entrant id, if the manager entered. */
  managerEntrant?: string;
}

/** Added to the state sent to one connection. */
export interface TournamentViewer {
  isManager: boolean;
  /** This viewer's entrant id, if registered. */
  entrantId?: string;
}

export interface TournamentSummary {
  id: string;
  code: string;
  name: string;
  status: TournamentStatus;
  entrants: number;
  round: number;
  rounds: number;
  format: TournamentFormat;
  createdAt: number;
}

export const TOURNAMENT_LIMITS = { maxEntrants: 32, minEntrants: 2, delayMin: 30, delayMax: 60, readyMin: 15, readyMax: 300 } as const;

export const DEFAULT_TOURNAMENT_SETTINGS: Omit<TournamentSettings, "name" | "rounds" | "mapPool"> = {
  format: "single",
  seeding: "random",
  bestOf: 1,
  roundBestOf: {},
  readySeconds: 60,
  autoAdvance: true,
  advanceSeconds: 60,
  spectatorDelay: 45,
};
