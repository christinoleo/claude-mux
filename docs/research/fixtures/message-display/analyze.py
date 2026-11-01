#!/usr/bin/env python3
"""Aggregate drive.py output. usage: analyze.py <root>   (reads results.jsonl and runs/*)"""
import json,sys,os,glob,statistics as st,datetime as dt
ROOT=sys.argv[1]
res=[json.loads(l) for l in open(ROOT+'/results.jsonl')]
ts=lambda s: dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
def rng(v):
    v=[x for x in v if x is not None]
    return f'{st.mean(v):.2f} [{min(v):.2f}, {max(v):.2f}] n={len(v)}' if v else '-'
def isold(r): return '2.1.152' in r.get('bin','')
print('## lines150 by condition, 2.1.309 (seconds)')
conds={}
for r in res:
    if r.get('scenario')=='lines150' and not isold(r): conds.setdefault(r['cond'],[]).append(r)
for c,rs in conds.items():
    print(f"{c:18} pane-jsonl {rng([r.get('pane_minus_jsonl') for r in rs]):30} pane_first-hook_first {rng([r['pane_first']-r['hook_first'] if r.get('pane_first') and r.get('hook_first') else None for r in rs]):30} pane span {rng([r['pane_last']-r['pane_first'] if r.get('pane_first') and r.get('pane_last') else None for r in rs]):30} batches {rng([r.get('batches') for r in rs]):28} stop-jsonl {rng([r['stop']-r['jsonl_last'] if r.get('stop') and r.get('jsonl_last') else None for r in rs])} hookms {rng([r.get('hook_ms_med') for r in rs])}")
print('\n## para')
for r in res:
    if r.get('scenario')=='para': print(r['label'],r['cond'],'bin152' if isold(r) else '',{k:r.get(k) for k in('hook_first','pane_first','pane_last','jsonl_last','batches','stop')})
print('\n## batch intervals and per-message order')
iv=[];inv_start=0;inv_end=0;nmsg=0;nb=0;cross=0;empties=0;overlap_cross=0
for rd in glob.glob(ROOT+'/runs/*'):
    f=rd+'/events.jsonl'
    if not os.path.exists(f):continue
    ms={}
    for l in open(f,errors='replace'):
        try:e=json.loads(l)
        except ValueError:continue
        if e['ev']=='MessageDisplay': ms.setdefault(e['input']['message_id'],[]).append(e)
    for m,b in ms.items():
        nmsg+=1;nb+=len(b)
        b.sort(key=lambda e:e['input']['index'])
        for x,y in zip(b,b[1:]):
            d=y['t']-x['t']
            if d<0: inv_start+=1
            if y['tEnd']<x['tEnd']: inv_end+=1
            if os.path.basename(rd).startswith(('g','pilot')): iv.append(d)
        if b[-1]['input']['final'] and b[-1]['input']['delta']=='': empties+=1
print('messages',nmsg,'batches',nb,'start inversions',inv_start,'end inversions',inv_end,'empty final deltas',empties)
print('interval quantiles (fast grid) ms',[round(x*1000) for x in st.quantiles(iv,n=10)],'median',round(st.median(iv)*1000))
print('\n## alignment across every run with a transcript')
tot=exact=0;ordinal_ok=0;runs=0;ord_runs_bad=[];pid_ok=pid_tot=0;after=[];after_tool=[];after_text=[];dup=0;notext=0
for rd in sorted(glob.glob(ROOT+'/runs/*')):
    if not os.path.exists(rd+'/transcript.jsonl') or not os.path.exists(rd+'/events.jsonl'):continue
    ev=[json.loads(l) for l in open(rd+'/events.jsonl',errors='replace') if l.strip()]
    tr=[json.loads(l) for l in open(rd+'/transcript.jsonl')]
    prompts={d.get('promptId') for d in tr if d.get('type')=='user' and d.get('promptId')}
    grouped=[];byid={}
    for d in tr:
        if d.get('type')=='assistant' and not d.get('isSidechain'):
            mid=d['message']['id']; txt=''.join(b.get('text','') for b in d['message']['content'] if b['type']=='text')
            if mid not in byid: byid[mid]={'text':'','t':None,'tool':False,'tlast':None}; grouped.append(byid[mid])
            if txt: byid[mid]['text']+=txt; byid[mid]['t']=byid[mid]['t'] or ts(d['timestamp'])
            byid[mid]['tool']|=any(b['type']=='tool_use' for b in d['message']['content'])
    grouped=[g for g in grouped if g['text']]
    ms={}
    for e in ev:
        if e['ev']=='MessageDisplay':
            ms.setdefault(e['input']['message_id'],[]).append(e)
            if 'prompt_id' in e['input']: pid_tot+=1; pid_ok+=e['input']['prompt_id'] in prompts
    order=sorted(ms.values(),key=lambda b:min(x['t'] for x in b))
    runs+=1; bad=False
    if len(order)!=len(grouped): bad=True
    for b,g in zip(order,grouped):
        b.sort(key=lambda e:e['input']['index']); j=''.join(x['input']['delta'] for x in b); tot+=1
        ok=j==g['text']; exact+=ok
        if not ok and not (g['text'].startswith(j)): bad=True
        fin=[x for x in b if x['input']['final']]
        if fin and g['t']:
            d=fin[0]['t']-g['t']; after.append(d); (after_tool if g['tool'] else after_text).append(d)
    if bad: ord_runs_bad.append((os.path.basename(rd),len(order),len(grouped)))
print('runs',runs,'messages compared',tot,'exact text',exact,'ordinal-bad runs',ord_runs_bad)
print('prompt_id found on a user entry',pid_ok,'of',pid_tot,'batches')
print('final batch start minus text entry timestamp, s: all',rng(after),'| text-only messages',rng(after_text),'| text+tool messages',rng(after_tool))
print('final before entry count',sum(d<0 for d in after),'of',len(after))
print('\n## time from the start of the hook call carrying L003 to the pane showing L003, lines150 runs')
by={}
for r in res:
    if r.get('scenario')!='lines150' or not r.get('pane_first') or not r.get('hook_first') or isold(r): continue
    f=f"{ROOT}/runs/{r['label']}/events.jsonl"
    if not os.path.exists(f): continue
    ev=[json.loads(l) for l in open(f,errors='replace') if '"MessageDisplay"' in l]
    first=min(e['t'] for e in ev); hit=[e for e in ev if 'L003' in e['input'].get('delta','')]
    if hit: by.setdefault(r['cond'],[]).append(r['pane_first']-r['hook_first']-(hit[0]['t']-first))
for c,v in by.items(): print(c,rng(v))
