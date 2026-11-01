# Sends into a session whose foreground tool is still running. Only queue-operation enqueue records count as taken.
# The script checks the turn is still open at the end; the server is killed before any queued text reaches the model.
import sys,os,time,json,subprocess as sp
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
def send(text,variant):
    sp.run(T+['load-buffer','-b','pi','-'],input=text.encode())
    a=['paste-buffer','-b','pi','-t','p']
    if variant=='p': a.insert(1,'-p')
    t(*a); t('delete-buffer','-b','pi'); t('send-keys','-t','p','Enter')
def L(n,c): return f'Q{c:04d}x '+'\n'.join(f'line {i} alpha beta gamma' for i in range(n))
def enq(jl,tag):
    out=[]
    for l in open(jl,errors='replace'):
        if '"queue-operation"' in l and '"enqueue"' in l:
            r=json.loads(l); x=str(r.get('content'))
            if tag in x: out.append(len(x))
    return out
st=launch(); sid=st['sid']; print('START',sid,flush=True)
typed('Run exactly this Bash command in the foreground, never in the background, with timeout 300000: python3 -c "import time; time.sleep(240)" . Then reply DONE.')
t0=time.time()
while time.time()-t0<30 and not any(e['ev']=='PreToolUse' for e in evs() if e.get('sid')==sid): time.sleep(.1)
time.sleep(1.5); print('busy',[l.strip()[:80] for l in cap().splitlines() if 'esc to interrupt' in l or 'Running' in l or 'time.sleep' in l][:4],flush=True)
while not jl_for(sid): time.sleep(.1)
jl=jl_for(sid); c=0
def alive(): return stops(sid)==0 and not any(e['ev']=='PostToolUse' and e.get('sid')==sid for e in evs())
if not alive() or not any(e['ev']=='PreToolUse' and e.get('sid')==sid for e in evs()): print('NOT BUSY, aborting'); print(cap()[-600:]); t('kill-server'); sys.exit(1)
for kind,mk in (('short',lambda c:f'Q{c:04d}x short line'),('two',lambda c:L(2,c)),('five',lambda c:L(5,c)),('ten',lambda c:L(10,c)),('forty',lambda c:L(40,c))):
    for v in ('now','p'):
        rows=[]
        for i in range(8):
            c+=1; text=mk(c); tag=f'Q{c:04d}x'; send(text,v); t1=time.time(); got=None
            while time.time()-t1<1.5:
                if enq(jl,tag): got=round(time.time()-t1,2); break
                time.sleep(.03)
            rows.append(got)
            if got is None:
                # the retry confirmSubmitted sends at 1.5s
                t('send-keys','-t','p','Enter'); t2=time.time(); r=None
                while time.time()-t2<1.0:
                    if enq(jl,tag): r=round(time.time()-t2,2); break
                    time.sleep(.03)
                rows[-1]={'lost_first_enter':True,'after_retry':r}
                if r is None: rows[-1]['box']=[l[:50] for l in cap().splitlines() if l.startswith('❯')][-1:]; t('send-keys','-t','p',*(['C-u']*120))
            elif kind=='two': rows[-1]=(got,enq(jl,tag),len(text))
        print(kind,v,'busy' if alive() else 'NOT-BUSY',json.dumps(rows),flush=True)
print('turn still open',stops(sid)==0,'tool ended',any(e['ev']=='PostToolUse' and e.get('sid')==sid for e in evs()),flush=True)
# two-line unbracketed: was the second line queued as its own message?
second=[json.loads(l).get('content') for l in open(jl,errors='replace') if '"queue-operation"' in l and '"enqueue"' in l]
print('enqueues',len(second),'bare second lines',sum(1 for x in second if isinstance(x,str) and x.startswith('line 1 alpha')),flush=True)
t('kill-server')
