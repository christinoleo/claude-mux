# Counts only. For each dequeue, is the predicted entry's text in a user line within the next 40 records?
import glob,json,os,sys,collections,importlib.util as u
sp=u.spec_from_file_location('r',sys.argv[1]); r=u.module_from_spec(sp); sp.loader.exec_module(r)
c=collections.Counter()
def usertexts(recs):
    out=[]
    for e in recs:
        if e.get('type')!='user': continue
        m=(e.get('message') or {}).get('content')
        if isinstance(m,str): out.append(m)
        elif isinstance(m,list): out.append(' '.join(b.get('text','') for b in m if isinstance(b,dict) and b.get('type')=='text'))
    return out
for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True):
    if 'probe' in f: continue
    try: L=open(f,errors='replace').readlines()
    except: continue
    if not any('"queue-operation"' in l for l in L): continue
    recs=[]
    for l in L:
        try: recs.append(json.loads(l))
        except: pass
    q=[]
    for i,d in enumerate(recs):
        if d.get('type')!='queue-operation': continue
        if d.get('operation')=='dequeue' and q:
            best=min(range(len(q)),key=lambda j:(r.rank(q[j]),j)); p=q[best]['text']
            cls='none' if p is None else 'notification' if p.lstrip().startswith('<task-notification') else 'xml' if p.lstrip().startswith('<') else 'human'
            ok=False
            if p is not None:
                core=p.strip()[:80]
                ok=any(core in t for t in usertexts(recs[i+1:i+41]))
            c[(cls,'found' if ok else 'not found')]+=1
            c[('queue size at dequeue', min(len(q),4))]+=1
        r.step(q,d)
for k in sorted(c,key=str): print(k,c[k])
left=collections.Counter()
for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True):
    if 'probe' in f: continue
    try: q,_=r.replay(f)
    except OSError: continue
    if q:
        left['files with entries left at EOF']+=1; left['entries left']+=len(q); left['of them human']+=sum(r.is_human(i) for i in q)
print(dict(left))
