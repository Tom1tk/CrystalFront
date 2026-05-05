import type { PlayerId, LobbyState, MatchState, ClientCommand, EntityType, BuildingType } from "./types.js";

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
} as const;

export const SERVER_EVT = {
  CONNECTED: "connected",
  ERROR: "error",
  LOBBY_STATE: "lobby_state",
  MATCH_END: "match_end",
  HOST_DISCONNECT: "host_disconnect",
  MATCH_START: "match_start",
  GAME_STATE: "game_state",
} as const;

export type ClientToServerMsg =
  | { type: typeof CLIENT_MSG.JOIN_LOBBY; payload: { code: string; username: string } }
  | { type: typeof CLIENT_MSG.CREATE_LOBBY; payload: { username: string } }
  | { type: typeof CLIENT_MSG.READY_TOGGLE }
  | { type: typeof CLIENT_MSG.LEAVE_LOBBY }
  | { type: typeof CLIENT_MSG.DEBUG_WIN; payload: { winner: "player1" | "player2" | "self" } }
  | { type: typeof CLIENT_MSG.DEBUG_SPAWN; payload: { entityType: EntityType; buildingType?: BuildingType; x: number; y: number } }
  | { type: typeof CLIENT_MSG.USERNAME; payload: { username: string } }
  | { type: typeof CLIENT_MSG.GAME_COMMAND; payload: ClientCommand }
  | { type: typeof CLIENT_MSG.MATCH_START }
  | { type: typeof CLIENT_MSG.START_SOLO_TEST; payload: { username: string } };

export type ServerToClientMsg =
  | { type: typeof SERVER_EVT.CONNECTED; payload: { playerId: PlayerId } }
  | { type: typeof SERVER_EVT.ERROR; payload: { message: string } }
  | { type: typeof SERVER_EVT.LOBBY_STATE; payload: { lobby: LobbyState } }
  | { type: typeof SERVER_EVT.MATCH_END; payload: { winner: PlayerId } }
  | { type: typeof SERVER_EVT.HOST_DISCONNECT; payload: { message: string } }
  | { type: typeof SERVER_EVT.MATCH_START; payload: { match: MatchState } }
  | { type: typeof SERVER_EVT.GAME_STATE; payload: { match: MatchState } };
