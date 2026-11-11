# ML_RETRAIN_PLAN — G-10: an adaptive decision-making bot (v2)

**Status:** **APPROVED by the user, 2026-11-11** (every item in §13). **Not started:** the user asked that work not begin yet. Implementation guide for the implementing agent: `docs/ML_RETRAIN_IMPLEMENTATION.md`.
**v2 = v1 audited against the published record of AlphaStar, OpenAI Five and their successors, and against our own harness code.** The audit found 14 problems in v1, 5 of them serious (§2). v1 is in git history (`37e86f3`).
**Supersedes:** `REVIVAL_PLAN.md` Task 3.2 onward and the 21-stage scripted curriculum.

---

## 0. Goal

> An AI opponent that "would react to a player's decisions and change how it thinks on the fly, rather than regurgitate a pre-determined 'best path'" — a learned decision-making model in the family of AlphaStar and OpenAI Five.

Those systems share one recipe, and it is what this plan builds:

1. a neural policy with **memory** (an LSTM core in both);
2. trained by **self-play against a varied population**, so no single fixed plan survives;
3. started from **imitation** of existing play, so it explores sensible strategies;
4. with **long credit horizons** and rewards that make the whole game matter.

**Honest scale statement.** AlphaStar's league had 12 agents, each trained on 32 TPUs for 44 days, with about 16,000 games running at once. ROA-Star, a 2023 successor whose authors describe it as using "orders of magnitude less resources", still used 64 V100 GPUs and 4,600 CPU cores. We have one Tesla P100 and 12 vCPUs. The reference class that matches our budget is the microRTS competition agents: RAISocketAI (first deep-RL winner, about 70 GPU-days) and UECD (2026, beats RAISocketAI on 9.5 GPU-days). CrystalFront is far smaller than StarCraft (5 unit types, 4 buildings, macro-level orders), so the recipe is feasible here. The target is **a bot that beats every scripted bot, resists purpose-trained exploiters at our budget, and visibly adapts to you**. It is not a superhuman agent.

Win rate alone is not the success metric (§10).

---

## 1. What the research says (and what we take from it)

