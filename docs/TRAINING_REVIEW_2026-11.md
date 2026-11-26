# Training review after b3 (2026-11-26)

b3 fixed the Outrider's dithering but not its role, and lost more often to `backdoor` (0.61, from
0.81). The user's read: the network reacts to what is in front of it, hesitates where the scripted
bots act at once, and loses to plans that pay off minutes later (a worker round the edge, a hidden
army). This reviews the pipeline from the observation up and compares it with AlphaStar, ROA-Star
and OpenAI Five. Everything below stays learned: no scripted behaviour at play time.

## 1. What the data shows

Measured on b3's final evaluation replays (`docs/eval/b3-main-c2-behaviour.json`, 16 games against
`backdoor`; same games for b2):

- **b3 sees the threat.** The base's own vision shows the outposts 0.1–0.5 min after they start
  (2.5–5 min in). The lone builder walking round the edge is seen on the way in about 9 of 16
  games, often by the Outrider itself, once from 33 px away. It is killed in 3 games, all wins.
- **It does not act on it.** b3 kills every outpost in 2 of 14 games; b2 did it in 3 of 14. When
  the skirmishers reach the crystal, about 4 of b3's army units are near home in its losses.
- **The overall pace of orders is normal.** b3 gives no army order on 64% of decisions, and 86%
  of the orders it does give change the previous one. The scripted bots: 39–74% and 66–96%. So
  the hesitation is not general churn. It is a failure to respond to specific events.
- **It doesn't bring the army home when raided.** A raid here means at least 3 enemy combat units
  that the bot can see within 700 px of its crystal, while at least 3 of its own are over 1500 px
  away. We measured how much of the away army moved at least 150 px closer to home. Numbers are
  medians over 10 s / 20 s / 40 s, from the same 160 behaviour games against 6 opponents:

  | | Raids | Away army heading home (10 s / 20 s / 40 s) | Games where over 30% head home by 20 s |
  |---|---|---|---|
  | b3 | 32 | 0.00 / 0.00 / 0.00 | 9% |
  | macro | 4 | 1.00 / 1.00 / 1.00 | 100% |
  | vanguard | 6 | 1.00 / 0.88 / 0.93 | 100% |
  | flank | 6 | 0.42 / 1.00 / 1.00 | 100% |
  | turtle | 4 | 0.77 / 0.92 / 1.00 | 75% |
  | swing | 7 | 0.44 / 0.79 / 1.00 | 86% |
  | backdoor | 3 | 0.00 / 0.00 / 0.00 | 33% |

  `backdoor` sits at zero by design: it keeps its home army apart from the raiders. The scripted
  bots respond within 10–20 s, and b3 essentially never does.

## 2. What the network gets today

| | Today | Note |
|---|---|---|
| Fog | The policy sees its own fogged view. The scripted bots see the same view: they don't cheat. In imitation, the student gets exactly the teacher's view. | No mismatch here. |
| Unit ranges, vision, speed | Not given. Each entity has a one-hot type and must learn ranges from outcomes. | The scripted bots compute distances against `UNIT_DEFS` ranges and danger radii, which is why they react at once. |
| Relations ("this enemy is 300 px from my crystal", "in range of my units") | None. The policy has positions and must work out every relation itself. | |
| Attention | Transformer over the entities, then a **mean pool** into the trunk. | One enemy worker among 60 own entities barely moves the mean. The pointer heads see entities one by one, but the decision whether to respond comes from the pooled trunk. |
| Memory | LSTM (384 units), trained over 32-decision windows (25 s). Memory slots for the last-seen enemy army and 15 enemy buildings. | A lone unit seen once (the builder on the edge) has no memory slot. |
| Critic | The policy's hidden state plus **both seats' true globals (counts only)**. | `CriticV2` computes the full unfogged entity and grid blocks, but `packCritic` sends only the globals. The critic cannot tell outposts beside its crystal from the same buildings in the enemy base. |
| Opponent model | Predicts the enemy's true unit and building counts, queue and army anchor. Its probabilities feed the policy. | It doesn't predict *where* enemy buildings are, e.g. near my base. |
| Rewards | Win ±1 (γ 0.999 per decision, half-life about 9 min). Shaped resources, army, damage and control (γ 0.99, about 80 s). b3 added a first-sighting intel reward. | The intel reward scored buildings at 1.0 and workers at 0.1. The enemy base is where most buildings are, so b3 learned "go and look at the enemy base". |
| Opponents | 24 scripted bots plus league checkpoints, sampled by loss rate (PFSP). | `backdoor` is still about 1 opponent in 24, and the builder's walk happens once per game. |
| Decisions | Every 8 ticks (0.8 s). Commit lock (5 s) only on the Outrider. | |

## 3. Why it acts on what's in front of it

Responding to the builder or the outposts pays off 1–3 minutes later (75–225 decisions). Two things
stop that credit reaching the moment of the decision:

1. **The critic can't see the danger.** The value should drop the instant an outpost goes up next to
   the crystal. With counts only, the critic sees "enemy has 3 more barracks", which is the same as a
   normal build. Killing the builder or the outpost is then not "better than expected" at the time,
   so it gets no advantage. The error only shows up when the crystal takes damage, which is through
   the dense damage reward (80 s horizon). That rewards reacting to what is in front of it, exactly
   as observed.
2. **The rare event is rare.** One opponent in 24, one builder per game. PPO with a KL anchor to the
   previous model and low entropy (0.003) seldom tries "Outrider: attack that worker". When it does,
   the noisy win signal several minutes later can't separate it from everything else in the game.

The time horizon itself (γ) is fine. OpenAI Five's final run used a 5-minute half-life; ours is
about 9 minutes for the win reward.

