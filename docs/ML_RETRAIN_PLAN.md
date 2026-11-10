# ML_RETRAIN_PLAN — G-10: an adaptive "thinking" bot

**Status:** DRAFT for review (2026-11-10). **No training starts until every item in the sign-off table (§12) is ✅.**
**Supersedes:** `REVIVAL_PLAN.md` Task 3.2 onward (shelved) and the 21-stage scripted curriculum.
**Inputs:** `GAME_UPDATE_PLAN.md` G-10 (approved direction), `/root/fable-crystalfront-diagnosis.md` (2026-06 root causes), the shipped v0.7.0 game.

---

## 0. Goal, stated so it can be tested

> An AI opponent that "would react to a player's decisions and change how it thinks on the fly, rather than regurgitate a pre-determined 'best path'."

An RL policy is a learned function, so "thinking on the fly" has to be built from three concrete properties. Each one gets a measurable test in §9:

| Property | What it means in play | How it is built |
|---|---|---|
| **Remembers** | It acts on what it scouted 2 minutes ago, not only on what is on screen now. | Recurrent policy plus explicit "last seen" memory in the observation (§3, §5). |
| **Notices change** | If you switch from a skirmisher rush to turrets plus gunners, its build and army follow within a short window. | Training opponents that switch plans mid-match, and an observation that shows composition and tech (§3, §6). |
| **Has no single answer** | Its opening and plan differ by map and by opponent. No fixed build beats everything. | A self-play league with exploiters that punish fixed strategies, and a pool of 8 training maps (§6). |

Win rate alone is **not** the success metric. A bot that wins with one memorised rush fails the goal.

---

## 1. Where we start

### 1.1 Already fixed from the 2026-06 diagnosis (verify, don't redo)
| Diagnosis item | Current state |
|---|---|
| §2.1 overrides dropped on autoreset | fixed (`slot.cfgOverrides` is passed on autoreset); **re-verify on pool maps** (P-5) |
| §2.2 obs and actions use static `MAP` | `observation.ts` uses `match.config.mapWidth/Height`; `actionSpace.ts` zone resolution **must be re-checked** on the new map sizes |
| §3.3 draws, no tiebreaker | the engine always names a winner (tiebreaker), and the G-8 control win exists |
| §4.1 per-tick decisions with γ=0.995 | `decision_interval` (k=8) exists in `stdioVecRunner`; `train.py` uses γ=0.99 and λ=0.95 |
| §4.2 and §4.3 reward scale and terminal | `reward.ts` terminal is ±1 for any win type; shaping is ≤0.3 in total |
| §2.3 MacroBot crash | fixed |

### 1.2 Still open or new
- **Throughput regression.** `npm run bench` gives **3,232 ticks/s** on classic today. It was 5,315 at U2 and 5,358 at U3. The workload changed since then (U4/U5 control nodes, double resource nodes, bigger maps), and 12 matches now total 37k ticks instead of 61k, so this is not apples-to-apples. On pool maps the 6-match bench gives 2,127 ticks/s on shardfall and 2,182 on glimmerfen. **This needs profiling before training (P-4).** Training cost scales with it directly.
- **The action table is pre-update.** It has no named zone anchors, still carries the `xZone`/`yZone` legacy, and its targets (`midfield`, `contested_node` and so on) assume the old corridor. The G-10 prerequisite "map-generic macro actions via named anchors in `MapLayout`" has **not** been built.
- **The observation has none of the G-10 hooks:** no terrain/LOS grid, no last-seen memory, no terrain under each entity. It also misses enemy gunner, medic, foundry and depot counts.
- **The policy is memoryless:** a set-transformer over the current snapshot only.
- **The scripted bots** were written for the corridor. They need to work on all pool maps (they serve as BC teachers and league members).
- **Hardware is now an NVIDIA Tesla P100 16 GB (CUDA, torch 2.14.1+cu126) with 12 vCPUs and 24 GB RAM.** The ROCm `nn.LayerNorm` warning in memory was for the previous GPU. `policy.py` already uses a custom LayerNorm. Keep it, and re-test `nn.LayerNorm` once (P-6) instead of assuming.

---

