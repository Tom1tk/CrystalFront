import json, sys, collections, statistics as st
R = json.load(open(sys.argv[1]))
bots = ["idle","passive","rush1","rush2","rush","rush4","turtle","macro","heavy"]
maps = sorted({r["map"] for r in R})
def score(rs, b):
    # wins for bot b over the games in rs (either seat), timeouts count as half
    w = 0
    for r in rs:
        side = "blue" if r["blue"] == b else "red"
        w += 1 if r["winner"] == side else 0.5 if r["winner"] is None else 0
    return w / len(rs)
out = []
P = lambda *a: out.append(" ".join(str(x) for x in a))
P(f"games {len(R)}, maps {len(maps)}")
# overall pairwise matrix (row bot's score vs column bot, all maps, both seats)
P("\n## Overall win rate (row vs column, all maps, both seats; timeout = 0.5)\n")
P("| | " + " | ".join(bots) + " |"); P("|" + "---|" * (len(bots) + 1))
for a in bots:
    row = []
    for b in bots:
        rs = [r for r in R if {r["blue"], r["red"]} == {a, b} and a != b]
        row.append("—" if a == b else f"{score(rs, a):.2f}")
    P(f"| **{a}** | " + " | ".join(row) + " |")
# gate per map: a bot that scores > 0.8 against every other bot on a map
P("\n## Gate: per-map dominance (score > 0.80 vs every other bot)\n")
fails = []
for m in maps:
    for a in bots:
        if all(score([r for r in R if r["map"] == m and {r["blue"], r["red"]} == {a, b}], a) > 0.8 for b in bots if b != a):
            fails.append((m, a))
P("dominant:", fails or "none")
# best bot per map and its worst matchup
P("\n## Per map: strongest bot (mean score vs others) and its worst matchup\n")
P("| map | strongest | mean | worst matchup | timeouts | mean len | max len |"); P("|---|---|---|---|---|---|---|")
for m in maps:
    rm = [r for r in R if r["map"] == m]
    means = {}
    for a in bots:
        means[a] = st.mean(score([r for r in rm if {r["blue"], r["red"]} == {a, b}], a) for b in bots if b != a)
    top = max(means, key=means.get)
    worst = min(((b, score([r for r in rm if {r["blue"], r["red"]} == {top, b}], top)) for b in bots if b != top), key=lambda x: x[1])
    to = sum(r["winner"] is None for r in rm) / len(rm)
    P(f"| {m} | {top} | {means[top]:.2f} | {worst[0]} {worst[1]:.2f} | {to:.0%} | {st.mean(r['ticks'] for r in rm):.0f} | {max(r['ticks'] for r in rm)} |")
# timeouts per pairing > 10% (excluding idle/passive pairings)
P("\n## Pairings with > 10% timeouts (excluding idle and passive)\n")
for i, a in enumerate(bots):
    for b in bots[i + 1:]:
        if {"idle", "passive"} & {a, b}: continue
        rs = [r for r in R if {r["blue"], r["red"]} == {a, b}]
        to = sum(r["winner"] is None for r in rs) / len(rs)
        if to > 0.10: P(f"- {a} vs {b}: {to:.0%}")
# mirror seat bias
P("\n## Mirror matches: blue seat win share (decided games)\n")
for a in bots:
    rs = [r for r in R if r["blue"] == a and r["red"] == a and r["winner"]]
    if rs: P(f"- {a}: blue {sum(r['winner']=='blue' for r in rs)}/{len(rs)}")
allm = [r for r in R if r["blue"] == r["red"] and r["winner"]]
P(f"- all mirrors: blue {sum(r['winner']=='blue' for r in allm)}/{len(allm)}")
# win types
P("\n## Win types\n")
c = collections.Counter(r["winType"] for r in R); P(dict(c))
P("\n## Game length (ticks, decided games)\n")
d = [r["ticks"] for r in R if r["winner"]]; P(f"mean {st.mean(d):.0f}, median {st.median(d):.0f}, max {max(d)}")
print("\n".join(out))
