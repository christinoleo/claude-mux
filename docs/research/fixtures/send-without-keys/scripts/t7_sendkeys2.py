# Part 2: where the unbracketed failures start, what the retry Enter does, and the busy case.
import sys,os,time,json,subprocess as sp,hashlib
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
sha=lambda x:hashlib.sha1(x.encode()).hexdigest()
def send(text,variant,enter=True):
    sp.run(T+['load-buffer','-b','pi','-'],input=text.encode())
    a=['paste-buffer','-b','pi','-t','p']
    if variant=='p': a.insert(1,'-p')
    t(*a); t('delete-buffer','-b','pi')
    if enter: t('send-keys','-t','p','Enter')
def clear(): t('send-keys','-t','p',*(['C-u']*260)); time.sleep(.25)
def ups(base): return [e for e in evs()[base:] if e['ev']=='UserPromptSubmit']
def L(n,c): return f'T{c:04d} '+'\n'.join(f'line {i} alpha beta gamma' for i in range(n))
open(P+'/mode_block','w').close()
st=launch(); sid=st['sid']; print('START',sid,flush=True); c=0
print('--- threshold, unbracketed, then Enter again at 1.5s as confirmSubmitted does',flush=True)
for n in (2,3,4,5,6,8,10,14,20,30):
    r=[]
    for i in range(4):
        c+=1; text=L(n,c); base=len(evs()); send(text,'now'); time.sleep(1.5); a=[e['prompt_len'] for e in ups(base)]
        t('send-keys','-t','p','Enter'); time.sleep(.6); b=[e['prompt_len'] for e in ups(base)]; ok=any(e['prompt_sha']==sha(text) for e in ups(base)) ; wrapped=any(e['prompt_len']==len(text)+58 for e in ups(base))
        r.append({'before_retry':a,'after_retry':b,'sent':len(text),'exact':ok,'wrapped':wrapped}); clear()
    print(n,'lines',json.dumps(r[0]),'all same' if all(x['before_retry']==r[0]['before_retry'] and x['after_retry']==r[0]['after_retry'] for x in r[1:]) or all(len(x['after_retry'])==len(r[0]['after_retry']) for x in r) else json.dumps(r),flush=True)
print('--- single long line, unbracketed',flush=True)
for size in (200,500,800,1200,2000):
    c+=1; text=f'T{c:04d} '+'y'*size; base=len(evs()); send(text,'now'); time.sleep(.8); print(size,[e['prompt_len'] for e in ups(base)],flush=True); clear()
os.remove(P+'/mode_block')
print('--- busy: enqueue record against box',flush=True)
n0=stops(sid); typed('Run Bash `sleep 75`, then reply DONE.'); time.sleep(5); open(P+'/mode_block','w').close()
jl=jl_for(sid)
for kind,mk in (('short',lambda c:f'T{c:04d} short line'),('two',lambda c:L(2,c)),('ten',lambda c:L(10,c))):
    for variant in('now','p'):
        rows=[]
        for i in range(4):
            c+=1; text=mk(c); tag=f'T{c:04d}'; send(text,variant); t0=time.time(); enq=None; box=None
            while time.time()-t0<2.0:
                if enq is None and tag in open(jl,errors='replace').read(): enq=round(time.time()-t0,2)
                if box is None and tag not in cap(hist=0).split('────')[-2:][0]: box=round(time.time()-t0,2)
                if enq is not None and box is not None: break
                time.sleep(.03)
            rows.append({'enq_s':enq,'boxline':[l[:48] for l in cap(hist=0).splitlines() if l.startswith('❯')][-1:]}); time.sleep(.2); clear()
        print(kind,variant,json.dumps(rows[0]),[r['enq_s'] for r in rows],flush=True)
# what the transcript recorded for one bracketed ten-liner
import re
last=[json.loads(l) for l in open(jl,errors='replace') if 'queue-operation' in l]
pp=[x for x in last if x.get('operation')=='enqueue'][-1]; print('enqueue sample',json.dumps({k:(str(v)[:110]) for k,v in pp.items() if k in('operation','content')}),flush=True)
print(cap()[-600:],flush=True)
os.remove(P+'/mode_block'); t('kill-server')
