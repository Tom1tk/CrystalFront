# Tournament mode spec (Swiss)

Status: **design only, not implemented** (2026-11-20). Separate from the 0.10 mainline work
(`docs/MAINLINE_0.10_PLAN.md`) and can be designed and built while bot training runs. Items marked
*(open)* need a decision.

## 1. Goals

- One user creates a tournament and becomes its **manager**. Others join with a code, like
  PvP host/join.
- When the manager starts it, the server runs a **Swiss** tournament for a set number of rounds.
- A **live dashboard**, open to every user of the site, shows standings, pairings, results and
  live matches. Live matches can be spectated with a **30–60 s delay**.
- The manager can finish early, add rounds, add or remove players late, and so on (§7).

## 2. Constraints from the current code

| Today | Consequence for tournaments |
|---|---|
| No accounts: a player is a username typed per connection | Needs a stable **player token** (random, kept in localStorage) so the same person is recognised across rounds, reloads and reconnects |
| Disconnect = instant forfeit (`server/src/index.ts`, `ws.on("close")`) | Tournament matches need a **reconnect grace** (60 s *(open)*) before forfeiting, or one dropped Wi-Fi packet loses a round |
| 0.9 stable has **no time cap** | A Swiss round waits for its slowest game, so an endless game blocks the whole tournament. **Build on mainline**, which has the 20-minute cap and draws. Tournament matches use the beta ruleset (later 0.10). |
| Server restarts on every `./deploy.sh` and keeps everything in memory | Tournament state is **saved to disk** after every change (`data/tournaments/<id>.json`) and reloaded at startup. Matches in progress when the server restarts are lost, so the manager decides how to handle them (§7). Don't deploy during a tournament; the dashboard warns the manager. |
| Replays re-simulate from `match.commandLog` (`ReplayRunner`), and bots act through `processCommand`, so their actions are logged too | **Delayed spectating** reuses this: run a replay simulation that follows the live command log, held D seconds behind (§6) |

## 3. Lifecycle

```
created (registration open) ── start ──▶ round 1 pairing ─▶ round 1 playing ─▶ round 1 done
      ▲  join / leave / kick                    ▲                                    │
      │                                         └──── next round (auto or manual) ◀──┘
      └─ cancel                                                   last round done / finish early
                                                                               ▼
                                                                          finished
```

1. **Create.** The manager picks the settings and gets a 6-character code (same alphabet as lobby
   codes). The tournament is listed publicly as "Registering".
2. **Register.** Players enter the code and a display name. Before start, the manager can kick
   players and lock registration. Minimum 2 players. Maximum 32 *(open)*.
3. **Start.** Round 1 is seeded randomly, or by manager order *(open)*.
4. **Each round:**
   1. Pair the players (§4) and publish the pairings.
   2. **Ready check:** each player gets "Your round N match vs X is ready". Both have 60 s to click
      Ready. A player who doesn't loses that match by no-show. If neither is ready, both lose.
   3. The match runs under normal mainline rules: 20-minute cap, node-control percentage at the
      cap, draws possible. Map and sides are set by the tournament.
   4. Results are recorded as they come in, along with a link to the replay.
   5. When every match in the round is done, the next round starts. It starts automatically after
      a 60 s countdown that the manager can cut short, or it waits for the manager *(setting)*.
5. **Finish.** After the last round, or when the manager finishes early: final standings, a
   podium, and replay links. The tournament stays viewable read-only for 7 days *(open)*.

## 4. Swiss pairing

- **Scores:** win 1, draw ½, loss 0. A bye is worth 1 point.
- **Default number of rounds:** ⌈log₂ N⌉, but at least 3 and never more than N − 1. The manager
  can change it.
- **Pairing algorithm** (Dutch-style, simple version):
  1. Group players by score and sort within each group by tiebreak, then by seed.
  2. From the top group down, pair the top half of each group against its bottom half.
  3. **No rematches.** If a pairing would be a rematch, swap within the group. If the group still
     can't be paired, move its lowest player down into the next group.
  4. Use a backtracking search with a bound on its depth. It always finds a valid pairing when one
     exists. N ≤ 32 makes this cheap.
  5. If N is odd, the lowest-ranked player who has not had a bye gets one.
- **Sides:** alternate blue and red so each player's count stays balanced. On a tie, the
  higher-ranked player gets the side they've played less.
- **Map:** the same map for the whole round. Rotate through the manager's map pool and avoid
  repeating a map until the pool runs out.
- **Tiebreaks, in order:**
  1. Buchholz Cut-1: sum of opponents' scores, minus the lowest.
  2. Sonneborn-Berger: sum of the scores of opponents beaten, plus half the scores of opponents
     drawn.
  3. Head-to-head result.
  4. Number of wins.
  5. Seed.
- **Implementation and tests:** a pure, deterministic module (`shared/src/swiss.ts`) with unit
  tests covering:
  - no rematches;
  - byes at most once each;
  - sides balanced to within 1;
  - odd N;
  - a player withdrawing mid-tournament;
  - a player joining late;
  - a fuzz test over many random tournaments.

## 5. Dashboard (`/t/<CODE>`, plus a "Tournaments" list on the main menu)

Visible to every user of the site. No join is needed to watch.

- **Header:** name, status, round "3 / 5", countdown to the next round, the map for this round.
- **Standings table:** rank, name, points, W-D-L, Buchholz, SB, current status (playing / ready /
  waiting / withdrawn). The table updates live.