| Source | What they did | What it means for us |
|---|---|---|
| **AlphaStar** (Vinyals et al., Nature 2019) | LSTM policy; supervised start from human replays; league of main agents, main exploiters and league exploiters with prioritised fictitious self-play (PFSP); policy conditioned on a strategy statistic `z` (a build order sampled from human games). | **Its own ablations (Fig. 3) rank the ingredients:** <br>• no human data: Elo 149; supervised only 936; human init + RL 1,020; + KL penalty toward the supervised policy 1,400; + `z` conditioning 1,540. Imitation and staying near it early are worth far more than league structure. <br>• plain self-play reached nearly the same Elo as PFSP + self-play (1,519 vs 1,540) but its worst win rate against past versions was 46% vs 71%: **pure self-play forgets**. |
| **OpenAI Five** (Berner et al., 2019) | One LSTM (4,096 units), PPO, no league: 80% of games against the latest self, 20% against past versions sampled by a quality score. Shaped rewards made **zero-sum** (subtract the enemy's), scaled down over game time (×0.6 per 10 min). Acts every 4th frame. BPTT over 16 steps. Credit horizon started at 180 s (γ=0.9993) and was lengthened; longer horizons kept helping up to 6–12 min. | A simple 80/20 self-play scheme is proven at scale and is far cheaper than a league. Long horizons matter. Win/loss-only reward does work but learns much more slowly than shaped. |
| **ROA-Star** (Huang et al., NeurIPS 2023) | AlphaStar plus (a) an **opponent-modelling auxiliary task**: predict the enemy's hidden units, tech and building locations from what has been seen; (b) a **scouting reward** equal to the drop in that prediction's error; (c) goal-conditioned exploiters. | Worst-case win rate rose from 1% to 44%. They note AlphaStar "rarely conducts effective scouting" and was fragile to unusual strategies. Opponent modelling is the most direct published mechanism for "notices what you're doing", and the simulator gives us its labels for free. |
| **RAISocketAI** (Goodfriend, 2024; microRTS winner) | PPO; half the envs against the latest self and half against older checkpoints, then fine-tuned against the strongest scripted bots. **Three value heads** (shaped, win/loss, cost) each with its own discount: γ=0.99 for shaped, γ=0.999 for win/loss. Reward weights moved from shaped to win/loss over training. BC then PPO matched the full agent without per-map tuning. | The closest match to our budget. Per-head discounts solve the "short shaping horizon vs long win horizon" conflict. On a long-game map (3,500 steps) BC + PPO *fell below* its BC start: long episodes are where credit assignment breaks. |
| **UECD** (Delsart, 2026; microRTS) | Ablated 12 features, 3 seeds each. The top four all **enrich the training signal**: richer observation (+26 points), tighter action masks (+23), weighting samples toward ~50% matchups (+20), **opponent-modelling head (+20)**. Optimiser tricks and autoregressive actions gave +5 to +13 with high variance. | Spend effort on observation, masks and opponent modelling first. |
| **UECD, "rush collapse"** | Annealing shaped reward to zero with γ=0.99 made the agent collapse into a worker rush: episode length fell 1,200 → 300 frames, and win rate against unseen bots fell from 56% to 0%. Cause: with terminal-only reward, discounting pays for *finishing sooner* (shortening a game from 750 to 300 steps multiplies the terminal signal by ~90). Fix: keep the shaped weight floored at 0.1. | **This is exactly what v1 of this plan proposed** (anneal shaping to 0, γ=0.99), in a project whose history is rush dominance. See F-1. |
| **Recurrent PPO practice** ("Generalization, Mayhems and Limits in Recurrent PPO", 2022, and others) | Common bugs: wrong reshaping before the recurrent layer; hidden state not reset at episode ends; stale stored states; padding not masked in the loss. | Each gets a unit test before any long run (§9). |
| **LLM + RL hybrids** (2024–2026) | TextStarCraft II: LLMs beat the built-in AI at "Harder". JEV-Star (2026): a fast controller plus an LLM planner won games at Lv5–Lv7 at about **$3.71 per game**, mostly planner cost. A 2026 study with a small local LLM picking tactics for a PPO policy found it chose the same tactic 83.8% of the time regardless of opponent. | Workable but costly per game, and small models don't differentiate. Still deferred (§8). |

Sources are listed in §14.

---

## 2. Audit of v1: findings

Severity: 🔴 would likely have sunk the run; 🟠 significant; 🟡 improvement.

| # | Sev | Finding | Evidence | Change in v2 |
|---|---|---|---|---|
| F-1 | 🔴 | **Reward/discount design reproduces a documented collapse.** v1 kept γ=0.99 at 0.8 s per decision (a horizon of ~80 s; a win 400 decisions away is discounted to 2%) and annealed shaping to zero. | UECD rush collapse; `train.py:185`; our own rush-dominance history | Separate value heads with their own discounts (win/loss γ=0.999, shaped γ=0.99); shaping is zero-sum, decays with game time, and is floored, not removed (§7.4) |
| F-2 | 🔴 | **Self-play does not exist in the harness.** v1 said the league would be "built on the existing `league.py`". In fact the learner is hard-wired as blue, red is always a scripted bot inside Node, and checkpoint opponents are marked inactive ("need ONNX"). | `stdioVecRunner.ts:103–249`; `league.py:46` | New two-seat environment where Python controls either or both players (P-2). This is the largest piece of harness work |
| F-3 | 🔴 | **Too many new parts at once.** v1 introduced a new observation, new action space, memory, a 3-agent league and exploiters together. That is how this project failed before: compounding defects nobody could separate. | 2026-06 diagnosis | A staged build: one new component per stage, each with a learning test it must pass first (§9), and ablations at short budgets |
| F-4 | 🔴 | **The 6,000-tick cap is shorter than real games, and the tiebreak is a training-only win condition.** Live games have no cap. With an 18,000 cap, natural games ran 2,600–13,800 ticks. A capped agent learns to win tiebreaks (e.g. chip the crystal, then hide), which does not exist in live play. | game-length experiment (§3.2); `matchEngine.ts:1116` | Cap raised to 12,000 ticks and treated as a **truncation** (value bootstrapped, counted as a draw in evaluation), not a win (§7.4) |
| F-5 | 🔴 | **Three learners on one machine.** v1's main agent + 2 exploiters would split a CPU-bound sample budget three ways from day one. AlphaStar's own ablation shows main-agent-only training gets most of the Elo; exploiters buy robustness. | AlphaStar Fig. 3 | One learner with 80/20 self-play first. Exploiters become a **periodic test that feeds the pool** (§7.3), not permanent learners |
| F-6 | 🟠 | **No opponent modelling.** v1 relied on memory plus "switcher bots" to produce adaptation. The literature's most effective, cheapest mechanism was missing. | ROA-Star; UECD ablation | Auxiliary head predicting the enemy's hidden composition and tech (§6). It also gives a readable "what the bot thinks you're doing" for free |
| F-7 | 🟠 | **BC was "optional", with no protection once RL starts.** Imitation was AlphaStar's single biggest factor, and the KL penalty toward the imitation policy was worth +380 Elo. Our earlier runs lost their BC prior in early PPO updates. | AlphaStar Fig. 3e; diary ("BC prior overwritten") | BC is required; value heads are fitted during BC; a KL-to-BC penalty is annealed over early RL (§7.1) |
| F-8 | 🟠 | **No strategy conditioning.** Nothing in v1 forced the *learner* to have more than one style; variety was supposed to come only from opponents. | AlphaStar `z` (+140 Elo and diversity) | Policy conditioned on a strategy token `z` drawn from scripted build templates, or "free" (§7.2) |
| F-9 | 🟠 | **Up to 3 sequential sub-actions per decision.** Later sub-actions' legality depends on earlier ones (resources spent), so masks would be wrong or need an engine round trip. UECD measured autoregressive sampling at only +5.7 with high variance. | UECD Table II | Two **parallel** heads per decision: one economy/production action and one army order. Their masks are independent (§5) |
| F-10 | 🟠 | **The policy must play both seats.** Observations are in map coordinates, not the player's own frame, and the learner has only ever been blue. Half the pool maps use rotational symmetry. | `observation.ts` (`xNorm = x / mapW`); manifest `symmetry` | Own-frame observation and actions for both seats and both symmetries, with a seat-symmetry test (P-3) |
| F-11 | 🟠 | **Gates had no statistics.** A past run promoted on a noisy peak and cascaded. | diary Iteration 27 | Fixed evaluation seeds, ≥200 games per matchup, gates on the lower bound of a 95% interval, never on one window (§10) |
| F-12 | 🟠 | **Ship path understated.** v1 said the server's ML bot "gains a GRU state". The server has no neural inference at all today; bots are scripted classes. | no `onnxruntime` dependency; `server/src/index.ts:560` | Listed as real work in M4 |
| F-13 | 🟡 | **Throughput target lacked a diagnosis.** | profile (§3.3): 80%+ of time is in the engine itself | P-5 targets the engine's hot spots; the observation is only ~6% |
| F-14 | 🟡 | **Human testing came only at the end.** Self-play agents are known to be brittle against odd human play. | ROA-Star's note on AlphaStar | You playtest a snapshot at every milestone from M1 on |

Kept from v1 after checking against the research: recurrent core; spatial grid plus last-seen enemy memory; asymmetric (full-state) critic; anchors as action targets; switcher bots; 8 train / 2 held-out maps; difficulty by snapshot; LLM deferred; the stop rule.

---

## 3. Where we start (measured 2026-11-10)

### 3.1 Already fixed from the 2026-06 diagnosis
- Config overrides now survive autoreset (`slot.cfgOverrides`).
- Terminal reward is ±1 for any win type.
- `decision_interval` (k=8) exists.
- MacroBot no longer crashes.

All of these get re-verified on pool maps in M0.

### 3.2 Game-length and balance experiment (new)
5 scripted bots, 10 pairings, 4 games each, on shardfall, glimmerfen and ironreed, cap 18,000 ticks:
- **No timeouts.** Games ended between 2,591 and 13,829 ticks. Most ended by 4,500; rush vs turtle on glimmerfen ran to 13,000+.
- **Both win types occur:** crystal kills (rush mirrors, heavy vs rush) and control wins (anything involving turtle or macro).
- **Turtle wins most pairings by control:** 12/12 vs rush_medium, 12/12 vs heavy, 10/12 vs rush, 6/12 vs macro. Rush no longer dominates, but a passive control strategy may. 4 games per pairing is a small sample; P-6 runs it properly.
- This agrees with the game update's own balance gate (U5, 960 games, cap 6,000, `headless/src/balance.ts`): turtle scored 100% vs rush, 57% vs macro, 100% vs heavy. It passed that gate only because macro contests turtle, and the diary notes the counter triangle "is only partly there".

### 3.3 Throughput (new)
- `npm run bench`: 3,232 ticks/s on classic, about 2,100 on pool maps. It was 5,315 on classic after the movement update.
- CPU profile on shardfall:
  - `tick` itself: 25%
  - movement: 19%
  - visibility: 11%
  - pathfinding: ~10%
  - observation: 6%
  - legal actions: 2%
- The engine is the cost, not the observation or the bots.

### 3.4 Other facts
- GPU is a Tesla P100 16 GB (CUDA, torch 2.14.1). The old AMD-only `nn.LayerNorm` bug needs a re-test, not an assumption.
- Action table (81 flat actions) and observation predate the map update: no anchors, no terrain, no memory.
- All 10 pool maps are still `approved: null`.

---

## 4. Prerequisites (M0), before any learning code

| ID | Item | Done when |
|---|---|---|
| **P-1** | **Named anchors in `MapLayout`:** `own_base`, `own_pocket_i`, `centre_i`, `enemy_pocket_i`, `enemy_base`, `node_i`, `choke_i`. Relative to the player. | present on all 12 maps; a symmetry test passes |
| **P-2** | **Two-seat environment.** Python can control blue, red or both; the other seat can be a scripted bot. Returns each controlled seat's observation, masks and reward. Seat is randomised per episode. In self-play both seats' experience trains the learner. | a scripted-vs-scripted match driven through the new interface reproduces `runMatch` tick for tick |
| **P-3** | **Own-frame observation and actions** for both seats and both symmetry types (mirror, rotate). | test: a mirrored game state gives identical observations and masks to both seats |
| **P-4** | **Tick cap 12,000 as truncation**, with a flag the trainer can see. Live play stays uncapped. | test: truncated episodes are flagged; the value is bootstrapped |
| **P-5** | **Throughput:** find what the 25% inside `tick` is; cut movement and visibility cost. | ≥4,000 ticks/s per core on pool maps, or a written reason why not. Measured end to end: decisions/s through the full Python loop |
| **P-6** | **Balance matrix on every pool map** (all bots, ≥20 games per pairing, both seats, cap 12,000), including win types and game length. | no bot above ~80% against every other on a map. Otherwise the balance issue is fixed first, because self-play will find and sit on a dominant strategy |
| **P-7** | **Scripted bots on anchors, plus variety:** parameterised openings (build order, timing, target) so the BC data has many styles; and **switcher bots** that change plan at a random tick. | round-robin on every map without crashes; each parameterisation is tagged with its strategy token `z` |
| **P-8** | **Harness checks:** per-slot `mapId` and config survive autoreset; **every legal action has an effect** (no legal-but-nothing actions); deterministic replay reproduces observations. | tests in `npm test` |
| **P-9** | **GPU checks:** short PPO smoke run; `nn.LayerNorm` gradient check. | loss falls, no NaN |
| **P-10** | **Your map sign-off** and the choice of 2 held-out maps. | manifest has dates |

---

## 5. Observation and actions

### 5.1 Observation (in the player's own frame)
1. **Entity set** (as today), plus terrain under each unit (high ground, brush, rough).
2. **Enemy memory set:** every enemy building and unit group ever seen, at its last-seen place, with type, health and age. Built only from what this player's fog allowed.
3. **Spatial grid** (about 48×24). Channels:
   - blocked, rough, high ground, water, brush
   - currently visible, ever seen, time since seen
   - own army influence
   - last-seen enemy influence
4. **Globals:**
   - own economy and production queues
   - control-race state
   - last-seen enemy counts per unit and building type, with ages
   - time since the enemy army was last seen
5. **Strategy token `z`** (§7.2).
6. **Critic only:** the full state of both players. Used in training, never shipped.

Static grid channels are sent once per episode.

### 5.2 Actions: two parallel heads per decision (every 8 ticks = 0.8 s)
- **Economy head** (one per decision):
  - `noop`
  - `train(unit type)`
  - `build(building, anchor)`
  - `assign_workers(node, count)`
- **Army head** (one per decision): `noop` or `(group, order, target)`.
  - **group:** all combat, army A, army B, one unit type, one scout
  - **order:** attack-move, move, hold, retreat, assign-to-army
  - **target:** an anchor, or an entry in the enemy-memory set
- Each head has its own legality mask. Because one head spends resources and the other doesn't, the masks don't interact.
- At most 2 orders per 0.8 s (150 per minute). Scripted bots are capped to the same budget, in training and in BC data.

Targets that point at remembered enemy buildings are what let memory change behaviour. Two armies allow splits and flanks.

---

## 6. Policy

- **Encoders:**
  - entity set → set-transformer (existing)
  - enemy memory → small set-transformer
  - grid → small CNN
  - globals and `z` → MLP
- **Core:** one **LSTM, 256–384 units**, as in both reference systems. Training uses truncated BPTT over 32 decisions with stored hidden states. States are reset at episode ends.
- **Heads:**
  - economy and army policy heads
  - **three value heads:** win/loss, shaped, and an auxiliary economy/army differential
  - **opponent-model head:** predicts the enemy's true unit counts per type, tech buildings and army location bucket, from the policy's own (fogged) inputs. Trained with supervised loss against the simulator's ground truth. Its output is also fed back as an input to the policy heads.
- **Size:** 2–4 M parameters. Must run under 5 ms per decision on CPU.

**What the opponent-model head gives us:**
- pressure to scout and remember, which is the "notices change" property;
- a measurable quantity: how accurate is the bot's belief about you, and how quickly does it update after you switch (§10);
- an honest, displayable readout ("expects: gunners + turrets, army near centre") with no LLM.

---

## 7. Training

### 7.1 Stage A: imitation (required)
- Data: the parameterised scripted bots (P-7) playing each other on the training maps, generated online. Each action is paired with its own observation and its strategy token. This fixes both defects from diagnosis §2.4.
- Train the policy heads (cross-entropy), the value heads (on real outcomes) and the opponent-model head together.
- **Gate:** the BC policy alone wins ≥40% against the scripted pool. If it can't, the observation or action design is wrong, and RL would not have fixed it.
- When RL starts, a **KL penalty toward the BC policy** is annealed to zero over the first stage, so early noisy updates don't erase the prior.

### 7.2 Strategy token `z`
- In each episode the learner is either given a `z` (e.g. "fast expand", "skirmisher timing", "turtle to control", "bruiser tech") with a small pseudo-reward for following it, or given "free" and plays as it likes.
- Evaluation and shipped play use "free".
- Purpose: the learner keeps several styles alive, and its self-play opponents are varied, without needing a league of separate networks.
- New tokens can be added from clusters of the agent's own games later.

### 7.3 Stage B: self-play with a pool (one learner)
Opponent mix per episode, to be tuned:

| Share | Opponent | Why |
|---|---|---|
| 50% | latest self, with a random `z` | main source of improvement |
| 25% | past snapshots, sampled toward the ones it loses to | prevents forgetting and cycles (AlphaStar: 46% → 71% worst-case) |
| 25% | scripted pool, including switcher bots and converged exploiters | anchors against drift; direct pressure to notice plan changes |

- Samples are weighted toward close matchups (UECD's matchup weighting): games that are 95–5 either way teach little.
- Maps: 8 training maps, sampled toward the ones where the learner does worst.

**Exploiter cycles (replaces v1's permanent exploiters).** At each milestone:
1. Freeze the main agent.
2. Train a fresh exploiter from the BC start against only that frozen agent, for a fixed budget.
3. Record its final win rate. This is the exploitability metric (E-4).
4. Add the exploiter to the opponent pool and resume the main agent.

This is league training done in sequence. It costs about a day per cycle instead of a permanent 2/3 of all samples.

### 7.4 Reward and horizon
- **Win/loss head:** +1 / −1 on a real win (crystal or control). Truncation at the cap is not a terminal. γ=0.999 (a horizon of about 13 game-minutes), λ=0.99.
- **Shaped head:** zero-sum differentials (my change minus the opponent's change) in:
  - resources gathered
  - army value
  - damage dealt to units and buildings
  - control progress

  γ=0.99, λ=0.95. Scaled down with game time, as in OpenAI Five.
- **Mixing:** advantage weights move from shaped-heavy to win/loss-heavy over training, with the **shaped weight floored at about 0.1**. Never zero.
- **Rush-collapse monitors** (alarms, not gates): mean episode length, win-type split, production counts, opening entropy. A sharp fall in episode length while win rate rises is the published warning sign.
- No reward for "adapting". The scouting bonus from ROA-Star (reward for reducing opponent-model error) is held in reserve and only added if E-7 shows the bot doesn't scout.
- The one-time milestone bonuses in today's `reward.ts` are removed.

### 7.5 Compute
- Estimate: 10 processes × ~2,000 ticks/s ≈ 20,000 ticks/s ≈ **2,500 decisions/s**, before P-5 and before Python overhead. That is roughly 100–200 M decisions per day.
- For scale: UECD used 350 M steps in total, RAISocketAI's base model 300 M.
- These numbers are unmeasured for the new harness. P-5 replaces them with a measurement.

---

## 8. LLM strategist

Still deferred, now on evidence. Published hybrids work but cost dollars per game in planner calls, and small local models showed little strategic differentiation. The opponent-model head already gives a readable account of what the bot believes. Revisit after M3 as an optional "commentary" layer. Model choice and cost are estimated then.

---

## 9. How we avoid failing the same way

Earlier failures here came from silent harness defects and from changing several things at once. v2 makes verification part of the plan.

**Learning tests ("probes"), run in the real engine, minutes each. Every one must pass before a long run, and they re-run after any harness change:**

| Probe | Passes when | Proves |
|---|---|---|
| Overfit one BC batch | loss → ~0 | the data path and heads are wired correctly |
| Beat the idle bot | ≥95% within a small fixed budget | reward, masks and actions work end to end |
| Memory probe: enemy army shown early, then hidden; the right counter must be built later | LSTM agent ≥90%; the same agent with memory zeroed fails | recurrent state is stored, reset and used correctly |
| Seat/symmetry probe | same win rate from both seats on mirror and rotate maps | own-frame observation is right |
| Truncation probe | value near the cap is not biased toward ±1 | bootstrap is right |
| Opponent-model probe | prediction error falls after a scout sees the enemy base | labels and fog are right |

**Rules:**
1. **One new component per stage.** Each must beat the previous stage in a 3-seed short-budget comparison before it stays.
2. **Every relaunch** has its diagnosis, change and expected effect written in the diary first.
3. **Gates use statistics** (§10). No promotion on a single evaluation window.
4. **Experiment registry:** one row per run (commit, config, seeds, result) in `docs/`.
5. **Stop rule:** a milestone that misses its gate after 2 diagnosed iterations stops for your review.
6. **Time boxes** (§11). Going over a box triggers the stop rule.

---

## 10. Evaluation

All on fixed seeds, both seats, with 95% intervals. A gate is passed when the **lower bound** clears the bar.

| # | Metric | Pass bar (proposed) |
|---|---|---|
| E-1 | Win rate vs each scripted bot, ≥200 games each, training and **held-out** maps | ≥80% each by M2; held-out within 10 points of training maps |
| E-2 | Win rate vs **switcher** bots | ≥70% by M3 |
| E-3 | **Belief update:** after a switcher changes plan, time until the opponent-model head reflects it | reported at M2; the bar is set from that measurement |
| E-4 | **Reaction:** time from the switch until the bot's production mix shifts | median under ~30 s of game time by M3 |
| E-5 | **Exploitability:** win rate of a fixed-budget exploiter vs the frozen agent | falls with each cycle; under 60% by M3 |
| E-6 | **Memory ablation:** same model with LSTM state zeroed and memory set blanked | drops ≥10 points vs switchers and hidden-army bots |
| E-7 | **Scouting:** share of games with a scout reaching the enemy base early; opponent-model accuracy over time | reported; triggers the scouting bonus if poor |
| E-8 | **Variety:** entropy of opening builds across maps and opponents; win-type split | above the scripted bots'; no single opening above ~50% |
| E-9 | **No forgetting:** latest vs every past snapshot | ≥60% vs each |
| E-10 | **Your playtest**, at every milestone from M1: 5+ games, 3 strategies, at least one mid-game switch | your judgement; the final gate |

---

## 11. Milestones

| Milestone | Contents | Gate | Time box |
|---|---|---|---|
| **M0: Harness** | P-1…P-10. This includes the environment side of the new observation and action space (§5), because the two-seat runner, the scripted bots and the harness checks can't be built or tested without them | all done; balance matrix reviewed with you | ~2 weeks of build work |
| **M1: First learner** | the network on the new observation and actions, LSTM, BC, then PPO vs the scripted pool only. No self-play yet | all probes pass; BC ≥40%; after PPO, E-1 ≥70% on training maps; your first playtest | 1 week |
| **M2: Self-play** | 80/20 + scripted pool, `z` conditioning, opponent-model head feeding the policy, all 8 maps | E-1, E-9; beats the M1 agent ≥70%; no rush-collapse alarms | 1–2 weeks |
| **M3: Robust and adaptive** | 2–3 exploiter cycles; switcher pressure; reward mix toward win/loss | E-2 to E-8; your playtest | 2 weeks |
| **M4: Ship** | neural inference in the server (new: ONNX runtime, LSTM state per match, parity tests on sequences); Easy/Normal/Hard as snapshots | **your explicit go-ahead** | 3–4 days |
| **M5 (optional)** | LLM commentary experiment; show the bot's read of you in the UI | your call | — |

Within M1 and M2, components are added in this order, each tested against the last: observation and masks → LSTM → BC + KL → opponent-model head → self-play → `z` → matchup weighting.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| A dominant strategy in the game itself (turtle/control looks strong) | P-6 before training; fix balance first |
| Rush collapse or other degenerate equilibrium | reward floor, per-head discounts, monitors, snapshot pool |
| BC prior too narrow (scripted bots only, no human data) | parameterised bot variety, `z` tokens, exploiter cycles. Later option: use your own saved replays as evaluation scenarios |
| Recurrent PPO bugs | memory probe and state-reset tests |
| Throughput too low | P-5; raise k for the economy head only; smaller grid |
| Strong vs bots, brittle vs humans | playtests at every milestone; switcher and exploiter opponents |
| Overfitting to the pool maps | held-out maps; fresh `mapgen` maps for a final check |
| Scope creep | one component per stage; time boxes; stop rule |

---

## 13. Sign-off

All items were approved by the user on 2026-11-11 ("All approved by me").

| ID | Item | Recommendation | Your call |
|---|---|---|---|
| P-1…P-10 | Prerequisites (§4), ~2 weeks before any training | do all | ✅ 2026-11-11 |
| R-1 | Observation: own-frame, grid, enemy memory, full-state critic (§5.1) | as written | ✅ 2026-11-11 |
| R-2 | Actions: two parallel heads, anchors and memory targets, 2 armies (§5.2) | as written | ✅ 2026-11-11 |
| R-3 | Policy: LSTM core, three value heads, opponent-model head (§6) | as written | ✅ 2026-11-11 |
| R-4 | Imitation start with KL protection (§7.1) | required, not optional | ✅ 2026-11-11 |
| R-5 | Strategy token `z` (§7.2) | as written | ✅ 2026-11-11 |
| R-6 | One learner, 50/25/25 self-play pool, exploiter cycles instead of a permanent league (§7.3) | as written | ✅ 2026-11-11 |
| R-7 | Reward: per-head discounts, zero-sum shaping floored at 0.1, 12,000-tick truncation (§7.4) | as written | ✅ 2026-11-11 |
| R-8 | LLM strategist deferred (§8) | defer | ✅ 2026-11-11 |
| R-9 | Probes, rules and stop rule (§9) | as written | ✅ 2026-11-11 |
| R-10 | Evaluation metrics and bars (§10) | bars can be tuned | ✅ 2026-11-11 |
| R-11 | Milestones and time boxes (§11) | as written | ✅ 2026-11-11 |

**Decisions (user, 2026-11-10):**
1. **Held-out maps: `prism-ridge` and `duskvale`** (my pick, as delegated). Prism Ridge is the most open map in the pool (middle terrain density 0.18) and uses rotational symmetry; Duskvale is among the most terrain-heavy (0.25) and uses mirror symmetry. That leaves 4 rotate and 4 mirror maps for training. Provisional until the map sign-off (P-10): if either map is rejected, the nearest match replaces it.
2. **Easy/Normal/Hard are training snapshots**, not one model with handicaps.
3. **The bot's read of you is shown in both places:** a toggle in the live UI (off by default until the match ends, so it can't be used to see what the bot knows mid-game unless the player chooses to), and always on in replays. Built in M4.
4. **If P-6 confirms a dominant strategy (turtle/control), it is fixed in the game before training**, even if that delays M1.
5. **The user will playtest rough snapshots at M1 and M2**, as well as the final one.

---

## 14. Sources

- Vinyals et al., "Grandmaster level in StarCraft II using multi-agent reinforcement learning", Nature 2019: https://gwern.net/doc/reinforcement-learning/model-free/alphastar/2019-vinyals.pdf
- Berner et al., "Dota 2 with Large Scale Deep Reinforcement Learning", 2019: https://arxiv.org/abs/1912.06680
- Huang et al., "A Robust and Opponent-Aware League Training Method for StarCraft II" (ROA-Star), NeurIPS 2023: https://proceedings.neurips.cc/paper_files/paper/2023/hash/94796017d01c5a171bdac520c199d9ed-Abstract-Conference.html
- Goodfriend, "A Competition Winning Deep Reinforcement Learning Agent in microRTS" (RAISocketAI), 2024: https://arxiv.org/abs/2402.08112
- Delsart, UECD microRTS agent and CoG 2026 paper: https://github.com/mathisdelsart/microrts-drl-uecd
- "Generalization, Mayhems and Limits in Recurrent Proximal Policy Optimization", 2022: https://arxiv.org/abs/2205.11104
- "A Survey on Self-play Methods in Reinforcement Learning", 2024: https://arxiv.org/abs/2408.01072
- "Minimax Exploiter: A Data Efficient Approach for Competitive Self-Play", 2023: https://arxiv.org/abs/2311.17190
- "Large Language Models Play StarCraft II" (TextStarCraft II), NeurIPS 2024: https://arxiv.org/abs/2312.11865
- "JEV-Star: Fast, Low-Cost StarCraft II Control with Language-Model Planning", 2026: https://arxiv.org/abs/2609.27331
- "LLM-Guided Reinforcement Learning for Adaptive NPC Behavior in Multi-Agent Combat Games", 2026: https://arxiv.org/abs/2609.02931

RAISocketAI's hyperparameters (per-head γ of 0.99 / 0.999 / 0.999, λ of 0.95 / 0.99 / 0.99, 24 envs with 12 latest-self and 12 older-self, 512-step rollouts, 2 epochs, clip 0.1) were re-checked against the paper's own table on 2026-11-11. The survey and Minimax Exploiter were located but not read in depth.
