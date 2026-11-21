import type { PlayerId, LobbyState, MatchState, ClientCommand, EntityType, BuildingType, Ruleset, WinType } from "./types.js";
import type { TournamentPublicState, TournamentSettings, TournamentViewer } from "./tournament.js";

export const WS_EVENT = {
  CONNECTED: "connected",
  ERROR: "error",
  LOBBY_STATE: "lobby_state",
  JOIN_LOBBY: "join_lobby",
  CREATE_LOBBY: "create_lobby",
  READY_TOGGLE: "ready_toggle",
  LEAVE_LOBBY: "leave_lobby",
  DEBUG_WIN: "debug_win",
  DEBUG_SPAWN: "debug_spawn",
  MATCH_END: "match_end",
  HOST_DISCONNECT: "host_disconnect",
  MATCH_START: "match_start",
  GAME_STATE: "game_state",
  GAME_COMMAND: "game_command",
  SET_MAP: "set_map",
  START_REPLAY: "start_replay",
  STOP_REPLAY: "stop_replay",
  REPLAY_END: "replay_end",
  REPLAY_SPEED: "replay_speed",
  /** The client finished loading the match (3D assets); the server starts it when all have. */
  CLIENT_LOADED: "client_loaded",
  /** Which players have finished loading a new match (sent while it waits to start). */
  LOAD_STATUS: "load_status",
  TOURNAMENT_CREATE: "tournament_create",
  TOURNAMENT_JOIN: "tournament_join",
  TOURNAMENT_LEAVE: "tournament_leave",
  TOURNAMENT_READY: "tournament_ready",
  TOURNAMENT_WATCH: "tournament_watch",
  TOURNAMENT_UNWATCH: "tournament_unwatch",
  TOURNAMENT_PLAY: "tournament_play",
  TOURNAMENT_SPECTATE: "tournament_spectate",
  TOURNAMENT_ADMIN: "tournament_admin",
  TOURNAMENT_STATE: "tournament_state",
  TOURNAMENT_MATCH_READY: "tournament_match_ready",
  TOURNAMENT_MATCH_START: "tournament_match_start",
  TOURNAMENT_ERROR: "tournament_error",
} as const;

export const CLIENT_MSG = {
  JOIN_LOBBY: "join_lobby",
  CREATE_LOBBY: "create_lobby",
  READY_TOGGLE: "ready_toggle",
  LEAVE_LOBBY: "leave_lobby",
  DEBUG_WIN: "debug_win",
  DEBUG_SPAWN: "debug_spawn",
  USERNAME: "username",
  GAME_COMMAND: "game_command",
  MATCH_START: "match_start",
  START_SOLO_TEST: "start_solo_test",
  START_BOT_GAME: "start_bot_game",
  SET_MAP: "set_map",
  START_REPLAY: "start_replay",
  STOP_REPLAY: "stop_replay",
  REPLAY_SPEED: "replay_speed",
  /** The client finished loading the match (3D assets); the server starts it when all have. */
  CLIENT_LOADED: "client_loaded",
  TOURNAMENT_CREATE: "tournament_create",
  TOURNAMENT_JOIN: "tournament_join",
  TOURNAMENT_LEAVE: "tournament_leave",
  TOURNAMENT_READY: "tournament_ready",
  /** Subscribe to a tournament's dashboard (anyone, no join needed). */
  TOURNAMENT_WATCH: "tournament_watch",
  TOURNAMENT_UNWATCH: "tournament_unwatch",
  /** Join (or rejoin after a reconnect) this player's live tournament match. */
  TOURNAMENT_PLAY: "tournament_play",
  /** Watch a live series' current game, delayed by the tournament's spectator delay. */
  TOURNAMENT_SPECTATE: "tournament_spectate",
  TOURNAMENT_ADMIN: "tournament_admin",
} as const;

export const SERVER_EVT = {
  CONNECTED: "connected",
  ERROR: "error",
  LOBBY_STATE: "lobby_state",
  MATCH_END: "match_end",
  HOST_DISCONNECT: "host_disconnect",
  MATCH_START: "match_start",
  GAME_STATE: "game_state",
  REPLAY_END: "replay_end",
  /** Which players have finished loading a new match (sent while it waits to start). */
  LOAD_STATUS: "load_status",
  TOURNAMENT_STATE: "tournament_state",
  /** Ready check for this player's next tournament game. */
  TOURNAMENT_MATCH_READY: "tournament_match_ready",
  /** This player's tournament game has been created: reply with TOURNAMENT_PLAY to enter it. */
  TOURNAMENT_MATCH_START: "tournament_match_start",
  TOURNAMENT_ERROR: "tournament_error",
} as const;

