#!/usr/bin/env python3
"""
G-10 M0 T7 tests for training/env/vec_env_v2.py (needs `npm run build:headless`).

1. Autoreset persistence: three autoresets keep map, seats and z; `configure`
   applies at the next episode boundary (changing the stream layout).
2. Stream bookkeeping: roles, zero-sum rewards for policy-vs-policy, teacher labels.
3. Throughput: random legal policy through Python, decisions/s and IPC share.

    python3 training/test_vec_env_v2.py [--procs 4] [--slots 8] [--steps 200]
"""
import argparse
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from training.env.vec_env_v2 import VecEnvV2  # noqa: E402

FAILED = []


def check(cond: bool, msg: str) -> None:
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILED.append(msg)


def legal(m):
    return [i for i, v in enumerate(m) if v]


# Action space v3 layout (headless/src/v2/actions.ts).
ECON_BUILD0, ECON_ASSIGN0, ECON_REPAIR = 6, 10, 58
GROUP_UNIT = 9


def random_action(rng: random.Random, masks: dict) -> dict:
    def pick(m):
        ix = legal(m)
        return rng.choice(ix) if ix else 0
    e = pick(masks["econ"])
    site = pick(masks["site"][e - ECON_BUILD0]) if ECON_BUILD0 <= e < ECON_ASSIGN0 else 0
    kind = e - ECON_REPAIR if e >= ECON_REPAIR else -1  # repair, rally, cancel
    eptr = pick(masks["econPtr"][kind]) if kind >= 0 else 0
    etgt = pick(masks["econTarget"]) if kind == 1 else 0
    g = pick(masks["group"])
    o = pick(masks["order"][g])
    unit = pick(masks["unit"][o]) if g == GROUP_UNIT else 0
    return {"econ": [e, site, eptr, etgt], "army": [g, o, unit, pick(masks["target"][o]), pick(masks["ptr"][o])]}


def act_all(rng, cur):
    return [None if s.role == "teach" else random_action(rng, s.masks) for s in cur]


def test_autoreset() -> None:
    print("autoreset persistence")
    rng = random.Random(1)
    env = VecEnvV2([
        {"seed": 7, "map": "ironreed", "blue": "policy", "red": "bot:random", "z": {"blue": 3}},
        {"seed": 8, "map": "shardfall", "blue": "policy", "red": "policy", "learner": ["blue"]},
        {"seed": 9, "map": "glimmerfen", "blue": "teach:random", "red": "bot:idle"},
    ], n_procs=2, max_ticks=160)
    try:
        cur = env.reset()
        check(env.streams == [(0, "blue", "learner"), (1, "blue", "learner"), (1, "red", "frozen"), (2, "blue", "teach")],
              f"stream layout and roles {env.streams}")
        check(cur[3].teacher is not None and cur[0].teacher is None, "teach stream carries the bot's action")
        ends, zero_sum, reconfigured = [], True, False
        for _ in range(200):
            out = env.step(act_all(rng, cur))
            pv = [t for t in out.transitions if t.slot == 1]
            if len(pv) == 2:
                a, b = pv[0].reward, pv[1].reward
                zero_sum &= a["win"] == -b["win"] and all(a["shaped"][k] == -b["shaped"][k] for k in a["shaped"])
            t0 = out.transitions[0]
            if t0.done or t0.truncated:
                ends.append((t0, env.episode[0]))
                check(t0.terminal is not None and "obs" in t0.terminal, f"episode {len(ends)}: terminal obs present")
                if len(ends) == 1:
                    env.configure(0, z={"blue": 5})
                    env.configure(1, red="bot:random")
                    reconfigured = True
            cur = out.current
            if len(ends) == 3:
                break
        check(len(ends) == 3 and reconfigured, f"three autoresets on slot 0 (got {len(ends)})")
        check(all(t.truncated and not t.done and t.info["ticks"] == 160 for t, _ in ends), "truncated at the cap, not done")
        check(all(e["map"] == "ironreed" and e["blue"] == "policy" and e["red"] == "bot:random" for _, e in ends), "map and seats persist")
        zs = [f'{t.info["episode"]["z"]["blue"]}>{e["z"]["blue"]}' for t, e in ends]
        check(zs == ["3>3", "3>5", "5>5"], f"configure applies at the next boundary, then persists {zs}")
        check((1, "red", "frozen") not in env.streams and (1, "blue", "learner") in env.streams, "slot 1 reconfigured to a bot opponent: its red stream is gone")
        check(zero_sum, "policy-vs-policy rewards are zero-sum")
    finally:
        env.close()


def test_throughput(procs: int, slots: int, steps: int) -> None:
    print(f"throughput: {procs} procs × {slots} slots, policy vs bot:random, {steps} steps")
    rng = random.Random(2)
    maps = ["shardfall", "glimmerfen", "ironreed", "twin-spires"]
    env = VecEnvV2([{"seed": 100 + i, "map": maps[i % len(maps)], "blue": "policy", "red": "bot:random"} for i in range(slots)],
                   n_procs=procs)
    try:
        cur = env.reset()
        t0, decisions, t_py = time.perf_counter(), 0, 0.0
        for _ in range(steps):
            a0 = time.perf_counter()
            acts = act_all(rng, cur)
            t_py += time.perf_counter() - a0
            out = env.step(acts)
            decisions += len(acts)
            cur = out.current
        sec = time.perf_counter() - t0
        print(f"  {decisions} decisions in {sec:.1f}s = {decisions / sec:.0f} decisions/s "
              f"({decisions / sec / procs:.0f}/s per proc); python action sampling {100 * t_py / sec:.1f}% of wall")
        check(decisions / sec > 0, "throughput measured")
    finally:
        env.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=4)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--steps", type=int, default=100)
    args = ap.parse_args()
    test_autoreset()
    test_throughput(args.procs, args.slots, args.steps)
    if FAILED:
        print(f"{len(FAILED)} FAILED")
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