## 2. Prerequisites (game and harness), done before any learning code

| ID | Item | Done when |
|---|---|---|
| **P-1** | **Named zone anchors in `MapLayout`.** `mapgen` and the hand-made maps emit: `own_base`, `own_pocket_{1..n}`, `centre_{1..n}`, `enemy_pocket_{1..n}`, `enemy_base`, `node_{i}` (each contested node), and `choke_{i}` (narrowest points on the base→centre paths, from the nav grid). Mirrored per side, so "own"/"enemy" are relative. | anchors exist on all 10 pool maps plus classic and testbed, and a golden test checks symmetry |
| **P-2** | **Scripted bots on anchors.** Rush, macro, turtle, heavy and the rush tiers target anchors, so they play sensibly on every pool map. Plus new **switcher bots** (§6.3). | round-robin on every pool map; no crashes; a sanity matrix is recorded |
| **P-3** | **Bot round-robin per map → balance report.** This repeats the diagnosis §1.1 experiment on the new game, on every pool map. If one strategy wins everything on a map, self-play will converge to it there. | report in `docs/`; no strategy above ~80% against all others on a map, or the map/balance issue is logged and fixed first |
| **P-4** | **Throughput.** Profile `stdioVecRunner` on a pool map (observation build, flow fields, LOS, IPC). | target ≥4,000 ticks/s per core on pool maps (bench), or a documented reason the lower figure is acceptable |
| **P-5** | **Harness correctness on pool maps.** Overrides survive autoreset. `mapId` reaches every slot. Observation and action geometry match the map. | a test asserts per-slot `mapId` and config after 3 autoresets |
| **P-6** | **GPU sanity.** A short PPO smoke run on CUDA, plus a one-off `nn.LayerNorm` gradient check on the P100. | the smoke run's loss falls, with no NaN |
| **P-7** | **Maps signed off by you.** All 10 pool maps are `approved: null` today. Training on a map you later reject wastes the run. | the manifest has dates, and the held-out split (§6.4) is chosen from approved maps |

---

## 3. Observation (R-1)

The current design stays (an entity set, a node set and globals), with these additions:

1. **Spatial grid, 40 px cells (the vision-grid resolution), pooled to about 48×24 on the largest map and padded.** Channels:
   - blocked
   - rough
   - high ground
   - water
   - brush
   - **currently visible**
   - **ever seen**
   - **ticks since last seen** (normalised and capped)
   - own influence (combat supply, blurred)
   - **last-seen enemy influence** (decays with time since seen)

   Static channels are computed once per map and sent once per episode, so IPC stays small.
2. **Enemy memory set.** Every enemy structure ever seen, kept at its last-seen position with its type, HP fraction and `ticksSinceSeen`, and marked destroyed if seen dying. The engine already decides visibility, so this memory is honest: it only holds what this player's fog allowed. It lives in the observation builder, per player, and resets per episode.
3. **Per-entity terrain under the unit:** high, brush, rough, and in-enemy-LOS-as-far-as-known.
4. **Globals:**
   - enemy gunner, medic, foundry and depot counts (last seen, with age)
   - own production queues
   - supply-blocked flag
   - control-race state (already present)
   - **time since the last enemy army sighting**
5. **No privileged information for the policy.** The **value head may see full state** (asymmetric actor-critic). This is standard and cuts value noise a lot under fog. It is only used in training and never ships.

The observation stays deterministic and seeded, so replays reproduce what the bot saw.

---

## 4. Action space (R-2)

The table is rebuilt from scratch. There is no legacy constraint.

**Recommendation: a factored, autoregressive action** `(verb, subject, target)` with legality masks at each head, instead of a flat 81-way table:
- **verb:**
  - `noop`, `train(unit)`, `build(building)`
  - `move`, `attack_move`, `hold`, `retreat`
  - `gather(node)`, `scout`, `focus(target rule)`
- **subject:**
  - `all_combat`, `army_A`, `army_B` (two control groups the bot assigns)
  - per unit type
  - `idle_workers`, `n_workers`, `one_worker` (for scouting)