- **Round tabs:** pairings and results for every round so far, each with a replay link.
- **Live matches:** a card for each match in progress showing the two players, the map and the
  delayed game clock, with a **Spectate** button.
- **Your status:** for participants, a banner: "Your match vs X is ready — Ready (0:42)", or
  "Waiting for round 3 to finish (2 matches still playing)".
- **Manager panel:** shown only to the manager's token (§7).
- **Updates:** the server pushes the whole tournament state on every change. The state is small,
  so there are no diffs.

## 6. Delayed spectating

- Each tournament match gets a **spectator feed**: a replay simulation that runs D ticks behind the
  live match.
  - It is fed from the live match's `commandLog`.
  - It uses the map, seed and engine of that match, so it is deterministic. The golden-hash tests
    already rely on this.
- The delay is enforced **on the server**: a state newer than `liveTick − D` is never sent. That
  stops a player watching their own match from a second tab and seeing through fog.
- **Delay:** 45 s by default. The manager can set 30–60 s.
- **View:**
  - Default: the full map, without fog.
  - Option: either player's fog view *(open)*.
- The client reuses the replay viewer, minus its seek and speed controls.
- **Cost:** one extra engine per watched match, created only while someone is watching. With
  matches capped at 20 minutes and a typical game ending well before that, this is fine on this
  box.

## 7. Manager controls

| Control | Behaviour |
|---|---|
| Lock / unlock registration | Before start |
| Kick a player | Before start, or treat as a withdrawal after start |
| Start now | Needs at least 2 players |
| **Add rounds** / remove remaining rounds | Any time before the final round is paired |
| **Finish early** | Matches still running can be allowed to finish (default) or voided. Then the standings become final. |
| **Withdraw a player** | Their current match is forfeited, they are not paired in future rounds, and their past results stand (so opponents' Buchholz doesn't change) |
| **Add a player late** | Allowed until the last round is paired. The late player starts with 0 points, or with ½ point per missed round *(open, default 0)* |
| Pause / resume between rounds | Stops auto-advance |
| Re-pair the current round | Only before any of its matches start |
| **Set a result** (adjudicate) | For disputes, server restarts, or a disconnect after the grace period: win, loss, draw, or replay the match |
| Handle an interrupted match | After a server restart: replay it, or adjudicate it |
| Map pool, ready-check time, auto-advance, spectator delay | Can be changed for future rounds |
| Transfer manager | To another player (their token becomes the manager token) |
| Cancel the tournament | Asks for confirmation; the tournament is kept as "cancelled" |

The manager is identified only by their token. If they lose it (cleared browser), the tournament
can't be managed. A server admin command (`npx tsx server/src/tournamentAdmin.ts`) can reassign
the manager.

## 8. Bots as entrants *(open, recommended)*

The site has one regular user, so a Swiss of one human is not a tournament. The manager could add
bot entrants:

- neural Easy / Normal / Hard;
- the scripted bots.

How bot matches run:

- **Bot v bot:** runs server-side at normal speed, so it can be spectated, and its result is
  recorded like any other.
- **Bot v human:** the existing bot-game path, used as a tournament match.

This also gives a cheap, watchable ladder for the new mainline bots.

## 9. Protocol (sketch)

- **Client → server:**
  - `tournament_create {name, settings}`
  - `tournament_join {code, username, token}`
  - `tournament_leave`
  - `tournament_ready {matchSlot}`
  - `tournament_watch {code}` (subscribe to the dashboard)
  - `tournament_spectate {code, matchSlot}`
  - `tournament_admin {code, token, op, args}` (one message for every op in §7)
- **Server → client:**
  - `tournament_state {…full state}`
  - `tournament_match_ready {matchSlot, opponent, map, side, deadline}`
  - `tournament_error {message}`
  - Spectating reuses the replay state messages.
- **Matches** reuse the normal match messages. The match carries `tournamentId`, `round` and `slot`,
  so its end is reported to the tournament manager, and the replay is tagged with the tournament.

## 10. Build order

| Step | Contents | Verified by |
|---|---|---|
| T1 | `shared/src/swiss.ts`: pairing, tiebreaks, byes, withdraw and late join | unit and fuzz tests |
| T2 | Server `TournamentManager`: lifecycle, saving to disk, protocol, player tokens | server tests with simulated clients |
| T3 | Client: create/join screens, dashboard, Tournaments list | manual test with 2–3 browser tabs |
| T4 | Match integration: ready check, map and sides, results, reconnect grace, replay tagging | an end-to-end tournament with bots |
| T5 | Delayed spectating | delay is never under D (server test); determinism against the live match |
| T6 | Manager panel and the §7 operations | server tests for each operation |
| T7 | Bot entrants (if wanted) | a full bot-only tournament runs unattended |

T1 and T2 do not touch the game engine, so they can be built in parallel with the bot training round
without changing golden hashes.

## 11. Decisions needed

1. Bots as entrants (§8)? (Recommended: yes.)
2. Spectator view: full map only, or a choice of either player's fog?
3. Late joiners: start on 0 points, or ½ point per missed round?
4. Best-of-1 only, or best-of-3 for the final round(s)?
5. Reconnect grace length (60 s?), and the maximum number of players (32?).
6. Ship with 0.10 stable, or earlier in beta?
