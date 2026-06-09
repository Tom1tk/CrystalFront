#!/usr/bin/env python3
"""
Regression test: config_overrides must persist across episode autoreset.

If this test fails, the autoreset bug (stdioVecRunner.ts: cfgOverrides lost on
episode boundary) has been reintroduced. Run after any change to the vec runner
or the Python vec env wrapper.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from training.env.crystalfront_vec_env import CrystalFrontVecEnv

OVERRIDES = {"mapWidth": 800, "crystalHealth": 50, "startingResources": 200}


def check_config(cfg, label: str) -> None:
    if cfg is None:
        print(f"FAIL: {label} — config is None (field not surfaced from runner)")
        sys.exit(1)
    for k, expected in OVERRIDES.items():
        actual = cfg.get(k)
        if actual != expected:
            print(f"FAIL: {label} — config.{k} = {actual!r}, expected {expected!r}")
            sys.exit(1)


def main() -> None:
    env = CrystalFrontVecEnv(
        vec_size=2,
        opponent="idle",
        config_overrides=OVERRIDES,
        max_ticks=60,  # short episodes so autorest fires quickly
    )
    try:
        # ── 1. Check reset() returns the correct config ───────────────────────
        results = env.reset()
        for i, (obs, info) in enumerate(results):
            check_config(info.get("config"), f"reset slot {i}")

        # ── 2. Step until each slot has completed ≥2 episodes ────────────────
        episodes_done = [0, 0]
        steps = 0
        while min(episodes_done) < 2:
            results = env.step([0, 0])
            for i, (obs, reward, done, truncated, info) in enumerate(results):
                if done:
                    episodes_done[i] += 1
                    check_config(
                        info.get("nextEpisodeConfig"),
                        f"autoreset slot {i} ep {episodes_done[i]}"
                    )
            steps += 1
            if steps > 2000:
                print(f"FAIL: did not complete 2 episodes per slot in 2000 steps "
                      f"(episodes_done={episodes_done})")
                sys.exit(1)

        # ── 3. xNorm sanity: on an 800-px map, entities can appear near x=700 ─
        # After reset, at least one entity should have xNorm > 0.5 (entities
        # span the full small map width; before Task 0.3 fix everything sat <0.14
        # relative to 6000px default). This is a soft check — WARN not FAIL.
        results = env.reset()
        for i, (obs, _info) in enumerate(results):
            ent_mat = obs["entities"]     # (MAX_ENTITIES, ENTITY_DIM)
            ent_mask = obs["entity_mask"] # (MAX_ENTITIES,)
            active = ent_mat[ent_mask]
            if active.shape[0] > 0:
                max_xnorm = float(active[:, 2].max())  # xNorm is column 2
                if max_xnorm < 0.5:
                    print(f"WARN slot {i}: max entity xNorm = {max_xnorm:.3f} < 0.5 "
                          "(Task 0.3 config-aware observation may not be applied yet)")

        print(f"PASS: config overrides persisted across {steps} steps "
              f"(episodes_done={episodes_done})")
    finally:
        env.close()


if __name__ == "__main__":
    main()
