# Short sends while Claude streams a long reply: how soon the transcript logs the enqueue, per variant.
import sys,os,time,json,subprocess as sp,re
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
def send(text,variant):
    sp.run(T+['load-buffer','-b','pi','-'],input=text.encode())
    a=['paste-buffer','-b','pi','-t','p']
    if variant=='p': a.insert(1,'-p')
    t(*a); t('delete-buffer','-b','pi'); t('send-keys','-t','p','Enter')
st=launch(); sid=st['sid']; print('START',sid,flush=True)
typed('Write exactly 900 numbered lines, each "L alpha beta gamma delta epsilon zeta". Plain text only, no tools, no other text.')
t0=time.time()
while time.time()-t0<30 and not re.search(r'^\W*\d+\. L alpha',cap(),re.M): time.sleep(.2)
print('streaming visible after',round(time.time()-t0,1),flush=True)

while not jl_for(sid): time.sleep(.1)
jl=jl_for(sid); c=0; res={'now':[],'p':[]}
while stops(sid)==0 and sum(map(len,res.values()))<24:
    for v in('now','p'):
        c+=1; tag=f'S{c:03d}x'; send(tag+' short line',v); t1=time.time(); got=None
        while time.time()-t1<4:
            if tag in open(jl,errors='replace').read(): got=round(time.time()-t1,2); break
            time.sleep(.03)
        res[v].append(got)
print('stopped during test',stops(sid)>0,json.dumps(res),flush=True)
print('\n'.join(cap().splitlines()[-12:])[:900],flush=True)
t('kill-server')
