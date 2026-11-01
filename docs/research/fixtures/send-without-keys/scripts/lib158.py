import subprocess as s,time,json,os,glob,socket
P=os.environ['PROBE']; SOCK='p158'; proj=os.path.realpath(P+'/probe158-proj')
T=['tmux','-L',SOCK]
def t(*a): return s.run(T+list(a),capture_output=True,text=True).stdout
def cap(n='p',hist=400): return t('capture-pane','-p','-t',n,'-S',f'-{hist}')
def evs():
    f=P+'/events.jsonl'
    return [json.loads(l) for l in open(f)] if os.path.exists(f) else []
def jls():
    return sorted(glob.glob(os.path.expanduser('~/.claude/projects/*probe158-proj/*.jsonl')),key=os.path.getmtime)
def jl_for(sid):
    g=glob.glob(os.path.expanduser(f'~/.claude/projects/*probe158-proj/{sid}.jsonl')); return g[0] if g else None
strip=' '.join('-u '+k for k in os.environ if k.startswith('CLAUDE'))
def launch(name='p',extra='',wait=True,cwd=None):
    n0=len([e for e in evs() if e['ev']=='SessionStart'])
    env=f'env {strip} -u TMUX PROBE={P} claude --setting-sources project --model haiku --permission-mode default {extra}'
    if t('has-session','-t','=x')=='' and not s.run(T+['list-sessions'],capture_output=True).returncode==0:
        pass
    t('new-session','-d','-s',name,'-x','140','-y','50','-c',cwd or proj,env)
    t0=time.time()
    while time.time()-t0<40:
        time.sleep(.5); c=cap(name)
        low=c.lower()
        if 'trust' in low and 'yes' in low: t('send-keys','-t',name,'Enter'); time.sleep(1); continue
        if 'i am using this for local development' in low: t('send-keys','-t',name,'Enter'); time.sleep(1); continue
        if len([e for e in evs() if e['ev']=='SessionStart'])>n0 and ('⏵' in c or 'shortcuts' in c or '? for' in c): break
    time.sleep(1.5)
    st=[e for e in evs() if e['ev']=='SessionStart']
    return st[-1] if len(st)>n0 else None
def typed(x,name='p'):
    t('send-keys','-t',name,'-l',x); time.sleep(.4); t('send-keys','-t',name,'Enter')
def stops(sid): return sum(e['ev']=='Stop' and e.get('sid')==sid for e in evs())
def wait_stop(sid,n,to=90):
    t0=time.time()
    while time.time()-t0<to:
        if stops(sid)>=n: return True
        time.sleep(.2)
    return False
def post(path,payload,read=2.0):
    """Open the socket, write one newline-terminated line, report what comes back."""
    c=socket.socket(socket.AF_UNIX); c.settimeout(read); t0=time.time(); r=b''; err=None
    try:
        c.connect(path); c.sendall(payload if isinstance(payload,bytes) else payload.encode()); 
        try:
            while True:
                d=c.recv(4096)
                if not d: err='closed by peer'; break
                r+=d
        except socket.timeout: err='no reply within %.1fs'%read
    except Exception as e: err=repr(e)
    finally: c.close()
    return {'reply':r.decode(errors='replace'),'end':err,'s':round(time.time()-t0,2)}
def find_jl(sid,marker):
    j=jl_for(sid)
    if not j: return []
    out=[]
    for l in open(j,errors='replace'):
        if marker in l:
            try: d=json.loads(l)
            except: continue
            out.append({'type':d.get('type'),'op':d.get('operation'),'ts':d.get('timestamp'),'isMeta':d.get('isMeta'),'origin':d.get('origin'),'role':(d.get('message') or {}).get('role')})
    return out
