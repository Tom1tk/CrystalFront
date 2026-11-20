# CrystalFront v0.9.0-ML Release Notes — Neural opponents

**Released:** 2026-11-20
**Covers:** v0.7.0 – v0.9.0-ML (G-10 bot retrain, plan `docs/ML_RETRAIN_PLAN.md`; game changes since v0.6.6 are in `docs/DIARY.md`)

The first trained bot on the new game. It learned by copying the 20 scripted bots, then played three rounds of league self-play against itself, exploiters trained to beat it, and the scripted bots.

---

## What's new

### Neural opponents: Easy, Normal, Hard
- New **Neural opponent** row in the vs Bot tab (the default is Normal). The scripted bots are still there under **Scripted opponent**.
- The three levels are snapshots of the same bot, taken at points about 230–300 Elo apart:

| Level | Snapshot | Elo (Easy = 0) | Win rate v the 20 scripted bots (training maps) |
|---|---|---|---|
| Easy | `m4-imitate/final` — imitation only | 0 | 0.49 |
| Normal | `lg2-main/cycle_1` — after 1 league cycle | +295 | 0.82 |
| Hard | `lg2-main/cycle_3` — after 3 league cycles | +527 | 0.89 (held-out maps 0.93) |

  Elo comes from a round-robin among snapshots (`docs/eval/ladder-*.json`, 32 games per pairing, training maps only).
- The bot plays like a player: it sees only what its units see, acts every 0.8 s (one economy and one army decision), and its commands go through the same path as yours, so they appear in replays.
- It has memory (a recurrent network) and keeps a running guess of what you have. At Hard it changes its army mix, timing and turret count depending on what it faces.

### The bot's read of you
- The bot predicts your units, buildings and where your army is. **Settings → General → Bot's read of you** shows that prediction in a panel during a match (off by default).
- In **replays of neural matches** the panel is always shown, so you can see what the bot believed at each moment.

## Known limitations
- The bot rarely builds bruisers, medics, bulwarks or foundries. Its variety is mostly the skirmisher/gunner ratio, attack timing and turrets.
- Its weakest matchup among the scripted bots is `backdoor` (about 0.5 at Hard).
- Easy is not a beginner bot: it plays a whole game like a scripted bot. Idle and Passive remain the gentlest opponents.

## Technical
- Export: `python3 -m training.v2.export_onnx --checkpoint <ckpt> --out models/policy-<level>` writes two ONNX graphs (trunk + heads, and the target/pointer tail) and a JSON metadata file.
- Server: `onnxruntime-node` (CPU, one thread per model, about 15–35 ms per decision). The models load at startup; if a model is missing, picking that level returns "not available".
- Parity: `training/v2/test_onnx_parity.py` replays whole TypeScript games through PyTorch. For all three levels the largest per-head log-probability difference is ≤ 3.4e-5 (tolerance 2e-3).