- **target:** a named anchor (P-1), or a slot from the enemy-memory set (attack *that* last-seen foundry)
- **build placement:** an anchor plus the existing validated placement search

Why this matters for the goal:
- Targets can point at **remembered** things. That is the hook for memory to change behaviour.
- **Two armies** make splits, flanks and holding chokes possible.

**APM (diagnosis §4.6).** Each decision (k=8 ticks, 0.8 s) may emit **up to 3 sub-actions**: the autoregressive head loops, and `noop` ends the loop. Scripted bots are capped to the same budget, so comparisons are fair and humans see a non-superhuman rate. About 225 actions per minute at most, usually far fewer.

*Alternative (simpler, weaker):* keep a flat table of about 150 entries over anchors. It is easier to debug, but it can't reference memory slots and it scales poorly. **I recommend the factored version.**

---

## 5. Policy (R-3)

- **Encoders:**
  - entity set → the existing set-transformer
  - enemy-memory set → its own small set-transformer
  - spatial grid → a small CNN (3 conv layers)
  - globals → an MLP
- **Core:** a **GRU (hidden size 256)** over decisions. This is the "remembers" part. Training uses BPTT over rollout chunks of 64 decisions, with the hidden state stored per env and reset on episode boundaries.
  - *Alternative:* a transformer over the last N decision embeddings. It is more expressive but costlier and harder to export. GRU first; switch only if the memory metrics in §9 fail.
- **Heads:** autoregressive action heads (§4) and an asymmetric value head (§3.5).
- **Size:** about 2–4 M parameters. Inference must run in the server at k=8 for one bot well under 5 ms on CPU (ONNX, with GRU state carried between calls). This replaces today's stateless ONNX path. The parity test (TS vs PyTorch) is extended to sequences.
- **Norm layers:** keep the custom LayerNorm unless P-6 clears `nn.LayerNorm`.

---

## 6. Training regime (R-4)

### 6.1 Phase A: behaviour-cloning warm start (short)
- Record scripted bots playing each other on the training maps, using the **multi-action** budget (§4), and pair each action with its **own** observation. This fixes both defects from diagnosis §2.4.
- Train BC to roughly 60–70% action accuracy. **Do not over-fit.** BC only makes PPO start from "plays the game"; it is not the target.
- *Optional:* skip BC entirely if PPO from scratch against a weak league clears M1 (§10) within budget. That is decided by experiment, not up front.

### 6.2 Phase B: self-play league (the main phase)
Built on the existing `league.py` PFSP, extended in the AlphaStar-lite style, sized for one GPU:

| Population member | Count | Trains against | Purpose |
|---|---|---|---|
| **Main agent** | 1 | 35% self-play, 40% PFSP over all frozen snapshots plus scripted bots, 25% exploiters | the bot we ship |
| **Main exploiter** | 1 | the current main agent only | finds and punishes whatever fixed plan main relies on; reset to BC every ~N updates |
| **League exploiter** | 1 | PFSP over the whole league | finds strategies the league as a whole is weak to |
| **Frozen snapshots** | every ~2 M decisions | (not trained) | stops forgetting; PFSP weights the ones main loses to |
| **Scripted pool** | about 10 | (not trained) | rush tiers, macro, turtle, heavy, **switchers**; diversity anchors |

On one P100 these run **round-robin by update** (not in parallel processes), with each member's rollouts on the shared CPU env pool. CPU, not GPU, is the bottleneck, so the cost is mostly env steps.

### 6.3 Switcher bots: the direct pressure toward "notices change"
New scripted bots that **change plan at a random tick between 1,500 and 4,000**:
- rush → turtle with gunners
- macro → all-in bruiser timing
- fake expansion, then a hidden army through brush
- turtle → late control-node grab

A memoryless or plan-locked policy loses to these, so the gradient favours noticing the switch.

### 6.4 Maps
- **8 training maps, 2 held out** (chosen from your approved maps, P-7).
- Classic and testbed are kept for regression only.
- Map sampling is uniform at first, then up-weighted on maps where main wins least.

