import json,sys
rs=json.load(open(sys.argv[1]))
def pts(r,a):
    if r["winner"] is None: return 0.5
    return 1.0 if (r["winner"]=="blue")==(r["blue"]==a) else 0.0
def sc(a,b,m=None):
    a,b="v2:"+a,"v2:"+b
    xs=[pts(r,a) for r in rs if {r["blue"],r["red"]}=={a,b} and (m is None or r["map"]==m)]
    return sum(xs)/len(xs), len(xs)
maps=sorted({r["map"] for r in rs})
pairs=[("turtle","macro"),("sw_turtle_grab","turtle"),("sw_rush_turtle","turtle"),("turtle","heavy"),("sw_turtle_grab","macro"),("sw_turtle_grab","sw_rush_turtle")]
print("map | "+" | ".join(f"{a} v {b}" for a,b in pairs))
for m in maps: print(m, " | ".join(f"{sc(a,b,m)[0]:.2f}" for a,b in pairs))
# min score of turtle_grab and turtle vs others per map
bots=["rush1","rush2","rush3","turtle","macro","heavy","hidden","sw_rush_turtle","sw_macro_bruiser","sw_fake_brush","sw_turtle_grab"]
for t in ["sw_turtle_grab","turtle"]:
    print(t, "worst opponent per map:")
    for m in maps:
        w=min((sc(t,b,m)[0],b) for b in bots if b!=t); print(f"   {m:13} {w[1]} {w[0]:.2f}")
# timeouts by map, and turtle-family decided-only score
import collections
to=collections.Counter(r["map"] for r in rs if r["winner"] is None); n=collections.Counter(r["map"] for r in rs)
print("timeouts by map:", {m: f"{to[m]/n[m]:.0%}" for m in maps})
