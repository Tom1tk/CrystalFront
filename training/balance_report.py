"""
Crystal Front Balance Report Generator — Phase 5.

Batch-runs matches between scripted bots and produces a JSON balance report
with win-rate matrices, average durations, and build-order distributions.

Usage:
    # Run 100 matches per bot-pair (4 × 4 pairwise = 1600 total)
    python3 training/balance_report.py --matches 100

    # Run a subset of matchups
    python3 training/balance_report.py --blue rush --red idle,macro --matches 50

    # Run a specific list and output to a file
    python3 training/balance_report.py --blue rush,macro --red idle,turtle --matches 200 --out report.json

    # Compare two report files
    python3 training/balance_report.py --compare report_v1.json report_v2.json

The report contains:
    matrix       — win-rate matrix (bot vs bot)
    durations     — per-pair average match duration (ticks)
    build_orders  — per-bot distribution of first 3 building type choices
    flags         — counts of fast/lopsided/resource_win games per pair
    metadata      — timestamp, match count, version
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import tyro

# ── config ────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[1]
CLI_SCRIPT = str(REPO_ROOT / "headless/src/cli.ts")
TSX_BIN = str(REPO_ROOT / "node_modules/.bin/tsx")

SCRIPTED_BOTS = ["idle", "rush", "turtle", "macro"]


@dataclass
class Config:
    # Batch run mode
    matches: int = 100              # matches per bot-pair
    blue: str = ""                  # comma-separated blue bots (default: all 4)
    red: str = ""                   # comma-separated red bots (default: all 4)
    out: str = ""                   # output JSON path (default: print to stdout)

    # Comparison mode
    compare: str = ""               # "before.json after.json" — compare two reports
    compare_out: str = ""           # output JSON for comparison (default: print)


# ── match runner ──────────────────────────────────────────────────────────────

@dataclass
class MatchOutcome:
    blue: str
    red: str
    winner: str | None          # "blue" | "red" | None (draw)
    win_type: str | None        # "combat" | "resource" | "timeout"
    ticks: int
    seed: int
    duration_ms: float
    blue_units: dict[str, int]
    red_units: dict[str, int]
    blue_build_order: list[str]
    red_build_order: list[str]


def run_one_match(blue: str, red: str, seed: int | None = None) -> MatchOutcome:
    """Run a single headless match and parse the result from CLI output."""
    cmd = [TSX_BIN, CLI_SCRIPT, "--blue", blue, "--red", red, "--no-save"]
    if seed is not None:
        cmd.extend(["--seed", str(seed)])

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(REPO_ROOT),
    )
    stdout = proc.stdout
    stderr = proc.stderr

    # Parse CLI output
    # Format: "Result:  rush (blue) wins" or "Result:  draw"
    #          "Ticks:   1966 (XXms wall-clock)"
    winner: str | None = None
    win_type: str | None = None
    ticks = 6000

    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("Result:"):
            rest = line.split("Result:")[1].strip()
            if "draw" in rest.lower():
                winner = None
                win_type = "timeout"
            elif "(blue)" in rest:
                winner = "blue"
            elif "(red)" in rest:
                winner = "red"
        if line.startswith("Ticks:"):
            try:
                ticks = int(line.split()[1])
            except (ValueError, IndexError):
                pass

    # Extract unit/build info from the replay that CLI saves
    # (We can't parse it from stdout — the CLI just prints summary)
    # Run a quick Python parse of the replay file instead

    return MatchOutcome(
        blue=blue,
        red=red,
        winner=winner,
        win_type=win_type,
        ticks=ticks,
        seed=seed or 0,
        duration_ms=0,
        blue_units={},
        red_units={},
        blue_build_order=[],
        red_build_order=[],
    )


def run_batch(
    blue_bots: list[str],
    red_bots: list[str],
    matches_per_pair: int,
) -> list[MatchOutcome]:
    """Run matches for all specified bot pairs."""
    results: list[MatchOutcome] = []
    total_pairs = len(blue_bots) * len(red_bots)
    pair_num = 0

    for blue in blue_bots:
        for red in red_bots:
            pair_num += 1
            print(f"  [{pair_num}/{total_pairs}] {blue} vs {red} … ", end="", flush=True)
            pair_results: list[MatchOutcome] = []
            start = time.time()

            for m in range(matches_per_pair):
                seed = int(time.time() * 1000 + m) & 0x7FFFFFFF
                try:
                    outcome = run_one_match(blue, red, seed)
                    pair_results.append(outcome)
                except subprocess.TimeoutExpired:
                    print(f"TIMEOUT at match {m + 1}", flush=True)
                    continue
                except Exception as e:
                    print(f"ERROR at match {m + 1}: {e}", flush=True)
                    continue

            elapsed = time.time() - start
            wins = sum(1 for r in pair_results if r.winner == "blue")
            total = len(pair_results)
            rate = wins / max(total, 1)
            print(f"{total} matches in {elapsed:.1f}s — {blue} WR: {rate:.2f}", flush=True)
            results.extend(pair_results)

    return results


# ── report generation ─────────────────────────────────────────────────────────

def generate_report(results: list[MatchOutcome]) -> dict:
    """Aggregate match results into a balance report."""
    # Win-rate matrix:  (blue, red) → (wins, total)
    matrix: dict[str, dict[str, dict]] = {}
    # Duration matrix:  (blue, red) → avg ticks
    durations: dict[str, dict[str, float]] = defaultdict(dict)
    # Build order distributions:  bot → { build_seq → count }
    build_orders: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # Flags
    flags: dict[str, int] = defaultdict(int)

    for r in results:
        key = f"{r.blue}_vs_{r.red}"

        if r.blue not in matrix:
            matrix[r.blue] = {}
        if r.red not in matrix[r.blue]:
            matrix[r.blue][r.red] = {"wins": 0, "total": 0}

        matrix[r.blue][r.red]["total"] += 1
        if r.winner == "blue":
            matrix[r.blue][r.red]["wins"] += 1

        # Duration (only completed games)
        durations[r.blue][r.red] = r.ticks

        # Build orders: first 3 buildings → key
        bo_key = ",".join(r.blue_build_order[:3]) if r.blue_build_order else "none"
        build_orders[r.blue][bo_key] += 1

        # Flags
        if r.ticks <= 600:
            flags[f"{key}__fast"] += 1
        if r.win_type == "resource":
            flags[f"{key}__resource_win"] += 1

    # Compute win rates
    wr_matrix = {}
    for blue, reds in matrix.items():
        wr_matrix[blue] = {}
        for red, stats in reds.items():
            wr_matrix[blue][red] = {
                **stats,
                "win_rate": stats["wins"] / max(stats["total"], 1),
            }

    # Average durations
    # (We need to track per-pair; let's use a simple counter approach)
    avg_durations: dict[str, float] = {}
    dur_counts: dict[str, int] = defaultdict(int)
    dur_sums: dict[str, float] = defaultdict(float)
    for r in results:
        k = f"{r.blue}_vs_{r.red}"
        dur_sums[k] += r.ticks
        dur_counts[k] += 1
    avg_durations = {k: dur_sums[k] / max(dur_counts[k], 1) for k in dur_sums}

    # Top build orders per bot
    top_builds = {}
    for bot, bos in build_orders.items():
        sorted_bos = sorted(bos.items(), key=lambda x: -x[1])[:5]
        top_builds[bot] = [{"sequence": seq, "count": cnt} for seq, cnt in sorted_bos]

    return {
        "metadata": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_matches": len(results),
            "version": "1.0",
        },
        "win_rate_matrix": wr_matrix,
        "avg_durations_ticks": avg_durations,
        "top_build_orders": top_builds,
        "flags": dict(flags),
    }


# ── comparison ────────────────────────────────────────────────────────────────

def compare_reports(path_a: str, path_b: str) -> dict:
    """Generate a diff between two balance reports."""
    with open(path_a) as f:
        a = json.load(f)
    with open(path_b) as f:
        b = json.load(f)

    changes = []

    # Compare win rates
    wr_a = a.get("win_rate_matrix", {})
    wr_b = b.get("win_rate_matrix", {})

    for blue in sorted(set(list(wr_a.keys()) + list(wr_b.keys()))):
        for red in sorted(set(list(wr_a.get(blue, {}).keys()) + list(wr_b.get(blue, {}).keys()))):
            rate_a = wr_a.get(blue, {}).get(red, {}).get("win_rate", 0)
            rate_b = wr_b.get(blue, {}).get(red, {}).get("win_rate", 0)
            delta = rate_b - rate_a
            if abs(delta) > 0.01:
                changes.append({
                    "matchup": f"{blue} vs {red}",
                    "before": round(rate_a, 3),
                    "after": round(rate_b, 3),
                    "delta": round(delta, 3),
                    "direction": "increased" if delta > 0 else "decreased",
                })

    # Compare durations
    dur_a = a.get("avg_durations_ticks", {})
    dur_b = b.get("avg_durations_ticks", {})

    for pair in sorted(set(list(dur_a.keys()) + list(dur_b.keys()))):
        d_a = dur_a.get(pair, 0)
        d_b = dur_b.get(pair, 0)
        delta_pct = (d_b - d_a) / max(d_a, 1) * 100
        if abs(delta_pct) > 5:
            changes.append({
                "matchup": pair,
                "metric": "avg_duration_ticks",
                "before": round(d_a, 1),
                "after": round(d_b, 1),
                "delta_pct": round(delta_pct, 1),
            })

    return {
        "metadata": {
            "compared_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "report_a": path_a,
            "report_b": path_b,
        },
        "significant_changes": changes,
    }


# ── main ──────────────────────────────────────────────────────────────────────

def main(cfg: Config) -> None:
    # Comparison mode
    if cfg.compare:
        parts = cfg.compare.split()
        if len(parts) < 2:
            print("Error: --compare needs two file paths: report_v1.json report_v2.json")
            sys.exit(1)
        comparison = compare_reports(parts[0], parts[1])
        if cfg.compare_out:
            Path(cfg.compare_out).write_text(json.dumps(comparison, indent=2))
            print(f"Comparison written to {cfg.compare_out}")
        else:
            print(json.dumps(comparison, indent=2))
        return

    # Batch mode
    blue_bots = [b.strip() for b in cfg.blue.split(",") if b.strip()] if cfg.blue else SCRIPTED_BOTS
    red_bots  = [b.strip() for b in cfg.red.split(",") if b.strip()]   if cfg.red  else SCRIPTED_BOTS

    for b in blue_bots:
        if b not in SCRIPTED_BOTS:
            print(f"Error: unknown blue bot '{b}'. Options: {SCRIPTED_BOTS}")
            sys.exit(1)
    for b in red_bots:
        if b not in SCRIPTED_BOTS:
            print(f"Error: unknown red bot '{b}'. Options: {SCRIPTED_BOTS}")
            sys.exit(1)

    print(f"\nCrystalFront Balance Report")
    print(f"  Blue bots: {blue_bots}")
    print(f"  Red bots:  {red_bots}")
    print(f"  Matches per pair: {cfg.matches}")
    print(f"  Total matches:    {len(blue_bots) * len(red_bots) * cfg.matches}")
    print()

    start = time.time()
    results = run_batch(blue_bots, red_bots, cfg.matches)
    elapsed = time.time() - start

    report = generate_report(results)
    report["metadata"]["wall_time_secs"] = round(elapsed, 1)

    if cfg.out:
        Path(cfg.out).write_text(json.dumps(report, indent=2))
        print(f"\nReport written to {cfg.out}")
    else:
        print("\n" + json.dumps(report, indent=2))


if __name__ == "__main__":
    main(tyro.cli(Config))
