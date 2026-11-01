import sys,os,time,json,socket
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
CS='/run/user/1000/p158/chan.sock'
def give(x):
    c=socket.socket(socket.AF_UNIX); c.settimeout(2); c.connect(CS); c.sendall((x+'\n').encode()); 
    try: r=c.recv(50)
    except Exception as e: r=repr(e).encode()
    c.close(); return r
def trial(name,sid,text,marker,busy=None,delay=0,to=50):
    n=stops(sid)
    if busy: typed(busy); time.sleep(delay)
    tp=time.time(); r=give(text); seen=None; pane=None; ev=len(evs())
    while time.time()-tp<to:
        if not seen and find_jl(sid,marker): seen=round(time.time()-tp,2)
        if not pane and marker in cap(): pane=round(time.time()-tp,2)
        if seen and stops(sid)>n: break
        time.sleep(.1)
    time.sleep(.5)
    print(name,json.dumps({'socket_reply':str(r),'jsonl_s':seen,'pane_s':pane,'stops':stops(sid)-n,'records':find_jl(sid,marker)[:4],'ups':[e.get('prompt','')[:110] for e in evs()[ev:] if e['ev']=='UserPromptSubmit']}),flush=True); print(cap()[-900:],flush=True)
os.environ['X']='1'
st=launch(extra='--mcp-config $PROBE/mcp.json --dangerously-load-development-channels server:muxprobe')
print('START',st and st['sid'],os.path.exists(CS),flush=True); print(cap()[:1500],flush=True)
sid=st['sid']; time.sleep(2)
trial('idle',sid,'Reply with the single word CHANX1','CHANX1')
trial('busy',sid,'Include the word CHANX2 in your reply.','CHANX2',busy='Run Bash `sleep 15`, then Bash `sleep 3`, then reply DONE.',delay=7)
trial('slash',sid,'/rename CHANX3','CHANX3',to=20)
t('kill-server')
