# Census of queue-operation lines. Prints only metadata and operation fields; never content or paths.
import glob,json,os,collections,re
files=[f for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True) if 'probe' not in f]
ops=collections.Counter(); keys=collections.Counter(); vers=collections.Counter(); nfiles=0;nlines=0
content_types=collections.Counter(); seqs=collections.Counter(); bigrams=collections.Counter()
hasattach=collections.Counter(); per_file_ends=collections.Counter()
for f in files:
    try: raw=open(f,errors='replace')
    except: continue
    hit=False; seq=[]; ver=None
    for l in raw:
        if '"version"' in l[:4000] and ver is None:
            m=re.search(r'"version":"([\d.]+)"',l)
            if m: ver=m.group(1)
        if '"queue-operation"' not in l[:200] and '"type":"queue-operation"' not in l: continue
        try:d=json.loads(l)
        except: continue
        if d.get('type')!='queue-operation': continue
        hit=True;nlines+=1
        ops[d.get('operation')]+=1
        keys[tuple(sorted(d.keys()))]+=1
        content_types[(d.get('operation'),type(d.get('content')).__name__)]+=1
        seq.append(d.get('operation'))
    if hit:
        nfiles+=1; vers[ver]+=1
        for a,b in zip(seq,seq[1:]): bigrams[(a,b)]+=1
        bal=sum(1 if o=='enqueue' else -1 if o in('dequeue','remove') else 0 for o in seq)
        per_file_ends[bal]+=1
print('files scanned',len(files),'with q-op',nfiles,'lines',nlines)
print('ops',ops);print('keys',keys);print('content',content_types)
print('bigrams',bigrams.most_common(30))
print('enqueue-(dequeue+remove) per file',sorted(per_file_ends.items()))
print('versions (first seen)',sorted(vers.items(),key=lambda x:str(x[0]))[-25:])
