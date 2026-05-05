import {
  LOBBY_CODE_LENGTH,
  LOBBY_CODE_CHARS,
  MAX_PLAYERS_PER_LOBBY,
} from "@crystalfront/shared";
import type { Lobby, Player, PlayerId, LobbyCode } from "@crystalfront/shared";

function generateLobbyCode(): LobbyCode {
  const chars = LOBBY_CODE_CHARS;
  let code = "";
  for (let i = 0; i < LOBBY_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createPlayer(username: string, color: "blue" | "red", isHost = false): Player {
  return {
    id: crypto.randomUUID(),
    username,
    color,
    ready: false,
    score: 0,
  };
}

export class LobbyManager {
  private lobbies: Map<LobbyCode, Lobby> = new Map();

  getLobby(code: LobbyCode): Lobby | undefined {
    return this.lobbies.get(code);
  }

  getAllLobbies(): Record<LobbyCode, Lobby> {
    const result: Record<string, Lobby> = {};
    for (const [code, lobby] of this.lobbies) {
      result[code] = lobby;
    }
    return result;
  }

  createLobby(username: string): { code: LobbyCode; player: Player } {
    let code: LobbyCode;
    let attempts = 0;
    const MAX_RETRIES = 100;
    do {
      code = generateLobbyCode();
      attempts++;
      if (attempts > MAX_RETRIES) {
        throw new Error("Failed to generate unique lobby code after " + MAX_RETRIES + " attempts");
      }
    } while (this.lobbies.has(code));

    const player = createPlayer(username, "blue", true);

    const lobby: Lobby = {
      code,
      players: [player, null],
      status: "waiting",
      hostId: player.id,
    };

    this.lobbies.set(code, lobby);
    return { code, player };
  }

  joinLobby(
    code: LobbyCode,
    username: string
  ): { success: true; player: Player; lobby: Lobby } | { success: false; message: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, message: "Lobby not found." };
    }

    if (lobby.players[1] !== null) {
      return { success: false, message: "Lobby is full." };
    }

    if (lobby.players[0]!.username.toLowerCase() === username.toLowerCase()) {
      return { success: false, message: "Cannot join with the same username." };
    }

    const player = createPlayer(username, "red");
    lobby.players[1] = player;

    return { success: true, player, lobby };
  }

  toggleReady(code: LobbyCode, playerId: PlayerId): { success: true; lobby: Lobby } | { success: false; message: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, message: "Lobby not found." };
    }

    const player = this.findPlayer(lobby, playerId);
    if (!player) {
      return { success: false, message: "Player not in lobby." };
    }

    player.ready = !player.ready;

    if (player.ready && lobby.players[0]!.ready && lobby.players[1]!.ready) {
      lobby.status = "ready";
    } else if (!player.ready && lobby.status === "ready") {
      lobby.status = "waiting";
    }

    return { success: true, lobby };
  }

  leaveLobby(code: LobbyCode, playerId: PlayerId): { success: true; lobby: Lobby | null } | { success: false; message: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, message: "Lobby not found." };
    }

    const playerIndex = this.findPlayerIndex(lobby, playerId);
    if (playerIndex === -1) {
      return { success: false, message: "Player not in lobby." };
    }

    const wasHost = lobby.hostId === playerId;

    lobby.players[playerIndex] = null;

    if (lobby.players[0] === null && lobby.players[1] === null) {
      this.lobbies.delete(code);
      return { success: true, lobby: null };
    }

    if (wasHost && lobby.players[1] !== null) {
      lobby.hostId = lobby.players[1]!.id;
      lobby.players = [lobby.players[1], lobby.players[0]];
    }

    if (lobby.players[0] === null || lobby.players[1] === null) {
      lobby.status = "waiting";
      if (lobby.players[0]) lobby.players[0].ready = false;
      if (lobby.players[1]) lobby.players[1].ready = false;
    }

    return { success: true, lobby };
  }

  recordWin(code: LobbyCode, winnerColor: "player1" | "player2"): { success: true; lobby: Lobby } | { success: false; message: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, message: "Lobby not found." };
    }

    if (winnerColor === "player1") {
      lobby.players[0]!.score++;
    } else {
      lobby.players[1]!.score++;
    }

    return { success: true, lobby };
  }

  resetReadyStates(code: LobbyCode): { success: true; lobby: Lobby } | { success: false; message: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, message: "Lobby not found." };
    }

    lobby.status = "waiting";
    if (lobby.players[0]) lobby.players[0].ready = false;
    if (lobby.players[1]) lobby.players[1].ready = false;

    return { success: true, lobby };
  }

  private findPlayer(lobby: Lobby, playerId: PlayerId): Player | null {
    if (lobby.players[0]?.id === playerId) return lobby.players[0];
    if (lobby.players[1]?.id === playerId) return lobby.players[1];
    return null;
  }

  private findPlayerIndex(lobby: Lobby, playerId: PlayerId): number {
    if (lobby.players[0]?.id === playerId) return 0;
    if (lobby.players[1]?.id === playerId) return 1;
    return -1;
  }
}
