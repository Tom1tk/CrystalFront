import json, sys, collections
rs = json.load(open(sys.argv[1]))
L = lambda b: b.replace("v2:", "")
bots = []
for r in rs:
    for b in (r["blue"], r["red"]):
        if b not in bots: bots.append(b)
order = ["v2:idle","v2:rush1","v2:rush2","v2:rush3","v2:turtle","v2:macro","v2:heavy","v2:hidden","v2:sw_rush_turtle","v2:sw_macro_bruiser","v2:sw_fake_brush","v2:sw_turtle_grab"]
bots = [b for b in order if b in bots]
maps = sorted({r["map"] for r in rs})
def pts(r, a):
    if r["winner"] is None: return 0.5
    return 1.0 if (r["winner"] == "blue") == (r["blue"] == a) else 0.0
def score(a, b, m=None):
    xs = [pts(r, a) for r in rs if {r["blue"], r["red"]} == {a, b} and a != b and (m is None or r["map"] == m)]
    return sum(xs) / len(xs) if xs else float("nan")
print(f"{len(rs)} games, {len(maps)} maps\n")
short = {b: L(b).replace("sw_", "s_") for b in bots}
print("| | " + " | ".join(short[b] for b in bots) + " | mean |")
print("|---" * (len(bots) + 2) + "|")
for a in bots:
    row = [("—" if a == b else f"{score(a,b):.2f}") for b in bots]
    others = [score(a, b) for b in bots if b != a]
    print(f"| **{short[a]}** | " + " | ".join(row) + f" | {sum(others)/len(others):.2f} |")
print("\nGate per map (bot scoring > 0.80 vs every other):")
fails = {}
for m in maps:
    dom = [L(a) for a in bots if all(score(a, b, m) > 0.8 for b in bots if b != a)]
    fails[m] = dom
    print(f"  {m:14} {'FAIL ' + ','.join(dom) if dom else 'pass'}")
print(f"  -> fails on {sum(1 for d in fails.values() if d)} of {len(maps)} maps")
print("\nBest bot per map (mean score vs others, excluding idle):")
for m in maps:
    ms = sorted(((sum(score(a, b, m) for b in bots if b != a) / (len(bots) - 1), L(a)) for a in bots if a != "v2:idle"), reverse=True)
    print(f"  {m:14} " + "  ".join(f"{n} {s:.2f}" for s, n in ms[:4]))
print("\nTimeouts per unordered pairing > 10%:")
pairs = collections.defaultdict(list)
for r in rs: pairs[tuple(sorted((r["blue"], r["red"])))].append(r)
tot_to = sum(1 for r in rs if r["winType"] == "timeout")
for (a, b), xs in sorted(pairs.items()):
    t = sum(1 for r in xs if r["winType"] == "timeout") / len(xs)
    if t > 0.10: print(f"  {L(a)}-{L(b)} {t:.0%} of {len(xs)}")
print(f"  overall timeouts {tot_to/len(rs):.1%}")
print("\nMirror blue score per map:")
for m in maps:
    xs = [pts(r, r["blue"]) for r in rs if r["map"] == m and r["blue"] == r["red"]]
    print(f"  {m:14} {sum(xs)/len(xs):.2f} ({len(xs)} games){'  FLAG' if abs(sum(xs)/len(xs)-0.5) > 0.1 else ''}")
xs = [pts(r, r["blue"]) for r in rs if r["blue"] != r["red"]]
print(f"Non-mirror blue score overall: {sum(xs)/len(xs):.3f}")
wt = collections.Counter(r["winType"] for r in rs)
print("\nWin types: " + ", ".join(f"{k} {v} ({v/len(rs):.0%})" for k, v in wt.most_common()))
dec = sorted(r["ticks"] for r in rs if r["winType"] != "timeout")
print(f"Decided games: mean {sum(dec)/len(dec):.0f}, median {dec[len(dec)//2]}, max {dec[-1]}")
print("\nWin types by winning bot (non-idle opponents):")
for a in bots:
    c = collections.Counter()
    for r in rs:
        if r["blue"] == r["red"] or "v2:idle" in (r["blue"], r["red"]) or a not in (r["blue"], r["red"]): continue
        side = "blue" if r["blue"] == a else "red"
        c["win_" + r["winType"] if r["winner"] == side else ("loss_" + r["winType"] if r["winner"] else "timeout")] += 1
    print(f"  {L(a):18} " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