## 4. What our contemporaries do

- **AlphaStar** (Vinyals et al. 2019):
  - The value functions take **the opponent's observations as well** (training only) "to decrease
    variance"; ablation Fig. 3K.
  - **UPGO** (upgoing policy update): learns from partial trajectories that beat the value
    estimate, a form of self-imitation.
  - KL to the supervised policy.
  - Strategy statistic z (build order plus cumulative stats) with pseudo-rewards for following it.
    Main exploiters and league exploiters, PFSP.
  - A **delay head**: the agent chooses when it next observes (370 ms on average, up to several
    seconds). That's a learned commitment.
  - Weakness: AlphaStar was "easily defeated" by Cannon Rush on Battle.net. That is our `backdoor`:
    buildings placed next to your base.
- **ROA-Star** (NeurIPS 2023), built to fix that:
  - An **opponent-modelling** encoder trained to predict hidden opponent information, including
    *where* key buildings are ("near the player's base or near the opponent"). Its embedding feeds
    the policy.
  - A **scouting reward = the decrease in that model's cross-entropy** over a 30 s window, never
    negative. This rewards finding out what the enemy is doing, not looking at as much as possible.
  - **Goal-conditioned exploiters** that are made to play specific strategies, so rare strategies
    stay in the league.
  - Results: faster discovery of hidden buildings; worst-case win rate up from 1% to 44%; defends
    Cannon Rush "through effective scout and prompt response".
- **OpenAI Five** (2019):
  - 4096-unit LSTM, trained over only 16 steps (2.1 s), yet it planned over minutes because the
    value function carried the long horizon.
  - γ annealed from a 46 s to a 5-minute half-life.
  - Reacted to events in 217 ms on average.
  - It relied on dense shaped rewards plus a very large batch.
- **Options with a deliberation cost** (Harb et al., AAAI 2018): a small cost each time an option
  is switched stops a learner from changing its mind every step. It's the standard cure for
  dithering without hard locks.

## 5. Proposed changes, from the observation up

Ordered by expected effect per unit of work. Each one is learned and changes data or method, not
play-time rules.

1. **Full critic (AlphaStar).**
   - Send the unfogged entity and grid blocks `CriticV2` already computes, and encode them with
     their own small transformer and CNN for the value.
   - Training only; the shipped ONNX models are unchanged.
   - This is the main fix for §3.1: the value drops when the builder slips past, so intercepting it
     gets credit at once.
2. **Relational and unit-fact features (perception).**
   - Per entity: weapon range, vision range, speed (unit constants); distance to own crystal and to
     the enemy crystal; nearest enemy distance; in range of an enemy; enemies within my range;
     velocity since the last decision.
   - Grid: enemy threat (damage per second it covers) and own weapon coverage.
   - Globals: enemy structures and units within 900 px of my crystal, and time since they were
     first seen.
   - The scripted bots react quickly because they compute exactly these. Obs schema 8.
3. **Attention pooling.**
   - Replace the mean pool with a few learned attention queries, plus a separate pool over enemy
     entities, so one important enemy unit can dominate the trunk.
   - Add memory slots for last-seen enemy units outside their own half (position, heading, age), so
     the builder seen once on the edge is remembered.
4. **Opponent model and scouting reward (ROA-Star).**
   - New labels: enemy buildings within 900 px of my crystal (count bins plus the nearest anchor),
     and whether an enemy builder is outside its half.
   - Replace the first-sighting intel reward with ROA's: reward the drop in the opponent model's
     cross-entropy over 30 s, never negative.
   - Finding the builder or the outposts then pays, while staring at the enemy base doesn't.
5. **Scenario starts (curriculum).**
   - Start some episodes mid-game in the situations it fails: the `backdoor` builder already on
     its way, outposts going up, a `flank` group on its way.
   - Built from our own loss replays, by playing a replay to tick t and handing over. Engine
     support is the same work as the human-replay "start from position" idea.
   - This turns one event per 24 games into one per episode for those slots.
6. **UPGO (AlphaStar).** Add the upgoing policy loss next to PPO's: cheap, and it learns more from
   the rare games where an early intercept wins.
7. **Deliberation cost instead of locks.**
   - A small negative shaped reward when an issued army or scout order replaces a different one
     from the last few decisions.
   - Optionally, later, a learned "hold for n decisions" head (AlphaStar's delay).
8. **League: strategy-forced exploiters (ROA-Star).** Exploiters conditioned to play `backdoor`,
   `flank` and hidden-army plans, so these stay in the mix as the main agent improves.
9. **Imitation as DAgger, for defence too.**
   - Today the scout teacher labels the student's own states. Do the same for the army: a scripted
     bot's shadow decision as an auxiliary label in the student's states, annealed away.
   - Training only, like the scout teacher.

Items 1–4 change the observation, network and critic. That means schema 8 and a new action-space
version, and a fresh imitation warm start (b1-style) before the league, since old checkpoints won't
load cleanly into a new trunk. Items 5–9 work on top of either.

## 6. Suggested order

- **R1, the rebuild:**
  - Items 1–4 plus 6 and 7.
  - Imitation warm start on the new network. Check that it matches b1-imitate's accuracy and pool
    score before RL.
  - Unit tests for each new feature (frame symmetry, golden hashes unaffected).
- **R2, curriculum and league:**
  - Items 5 and 8.
  - Run 2 cycles against b3 (`docs/eval/b3-*.json`) as the baseline.
- **Gate:**
  - Pool ≥ 0.94.
  - `backdoor` ≥ 0.85 and `flank` ≥ 0.85 over 64 games.
  - Builder killed or outposts cleared before the raid in most `backdoor` games.
  - ≥ 0.5 against b3 head-to-head.