export type ClientToServerMsg =
  | { type: typeof CLIENT_MSG.JOIN_LOBBY; payload: { code: string; username: string } }
  | { type: typeof CLIENT_MSG.CREATE_LOBBY; payload: { username: string; ruleset?: Ruleset } }
  | { type: typeof CLIENT_MSG.READY_TOGGLE }
  | { type: typeof CLIENT_MSG.LEAVE_LOBBY }
  | { type: typeof CLIENT_MSG.DEBUG_WIN; payload: { winner: "player1" | "player2" | "self" } }
  | { type: typeof CLIENT_MSG.DEBUG_SPAWN; payload: { entityType: EntityType; buildingType?: BuildingType; x: number; y: number } }
  | { type: typeof CLIENT_MSG.USERNAME; payload: { username: string } }
  | { type: typeof CLIENT_MSG.GAME_COMMAND; payload: ClientCommand }
  | { type: typeof CLIENT_MSG.MATCH_START }
  | { type: typeof CLIENT_MSG.START_SOLO_TEST; payload: { username: string; difficulty?: "easy" | "medium" | "hard"; mapId?: string; ruleset?: Ruleset } }
  | { type: typeof CLIENT_MSG.START_BOT_GAME; payload: { username: string; bot: string; mapId?: string; ruleset?: Ruleset } }
  | { type: typeof CLIENT_MSG.SET_MAP; payload: { mapId: string } }
  | { type: typeof CLIENT_MSG.START_REPLAY; payload: { replayId: string } }
  | { type: typeof CLIENT_MSG.STOP_REPLAY }
  | { type: typeof CLIENT_MSG.REPLAY_SPEED; payload: { speed: number } }
  | { type: typeof CLIENT_MSG.CLIENT_LOADED }
  | { type: typeof CLIENT_MSG.TOURNAMENT_CREATE; payload: { token: string; settings: Partial<TournamentSettings> & { name: string } } }
  | { type: typeof CLIENT_MSG.TOURNAMENT_JOIN; payload: { code: string; username: string; token: string } }
  | { type: typeof CLIENT_MSG.TOURNAMENT_LEAVE; payload: { code: string; token: string } }
  | { type: typeof CLIENT_MSG.TOURNAMENT_READY; payload: { code: string; token: string } }
  | { type: typeof CLIENT_MSG.TOURNAMENT_WATCH; payload: { code: string; token?: string } }
  | { type: typeof CLIENT_MSG.TOURNAMENT_UNWATCH }
  | { type: typeof CLIENT_MSG.TOURNAMENT_PLAY; payload: { code: string; token: string } }
  | { type: typeof CLIENT_MSG.TOURNAMENT_SPECTATE; payload: { code: string; slot: number; token?: string } }
  | { type: typeof CLIENT_MSG.TOURNAMENT_ADMIN; payload: { code: string; token: string; op: string; [arg: string]: unknown } };

export type ServerToClientMsg =
  | { type: typeof SERVER_EVT.CONNECTED; payload: { playerId: PlayerId } }
  | { type: typeof SERVER_EVT.ERROR; payload: { message: string } }
  | { type: typeof SERVER_EVT.LOBBY_STATE; payload: { lobby: LobbyState } }
  | { type: typeof SERVER_EVT.MATCH_END; payload: { winner: PlayerId | null; winType?: WinType; replayId?: string } }
  | { type: typeof SERVER_EVT.HOST_DISCONNECT; payload: { message: string } }
  | { type: typeof SERVER_EVT.MATCH_START; payload: { match: MatchState } }
  | { type: typeof SERVER_EVT.GAME_STATE; payload: { match: MatchState } }
  | { type: typeof SERVER_EVT.REPLAY_END; payload: { ticks: number; winner: string | null } }
  | { type: typeof SERVER_EVT.LOAD_STATUS; payload: { loaded: PlayerId[] } }
  | { type: typeof SERVER_EVT.TOURNAMENT_STATE; payload: { state: TournamentPublicState; viewer: TournamentViewer } }
  | { type: typeof SERVER_EVT.TOURNAMENT_MATCH_READY; payload: { code: string; round: number; slot: number; game: number; opponent: string; map: string; side: "blue" | "red"; deadline: number } }
  | { type: typeof SERVER_EVT.TOURNAMENT_MATCH_START; payload: { code: string; round: number; slot: number; game: number } }
  | { type: typeof SERVER_EVT.TOURNAMENT_ERROR; payload: { message: string } };
