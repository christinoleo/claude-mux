#!/usr/bin/env python3
"""Line up one run's MessageDisplay batches with its transcript entries. usage: inspect_run.py <run dir>"""
import json,sys,datetime as dt
R=sys.argv[1]
ev=[json.loads(l) for l in open(R+'/events.jsonl')]
tr=[json.loads(l) for l in open(R+'/transcript.jsonl')]
ts=lambda s: dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
msgs={}
for e in ev:
    if e['ev']=='MessageDisplay': msgs.setdefault(e['input']['message_id'],[]).append(e)
t0=min(e['t'] for e in ev)
print('EVENTS')
for e in sorted(ev,key=lambda e:e['t']):
    i=e['input']
    if e['ev']=='MessageDisplay': print(f" {e['t']-t0:7.2f} MD m={i['message_id'][:6]} t={i['turn_id'][:6]} idx={i['index']} final={i['final']} agent={i.get('agent_id')} lines={i['delta'].count(chr(10))} len={len(i['delta'])} {i['delta'][:40]!r}")
    else: print(f" {e['t']-t0:7.2f} {e['ev']} {i.get('tool_name','')} agent={i.get('agent_id')}")
print('TRANSCRIPT')
ids=set(msgs)|{e['input']['turn_id'] for e in ev if e['ev']=='MessageDisplay'}|{e['input'].get('prompt_id') for e in ev if e['ev']=='MessageDisplay'}
texts=[]
for d in tr:
    if d.get('type')=='assistant':
        c=d['message']['content']; kinds=[b['type'] for b in c]
        txt=''.join(b.get('text','') for b in c if b['type']=='text')
        th=''.join(b.get('thinking','') for b in c if b['type']=='thinking')
        print(f" {ts(d['timestamp'])-t0:7.2f} assistant uuid={d['uuid'][:8]} msg={d['message']['id'][-8:]} req={d.get('requestId','')[-6:]} kinds={kinds} side={d.get('isSidechain')} agent={d.get('agentId')} text={txt[:40]!r} think={len(th)}")
        if txt: texts.append(txt)
raw=json.dumps(tr)
print('IDS IN TRANSCRIPT:',{k[:8]:(k in raw) for k in ids if k})
print('KEYS',sorted({k for d in tr if d.get('type')=='assistant' for k in d}))
print('ALIGN')
for m,b in msgs.items():
    b.sort(key=lambda e:e['input']['index']); j=''.join(e['input']['delta'] for e in b)
    exact=[n for n,t in enumerate(texts) if t==j]; strip=[n for n,t in enumerate(texts) if t.strip()==j.strip()]
    print(f" {m[:6]} batches={len(b)} chars={len(j)} exact={exact} stripped={strip} end_newline={j.endswith(chr(10))} final_len={len(b[-1]['input']['delta'])} prefix={j[:24]!r}")
