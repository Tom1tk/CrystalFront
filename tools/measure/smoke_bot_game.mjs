// Live smoke test: start a bot game over WebSocket and report what the client sees.
//   node tools/measure/smoke_bot_game.mjs <bot> <ruleset> [seconds]
import WebSocket from "ws";
const [bot = "v3_rush1", ruleset = "beta", secs = "20"] = process.argv.slice(2);
const ws = new WebSocket("ws://localhost:3777");
let me = null, last = null, err = null;
ws.on("open", () => ws.send(JSON.stringify({ type: "start_bot_game", payload: { username: "smoke", bot, mapId: "shardfall", ruleset } })));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "connected") me = m.payload.playerId;
  if (m.type === "error") err = m.payload.message;
  if (m.type === "match_start") ws.send(JSON.stringify({ type: "client_loaded" }));
  if (m.type === "game_state" || m.type === "match_start") last = m.payload.match;
});
setTimeout(() => {
  if (err) console.log("error:", err);
  if (last) {
    const counts = {};
    for (const e of last.entities) if (e.ownerId !== me) counts[e.type] = (counts[e.type] ?? 0) + 1;
    console.log(`tick ${last.tick} ruleset ${last.ruleset} phase ${last.phase} opponent visible:`, JSON.stringify(counts), "players:", last.players.map((p) => p?.username).join(" v "));
  }
  process.exit(0);
}, Number(secs) * 1000);