### 6.5 Reward (R-5)
- Terminal: **+1 for any win type, −1 for a loss**. There are no draws, thanks to the tiebreaker.
- Shaping stays small. It is **annealed to 0 by the end of Phase B's first third**, so the final policy optimises winning, not milestones.
- **No reward for "adapting".** Adaptation has to emerge from opponents that punish non-adaptation. Rewarding it directly would be gamed.
- Truncation (if any remains) bootstraps `V(s_T)`. It is not treated as terminal.

### 6.6 Compute budget (estimate, to be confirmed in P-4)
- Assume 10 env processes at about 2,500 ticks/s each, minus about 40% observation/IPC overhead: roughly 15k ticks/s, or **about 1,900 decisions/s at k=8**.
- One 6,000-tick game is 750 decisions, so about 2.5 games/s, or about 200k games/day.
- **Budget:** M1 in about 1 day, M2 in about 4–5 days, M3 in up to 2 weeks of wall time. Every run checkpoints and resumes, and none needs the GPU exclusively.

---

## 7. LLM strategist plus RL executor: evaluate, don't build first (R-6)

**Idea:** an LLM reads a text summary of the match every ~20–30 game-seconds and outputs an **intent** from a fixed vocabulary:
- `defend`, `expand`, `tech_foundry`, `harass_workers`, `timing_attack@anchor`, `contest_node_i`, `scout`
- plus a one-line reason

The RL policy is conditioned on the intent: an extra observation input, and training samples intents randomly so the policy learns to follow them.

**Pros:**
- Genuinely legible "thinking": the reason string can be shown to the player as the bot's taunt or log.
- Plan changes are explicit.

**Cons:**
- Latency and API cost per game.
- Not usable in headless training at scale. The executor must be trained on *sampled* intents, and the strategist's choices are never optimised for winning.
- Depends on a network service.
- Nondeterministic, which breaks replays unless intents are logged.

**Recommendation:**
1. **Build pure RL first** (M1–M3).
2. At M3, run a **cheap offline experiment**: replay 50 M3 games, ask an LLM for intents at decision points, and compare them with what the policy actually did. If the LLM's calls are plausibly better, build the intent-conditioned head as an **optional "commentated" mode**.
- The model choice and cost estimate are made at that point, against the then-current API, not now.

---

## 8. What ships, and how (R-8)

- The server's ML bot gains a GRU state per match and loads the new ONNX model.
- The old v0.3.2-ML path is retired. There are no live users, so no legacy service is needed.
- Bot difficulty is set by **league snapshot**, not by handicaps: Easy is an early snapshot, Normal mid, Hard is the final main agent. This gives real variety in skill rather than artificial nerfs.
- **The R9 rule still applies:** replacing the production model, the ONNX export and the release notes need your explicit go-ahead.
- Every training, reward or config change bumps all 5 `package.json` versions with the `-ML` suffix (version-bump rule).

---

## 9. Evaluation: "adapted to me", not just win rate (R-7)

Run on the **held-out maps**, with fixed seeds, at every milestone. Results go in the diary.

| # | Metric | Measures | Pass bar (proposed) |
|---|---|---|---|
| E-1 | Win rate vs each scripted bot, held-out maps | baseline competence | ≥80% vs every non-switcher bot by M2 |
| E-2 | Win rate vs **switcher** bots | notices change | ≥70% by M3, and higher than a memoryless ablation (E-5) by ≥15 points |
| E-3 | **Reaction latency:** decisions between the opponent's first visible switch and a significant shift in the bot's production mix (KL above a threshold) | reacts on the fly | median under 40 decisions (~30 s) |
| E-4 | **Exploitability:** win rate a fresh exploiter reaches against the frozen main agent after a fixed budget (e.g. 2 M decisions) | no single beatable plan | falls each milestone; under 60% by M3 |
| E-5 | **Memory ablation:** the same model with its GRU state zeroed each step, and with the memory set blanked | memory is actually used | win-rate drop ≥10 points vs switchers and hidden-army bots |
| E-6 | **Opening diversity:** entropy of first-3-minute build orders across maps and opponents; and conditional divergence (does the opening differ by map?) | no fixed best path | above the scripted bots' entropy; non-trivial divergence across maps |
| E-7 | **Scout use:** fraction of games where a scout reaches the enemy base before tick 1,500, and whether production changes after it | scouting feeds decisions | reported (no hard bar) |
| E-8 | **Elo in the league** (main vs all snapshots) | steady progress, no cycling | monotone over the last three milestones |
| E-9 | **Human playtest (you):** 5+ games across 3 strategies, including at least one mid-game switch; a short form ("did it respond?", "did it feel scripted?") | the actual goal | your call; this is the final gate |

