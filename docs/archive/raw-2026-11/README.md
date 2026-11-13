# Raw results, 2026-11 (archived from the session scratchpad)

Raw outputs behind the numbers quoted in `docs/DIARY.md`, `docs/experiments.md`, `docs/balance/` and the decision log in `docs/GAME_UPDATE_PLAN.md`. They are kept for reference and re-analysis only, and may predate later engine changes (check the date against ENGINE_VERSION in the diary). Large JSON files are gzipped.

- `training/`: trainer stdout. `smoke.log` (`m1-smoke-idle`), `idle_probe.log`, `idle_probe_r2.log` and `idle_probe_r3.log` (idle probe runs 1–3), `m1-imitate.log` (imitation run). `bc*.txt` and `bc5.err` are G-13 botCheck runs.
- `eval/`: `evaluate.py` JSON. `probe_eval.json` and `probe_r2_eval.json` (idle probe runs 1–2, 32 games each), `oracle_macro.json` (oracle vs idle). Run 3's 208-game eval is in `docs/eval/m1-idle-probe-r3.json`.
- `balance/`:
  - `bal*`, `mir*`, `survey*`, `len_*`, `freeze.txt`, `dv*.txt`: G-1…G-4 balance and mirror checks (2026-11-10).
  - `t1_*`: M0 T1 strategy matrix and lever runs (analysis in `t1_analyse.py`).
  - `t10*` and `sweep/`: the T10 lever sweep (`docs/balance/2026-11-matrix-v2.md`; analysis in `t10an.py` and `sweepan.py`).
  - `e6/`: the G-13 E6 re-check (Phase E base, turret range 120, v3 bots).
  - `mtx.md`: a matrix table draft.
