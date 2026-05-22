# CrystalFront v0.3.2-ML Release Notes

**Released:** 2026-05-22  
**Checkpoint:** `update_000150.pt` (crystalfront_ppo__0_3_0-ML__idle__1__1779364610)

---

## What's new

- **First deployable ML bot** — `MlBot`, trained via PPO with behaviour cloning warmup and an 13-stage curriculum. Selectable from the new "Play vs Bot" screen.
- **"Play vs Bot" screen** — dedicated menu separating scripted bots (SCRIPTED) from the ML bot (MACHINE LEARNING), accessible from the main menu.
- **All matches saved as replays** — player vs player and player vs bot matches are both stored, with both players' usernames and the full command log. Replay playback now shows actual gameplay.
- **ONNX runtime integration** — the ML policy runs in-process via `onnxruntime-node` with no network latency. The model is pre-loaded at server startup.

---

## ML bot capability

Empirical win-rates over 100 deterministic games per opponent, full 6000×600px map, standard 1000HP crystals and 50 starting resources:

| Opponent | Win rate | Avg game length |
|----------|----------|-----------------|
| idle | 100% | 2509 ticks |
| passive | 100% | 2652 ticks |
| rush_weak | 86% | 3117 ticks |
| rush_weak_medium | 99% | 3017 ticks |
| macro | 99% | 3017 ticks |
| rush_medium | 0% | 3416 ticks |
| rush | 1% | 3889 ticks |
| turtle | 0% | 5986 ticks |
| heavy | not evaluated | — |

**Intended tier: easy/medium.** The bot reliably beats passive and weak-rush opponents. It loses to full-strength rush, turtle, and heavy strategies. This is a known capability ceiling — the bot has not learned multi-unit defensive play (trn=0% throughout training). v0.4.0-ML targets this limitation.

---

## Training methodology (summary)

- **Algorithm:** PPO (CleanRL-style) with legal-action masking
- **Warmup:** Behaviour cloning from 1000 RushBot vs IdleBot demonstrations (full game config), including critic pretraining on discounted returns
- **Curriculum:** 13 stages from 800px map / 50HP crystal up to full 6000px / 1000HP, with progressive opponent difficulty (idle → passive → rush_weak → rush_medium)
- **Architecture:** Set-transformer encoder over entity list (64 entities × 12 features), 22 global features, 8 resource nodes × 5 features; MLP trunk with 384 hidden units
- **Training hardware:** AMD RX 7900 XTX (ROCm), 20 parallel envs, ~1375 SPS
- **Total steps to ship checkpoint:** ~4.6M

Full training history in `docs/ML_BOT_ACTION_PLAN.md`.

---

## Bug fixes in this release

- **Replay playback** — replays now show actual unit movement and combat. Previously, all player commands were silently dropped during playback due to a player ID mismatch (`Player.playerId` → `Player.id` typo in `saveReplay()`; `ReplayMeta` interface missing `bluePlayerId`/`redPlayerId` fields).
- **Bot game blank screen** — fixed a race condition where the client received `MATCH_START` before `LOBBY_STATE`, causing `GameShell` to render blank.
- **Winner display in replay browser** — outcome winner is now stored as a color string (`"blue"`/`"red"`) instead of username, ensuring consistent name coloring across all replays.

---

## Known limitations

- **1-tick action latency** — ONNX inference is async; the bot returns its previous action while computing the next one. Imperceptible at the game's tick rate.
- **Single fixed policy** — the bot does not adapt during a match. It always plays the same strategy.
- **trn=0%** — the bot never trains a second combat unit. It wins via a single-skirmisher rush. Against opponents that can reliably kill one skirmisher (rush_medium, turtle), it has no fallback.
- **No difficulty tiers yet** — all bots are individually selectable. A three-tier "easy/medium/hard" abstraction is deferred to v0.4.0-ML once a stronger policy exists.

---

## Next planned release

**v0.4.0-ML** — architectural change targeting multi-unit play via action-masking curriculum injection. Goal: ≥30% win rate vs `rush_medium` on the full game map.  
See `docs/SHIPPING_AND_V040_PLAN.md` Part 2 for the full plan.
