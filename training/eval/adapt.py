"""Per-opponent breakdown of what the agent does, from saved replays' command logs."""
import json, sys, collections, statistics as st

UNITS = ["skirmisher", "gunner", "bruiser", "medic", "bulwark"]
BLD = ["barracks", "foundry", "turret", "outpost", "supply_depot"]

def game(g):
    r = json.load(open(f"replays/{g['replayId']}.json"))
    pid = r["bluePlayerId"] if g["side"] == "blue" else r["redPlayerId"]
    W = 5000
    mine = [e for e in r["commandLog"] if e["playerId"] == pid]
    units = collections.Counter(e["command"]["unitType"] for e in mine if e["command"]["type"] == "train_unit")
    workers = sum(e["command"]["type"] == "train_worker" for e in mine)
    blds = collections.Counter(e["command"]["buildingType"] for e in mine if e["command"]["type"] == "build")
    # First attack order aimed past the centre line (into the enemy half).
    def far(c):
        x = c.get("targetX")
        return x is not None and ((x > W / 2) if g["side"] == "blue" else (x < W / 2))
    first = next((e["tick"] for e in mine if e["command"]["type"] in ("attack_move", "move") and far(e["command"])), None)
    return units, workers, blds, first

for path in sys.argv[1:]:
    G = json.load(open(path))["games"]
    print(f"\n{path.split('/')[-1]}")
    print(f"{'opponent':15s} {'win':>4s}  {'army mix (share of units trained)':44s} {'wkr':>4s} {'barr':>4s} {'foun':>4s} {'turr':>4s} {'outp':>4s}  first push")
    by = collections.defaultdict(list)
    for g in G:
        by[g["opp"]].append((g, *game(g)))
    allmix = []
    for opp, rows in by.items():
        tot = collections.Counter()
        for _, u, *_ in rows: tot += u
        n = sum(tot.values()) or 1
        mix = ", ".join(f"{k[:4]} {100 * tot[k] / n:.0f}%" for k in UNITS if tot[k])
        allmix.append([tot[k] / n for k in UNITS])
        win = sum(g["result"] == "win" for g, *_ in rows) / len(rows)
        avg = lambda f: sum(f(x) for x in rows) / len(rows)
        firsts = [x[4] for x in rows if x[4] is not None]
        fp = f"{st.median(firsts) / 600:.1f} min" if firsts else "-"
        print(f"{opp:15s} {win:4.2f}  {mix:44s} {avg(lambda x: x[2]):4.1f} {avg(lambda x: x[3]['barracks']):4.1f} {avg(lambda x: x[3]['foundry']):4.1f} {avg(lambda x: x[3]['turret']):4.1f} {avg(lambda x: x[3]['outpost']):4.1f}  {fp}")
    # How much does the mix move between opponents? Mean distance from the average mix.
    mean = [sum(m[i] for m in allmix) / len(allmix) for i in range(len(UNITS))]
    spread = sum(sum(abs(m[i] - mean[i]) for i in range(len(UNITS))) / 2 for m in allmix) / len(allmix)
    print(f"mix change between opponents (avg share of the army that differs from its overall mix): {100 * spread:.0f}%")
