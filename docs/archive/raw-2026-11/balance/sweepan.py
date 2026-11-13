import json
names=["base","range120","cost100","prejune","hold400","tgt_threat","tgt_units"]
bots=["turtle","sw_turtle_grab","macro","heavy","rush3","sw_rush_turtle","sw_macro_bruiser"]
nt=["macro","heavy","rush3","sw_rush_turtle","sw_macro_bruiser"]
def pts(r,a):
    if r["winner"] is None: return 0.5
    return 1.0 if (r["winner"]=="blue")==(r["blue"]==a) else 0.0
print("lever      | tg v nonturtle | turtle v nt | macro v others | tg dominant maps | max overall | timeouts | control")
for n in names:
    rs=json.load(open(f"sweep/{n}.json"))
    maps=sorted({r["map"] for r in rs})
    def sc(a,b,m=None):
        a,b="v2:"+a,"v2:"+b
        xs=[pts(r,a) for r in rs if {r["blue"],r["red"]}=={a,b} and a!=b and (m is None or r["map"]==m)]
        return sum(xs)/len(xs)
    mean=lambda a,os: sum(sc(a,b) for b in os)/len(os)
    dom=sum(1 for m in maps if all(sc("sw_turtle_grab",b,m)>0.8 for b in nt))
    overall={a:mean(a,[b for b in bots if b!=a]) for a in bots}
    top=max(overall,key=overall.get)
    to=sum(r["winner"] is None for r in rs if r["blue"]!=r["red"])/sum(r["blue"]!=r["red"] for r in rs)
    ctl=sum(r["winType"]=="control" for r in rs)/len(rs)
    print(f"{n:10} | {mean('sw_turtle_grab',nt):.2f} | {mean('turtle',nt):.2f} | {mean('macro',[b for b in bots if b!='macro']):.2f} | {dom}/10 | {top} {overall[top]:.2f} | {to:.0%} (non-mirror) | {ctl:.0%}")
