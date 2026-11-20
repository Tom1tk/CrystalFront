import json,glob,collections,statistics as st
rows=[]
for f in glob.glob('replays/*.json'):
    try: d=json.load(open(f))
    except Exception: continue
    o=d.get('outcome') or {}
    human = not any(x in (d.get('blue',''),d.get('red','')) for x in ('headless',)) and not str(d.get('blue','')).startswith(('v2-','policy'))
    rows.append(dict(ev=d.get('engineVersion'),ver=d.get('version'),map=d.get('mapId'),t=o.get('ticks'),wt=o.get('winType'),b=d.get('blue'),r=d.get('red')))
print(len(rows))
c=collections.Counter((r['b'] if len(str(r['b']))<20 else 'long', r['r'] if len(str(r['r']))<20 else 'long') for r in rows)
print(c.most_common(15))
print(collections.Counter(r['ev'] for r in rows))
print(collections.Counter(r['wt'] for r in rows))
def cat(r):
    b,rd=str(r['b']),str(r['r'])
    if 'policy' in (b,rd): return 'policy_vs_v2bot'
    if b.startswith('bot:') or rd.startswith('bot:'): return 'v2bot_vs_v2bot'
    if 'Neural' in b+rd: return 'human_vs_neural'
    if rd in ('Bot',) or b in ('Bot',): return 'human_vs_scripted'
    return 'other:'+b[:10]+'/'+rd[:10]
groups=collections.defaultdict(list)
for r in rows:
    if r['ev']==16 and r['t']: groups[cat(r)].append(r)
def q(a,p): a=sorted(a); return a[min(len(a)-1,int(p*len(a)))]
for g,rs in sorted(groups.items(),key=lambda x:-len(x[1])):
    t=[r['t']/600 for r in rs]
    wt=collections.Counter(r['wt'] for r in rs)
    over=lambda m: sum(x>=m for x in t)/len(t)
    print(f"{g:22s} n={len(t):4d} med={st.median(t):5.1f} p75={q(t,.75):5.1f} p90={q(t,.9):5.1f} max={max(t):5.1f}m  >=10m {over(10):.0%} >=14m {over(14):.0%} >=18m {over(18):.0%} >=20m {over(19.99):.0%}  {dict(wt)}")
