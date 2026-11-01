# Posts into a session this script started: idle and busy, plain line and observed JSON frame.
import sys,os,time,json,uuid
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
FROM='uds:/run/user/1000/p158/nobody.sock'
def frame(text,wrap=True,mode='prompting'):
    c=f'<cross-session-message from="{FROM}" from-name="mux-probe" from-mode="{mode}">\n{text}\n</cross-session-message>' if wrap else text
    return json.dumps({'msgV':1,'msg_id':str(uuid.uuid4()),'type':'user','message':{'role':'user','content':c},'priority':'next','from':FROM})+'\n'
def trial(name,sid,sock,payload,marker,to=45,busy_prompt=None,delay=0):
    n=stops(sid); t0=time.time()
    if busy_prompt: typed(busy_prompt); time.sleep(delay)
    tp=time.time(); res=post(sock,payload,read=1.5)
    seen=None; ev=len(evs()); pane=None
    while time.time()-tp<to:
        if not seen and find_jl(sid,marker): seen=round(time.time()-tp,2)
        c=cap()
        if not pane and marker in c: pane=round(time.time()-tp,2)
        if seen and stops(sid)>n: break
        time.sleep(.15)
    wait_stop(sid,n+1,to if seen or busy_prompt else 3); time.sleep(.7)
    rows=find_jl(sid,marker)
    print(name,json.dumps({'socket':res,'jsonl_first_s':seen,'pane_first_s':pane,'stop_after':stops(sid)-n,'records':rows[:5],'ups':[e.get('prompt','')[:80] for e in evs()[ev:] if e['ev']=='UserPromptSubmit']}),flush=True)
st=launch(); sid,sock=st['sid'],st['socket']; print('START',sid,sock,flush=True)
trial('idle_plain',sid,sock,'Reply with the single word PLAINX1\n','PLAINX1',to=15)
print(cap()[-700:])
trial('idle_frame',sid,sock,frame('Reply with the single word FRAMEX2'),'FRAMEX2')
print(cap()[-900:])
trial('idle_nowrap',sid,sock,frame('Reply with the single word NOWRAPX3',wrap=False),'NOWRAPX3')
print(cap()[-900:])
trial('idle_badjson',sid,sock,'{"type":"user",\n','BADX4',to=4)
trial('busy_tool',sid,sock,frame('Include the word BUSYX5 in your next text.'),'BUSYX5',busy_prompt='Run Bash `sleep 20`, then Bash `sleep 3`, then reply DONE.',delay=9)
print(cap()[-1800:])
trial('busy_stream',sid,sock,frame('Reply with the word STREAMX6 when you can.'),'STREAMX6',busy_prompt='Write exactly 120 numbered lines, each "L alpha beta gamma". Plain text only, no tools.',delay=3,to=70)
print(cap()[-900:])
trial('idle_slash',sid,sock,frame('/rename SLASHX7'),'SLASHX7',to=30)
print(cap()[-700:])
t('kill-server')
time.sleep(.5); print('dead',post(sock,frame('x')))
