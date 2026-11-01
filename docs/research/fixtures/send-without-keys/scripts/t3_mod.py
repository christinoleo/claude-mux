import sys,os,time,json,socket,glob
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
os.makedirs(P+'/acks',exist_ok=True)
MS='/run/user/1000/p158/mod.sock'
def give(id,text,kind='prompt',asUser=True,command=None,args=None):
    c=socket.socket(socket.AF_UNIX); c.settimeout(3); c.connect(MS); c.sendall((json.dumps({'id':id,'text':text,'kind':kind,'asUser':asUser,'command':command,'args':args})+'\n').encode()); r=c.recv(100).decode(); c.close(); return r.strip()
def result(id):
    f=P+f'/acks/{id}.result.json'
    return json.load(open(f)) if os.path.exists(f) else None
def trial(name,sid,text,marker,busy=None,delay=0,to=60,**kw):
    n=stops(sid)
    if busy: typed(busy); time.sleep(delay)
    tp=time.time(); r=give(name,text,**kw); seen=None; res=None; pane=None; ev=len(evs())
    while time.time()-tp<to:
        if not seen and find_jl(sid,marker): seen=round(time.time()-tp,2)
        if not pane and marker in cap(): pane=round(time.time()-tp,2)
        if not res and result(name): res=round(result(name)['at']/1000-tp,2)
        if seen and res is not None and stops(sid)>n: break
        time.sleep(.1)
    time.sleep(.5)
    print(name,json.dumps({'listener':r,'jsonl_s':seen,'pane_s':pane,'result_s':res,'result':result(name),'stops':stops(sid)-n,'records':find_jl(sid,marker)[:4],'ups':[e.get('prompt','')[:70] for e in evs()[ev:] if e['ev']=='UserPromptSubmit']}),flush=True)
st=launch(extra='--plugin-dir $PROBE/mod-inbox'); sid=st['sid']; print('START',sid,os.path.exists(MS),flush=True); time.sleep(1)
trial('idle',sid,'Reply with the single word MODX1','MODX1')
print(cap()[-700:],flush=True)
trial('busytool',sid,'Include the word MODX2 in your reply.','MODX2',busy='Run Bash `sleep 15`, then Bash `sleep 3`, then reply DONE.',delay=7)
print(cap()[-1200:],flush=True)
trial('framed',sid,'Reply with the single word MODX3','MODX3',asUser=False)
print(cap()[-600:],flush=True)
# draft in the box must survive
t('send-keys','-t','p','-l','my half typed draft'); time.sleep(.5)
trial('overdraft',sid,'Reply with the single word MODX4','MODX4',to=30)
print('DRAFT',cap()[-500:],flush=True)
t('send-keys','-t','p','C-u'); time.sleep(.4)
# slash
trial('slash_as_prompt',sid,'/rename MODX5','MODX5',to=25)
print(cap()[-500:],flush=True)
trial('slash_cmd',sid,'','MODX6',kind='command',command='rename',args='MODX6',to=15)
print(cap()[-500:],flush=True)
# stop with a prompt queued
typed('Run Bash `sleep 20`, then reply DONE.'); time.sleep(6); give('dropme','Say MODX7'); time.sleep(1); t('send-keys','-t','p','Escape'); time.sleep(4)
print('dropme',result('dropme'),flush=True); print(cap()[-500:],flush=True)
give('afterstop','Say MODX8'); time.sleep(4); print('afterstop',result('afterstop'),flush=True); typed('Say HELLO9 and nothing else'); time.sleep(6); give('afterinput','Say MODX10'); time.sleep(6); print('afterinput',result('afterinput'),flush=True)
print(cap()[-700:],flush=True)
t('kill-server'); time.sleep(.5); print('listener gone',os.path.exists(MS))
try: give('dead','x')
except Exception as e: print('dead',repr(e))
