# Reliability of today's delivery, model-free: the UserPromptSubmit hook blocks every prompt while $PROBE/mode_block exists, so no trial reaches the model.
# variant "now" copies sendTextToPane: load-buffer, paste-buffer, delete-buffer, send-keys Enter, no gap.
# variant "p" adds paste-buffer -p (bracketed paste). Measures whether the text arrived whole, as one prompt, on the first Enter.
import sys,os,time,json,subprocess as sp
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
def send(text,variant):
    sp.run(T+['load-buffer','-b','pi','-'],input=text.encode())
    a=['paste-buffer','-b','pi','-t','p']
    if variant=='p': a.insert(1,'-p')
    t(*a); t('delete-buffer','-b','pi'); t('send-keys','-t','p','Enter')
def boxclear():
    # clear whatever is left without submitting: Ctrl+U until empty line
    t('send-keys','-t','p',*(['C-u']*260)); time.sleep(.25)
KINDS={'short':'TRIAL{} short single line of text','two':'TRIAL{} first line\nsecond line of the message','ten':'TRIAL{} '+'\n'.join(f'line {i} alpha beta gamma' for i in range(10)),'long':'TRIAL{} '+'x '*3000,'lines200':'TRIAL{} '+'\n'.join(f'line {i} alpha beta gamma' for i in range(200))}
N=int(sys.argv[1]) if len(sys.argv)>1 else 15
open(P+'/mode_block','w').close()
import hashlib
sha=lambda x:hashlib.sha1(x.encode()).hexdigest()
st=launch(); sid=st['sid']; print('START',sid,flush=True)
out={}
c=0
for kind,tmpl in KINDS.items():
    for variant in('now','p'):
        res={'whole_first_enter':0,'split':0,'stuck_in_box':0,'other':0,'detail':[]}
        for i in range(N):
            c+=1; tag=f'TRIAL{c:04d}'; text=tmpl.format(f'{c:04d}'); base=len(evs())
            send(text,variant); t0=time.time(); got=[]
            while time.time()-t0<1.2:
                got=[e for e in evs()[base:] if e['ev']=='UserPromptSubmit']
                if got: break
                time.sleep(.03)
            time.sleep(.25); got=[e for e in evs()[base:] if e['ev']=='UserPromptSubmit']
            lens=[e['prompt_len'] for e in got]
            exact=len(got)==1 and got[0]['prompt_sha']==sha(text)
            if exact: res['whole_first_enter']+=1; res['detail'].append(round(got[0]['t']-t0,2))
            elif len(got)>1: res['split']+=1; res['split_ex']=(lens,len(text))
            elif len(got)==1: res['other']+=1; res['other_ex']=(lens,len(text),got[0].get('prompt','')[:80])
            else: res['stuck_in_box']+=1; res['stuck_ex']=[l[:80] for l in cap().splitlines() if l.startswith('❯')][-1:]
            boxclear(); time.sleep(.15)
        d=res.pop('detail'); res['median_s']=sorted(d)[len(d)//2] if d else None; out[f'{kind}/{variant}']=res; print(kind,variant,json.dumps(res)[:300],flush=True)
print(cap()[-300:])
os.remove(P+'/mode_block')
t('kill-server')