A replay viewer overlay that shows the bot's top-3 intents (from the action heads) helps E-9. It is optional and cheap because replays already exist.

---

## 10. Milestones and gates

| Milestone | Contents | Gate to continue |
|---|---|---|
| **M0: Prerequisites** | P-1 to P-7 | all P-items done, reviewed by you |
| **M1: Plays the game** | new observation/action/GRU policy, BC (if used), PPO vs the scripted pool | E-1 ≥60% vs rush_medium, macro and turtle on training maps; no NaN; memory ablation runs |
| **M2: League** | full league, switchers, shaping annealed | E-1, E-4 trending down, E-8 rising |
| **M3: Adaptive** | longer league run | E-2, E-3, E-5, E-6 pass; then **your E-9 playtest** |
| **M4: Ship** | ONNX + GRU in the server, difficulty snapshots | your go-ahead (R9) |
| **(M5 optional)** | LLM strategist experiment (§7) | your call after M3 |

**Stop rule (avoids repeating the 2026-06 spiral).** If a milestone misses its gate after 2 diagnosed iterations:
1. Stop.
2. Write the diagnosis.
3. Check you agree before changing more than one variable.

Every relaunch follows the existing R10 rule: diagnosis, fix and reasoning are documented first.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Self-play collapses onto one strategy (cycling or a dominant rush) | P-3 balance check, exploiters, PFSP over snapshots, scripted anchors, E-4 and E-6 tracking |
| Throughput too low for the league | P-4 profiling; k could rise to 12; fewer, longer rollouts |
| GRU/BPTT bugs (hidden state leaks across episodes) | unit test: the hidden state resets on done; parity test over sequences |
| The value head can't learn under fog | asymmetric critic (full state) |
| Bot feels superhuman (perfect micro) | the APM cap (§4); reaction delay is built in by k=8 |
| Overfits to the pool maps | 2 held-out maps, and new maps can be generated from `mapgen` |
| Scope creep (LLM, transformer core) | each is behind its own gate |

---

## 12. Sign-off (per item)

Mark each ✅ (approved), ✏️ (change, with a note) or ❌ (drop).

| ID | Item | Recommendation | Your call |
|---|---|---|---|
| P-1…P-7 | Prerequisites (§2) | do all before any learning code | ⬜ |
| R-1 | Observation: grid + enemy memory + terrain-under-me + asymmetric critic (§3) | as written | ⬜ |
| R-2 | Factored autoregressive actions with anchors, memory targets, 2 armies, ≤3 sub-actions per decision (§4) | factored (not flat) | ⬜ |
| R-3 | GRU-256 core, set + CNN encoders, ONNX with state (§5) | GRU first | ⬜ |
| R-4 | BC warm start + PFSP league with main/exploiters/snapshots/scripted + switcher bots; 8 train / 2 held-out maps (§6) | as written | ⬜ |
| R-5 | ±1 terminal, shaping annealed to 0, no "adapt" reward (§6.5) | as written | ⬜ |
| R-6 | LLM strategist: offline experiment after M3 only (§7) | defer | ⬜ |
| R-7 | Evaluation metrics E-1…E-9 and pass bars (§9) | as written; bars can be tuned | ⬜ |
| R-8 | Ship path: GRU ONNX, difficulty by snapshot, R9 still applies (§8) | as written | ⬜ |
| R-9 | Milestones and the stop rule (§10) | as written | ⬜ |

**Open questions for you:**
1. Which 2 maps should be held out? (I'd pick one open map and one terrain-heavy one, after P-7.)
2. Should Easy/Normal/Hard be league snapshots (recommended), or one model with handicaps?
3. Do you want the bot's "intent" visible to the player (a log or taunt line)? That favours building the R-6 commentary mode later.
