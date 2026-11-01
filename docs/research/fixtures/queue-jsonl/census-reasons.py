# Metadata-only: no content or paths printed. Reason is printed only if it is a short slug.
import glob,json,os,collections,re
from datetime import datetime
files=[f for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True) if 'probe' not in f]
reason=collections.Counter(); reason_ver=collections.defaultdict(collections.Counter)
fields_ver=collections.defaultdict(collections.Counter)
shape=collections.Counter()
dt=collections.defaultdict(list)
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
cmd_rel=collections.Counter(); deliv=collections.Counter()
null_ctx=collections.Counter()
after_rm=collections.Counter(); match=collections.Counter()
for f in files:
    try: L=open(f,errors='replace').readlines()
    except: continue
    if not any('"queue-operation"' in l for l in L): continue
    recs=[]
    for l in L:
        try: recs.append(json.loads(l))
        except: pass
    ver=None; uuids={}
    for i,d in enumerate(recs):
        if d.get('uuid'): uuids[d['uuid']]=d
    q=[]
    for i,d in enumerate(recs):
        ver=d.get('version',ver)
        if d.get('type')!='queue-operation': continue
        op=d.get('operation'); c=d.get('content')
        k='slug' if not isinstance(c,str) else ('task-notification' if c.lstrip().startswith('<task-notification') else ('xmltag' if c.lstrip().startswith('<') else ('slash' if c.startswith('/') else 'plain')))
        shape[(op,k)]+=1
        fields_ver[ver][(op,'reason' in d,'commandUuid' in d,'deliveryId' in d)]+=1
        if op=='remove':
            r=d.get('reason'); r=r if isinstance(r,str) and len(r)<40 else '(long/other)'
            reason[r]+=1; reason_ver[r][ver]+=1
            cu=d.get('commandUuid')
            if cu:
                t=uuids.get(cu)
                cmd_rel[(r,(t.get('type') if t else None),((t.get('attachment') or {}).get('type') if t else None))]+=1
            if 'deliveryId' in d: deliv[(r,bool(d['deliveryId']))]+=1
        if op=='enqueue':
            if c is None: null_ctx[tuple(sorted(d.keys()))]+=1
            q.append((d['timestamp'],c))
        elif op=='dequeue':
            if q: t,_=q.pop(0); dt['dequeue'].append(ts(d['timestamp'])-ts(t))
        elif op=='remove':
            for j,(t,cc) in enumerate(q):
                if cc==c:
                    dt['remove:'+str(d.get('reason'))[:30]].append(ts(d['timestamp'])-ts(t)); q.pop(j); break
            else: match['remove-without-matching-enqueue']+=1
    match['left-in-queue-at-eof']+=len(q)
print('reason',reason)
for r in reason_ver: print(' ',r,sorted(reason_ver[r].items(),key=str)[:12])
print('shape',sorted(shape.items(),key=str))
print('fields by version'); 
for v in sorted(fields_ver,key=str): print(' ',v,dict(fields_ver[v]))
print('commandUuid resolves to',cmd_rel)
print('deliveryId',deliv); print('null enq',null_ctx); print('match',match)
import statistics as st
for k,v in dt.items():
    v=sorted(v); print(k,'n',len(v),'median',round(st.median(v),1),'p90',round(v[int(len(v)*.9)],1),'max',round(v[-1],1))
