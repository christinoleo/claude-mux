# Sampler: polls the pane and the JSONL side by side, logging every change with a wall-clock time.
import subprocess as s,time,json,os,glob,re,threading,hashlib,sys
SOCK='probe159'; T=['tmux','-L',SOCK]
P=os.environ['PROBE159_DIR']; PROJ=P+'/probe159-proj'; RUN=P+'/run'
def t(*a): return s.run(T+list(a),capture_output=True,text=True).stdout
def jlfiles(): return set(glob.glob(os.path.expanduser('~/.claude/projects/*probe159-proj/*.jsonl')))
strip=' '.join('-u '+k for k in os.environ if k.startswith('CLAUDE'))
COLOR=os.environ.get('PROBECOLOR','256')
CE='-u COLORTERM' if COLOR=='256' else 'COLORTERM=truecolor'
ENV=f'env {strip} {CE} -u TMUX claude --setting-sources project --model haiku --permission-mode default'
class Sc:
    def __init__(self,name,markers,cmd=ENV):
        self.name=name; self.markers=markers; self.tl=[]; self.pos=0; self.buf=''; self.stop=False; self.state={}
        self.dir=f'{RUN}/{name}'; os.makedirs(self.dir+'/caps',exist_ok=True); self.seen=set(); self.before=jlfiles(); self.jl=None
        self.sess=name; t('new-session','-d','-s',name,'-x','140','-y','50','-c',PROJ,cmd)
        for _ in range(60):
            time.sleep(.5); c=self.cap(False)
            if 'trust' in c.lower() and 'Yes' in c: t('send-keys','-t',name,'Enter'); time.sleep(1); continue
            if '⏵' in c or 'shortcuts' in c or 'default mode' in c or re.search(r'❯',c): break
        time.sleep(2)
        self.th=threading.Thread(target=self.loop,daemon=True); self.t0=time.time(); self.th.start()
    def cap(self,e=True): return t('capture-pane','-p',*(['-e'] if e else []),'-t',self.sess)
    def log(self,kind,**k): self.tl.append({'t':time.time(),'kind':kind,**k})
    def mark(self,m): self.log('mark',m=m)
    def classify(self,raw):
        lines=raw.split('\n'); clean=[re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',l) for l in lines]
        seps=[i for i,l in enumerate(clean) if re.match(r'^[─━]{20,}',l.strip())]
        box=seps[-2] if len(seps)>=2 else 10**9
        st={}
        for mk in self.markers:
            hits=[i for i,l in enumerate(clean) if mk in l]
            if not hits: st[mk]='absent'; continue
            i=hits[-1]; zone='box' if i>box else 'above'
            col=('white' if ('38;5;231' in lines[i] or '38;2;255;255;255' in lines[i]) else 'dim' if ('38;5;246' in lines[i] or '38;2;153;153;153' in lines[i]) else 'other')+('+bg' if ('48;5;237' in lines[i] or '48;2;55;55;55' in lines[i]) else '')
            mk0='❯' if clean[i].startswith('❯') else '-'
            st[mk]=f'{zone}:{col}:{mk0}'
        st['_hint']=any(re.match(r'^\s*(ctrl\+x ctrl\+s|ctrl\+enter|click) to send now\s*$',l) for l in clean)
        st['_upsell']=any('Press up to edit' in l for l in clean)
        st['_dialog']=any('Do you want' in l or 'Enter to select' in l for l in clean)
        st['_spinner']=bool(re.search(r'esc to interrupt|\(\d+s\b|\d+s ·',' '.join(clean[-14:])))
        return st
    def poll_jsonl(self):
        if not self.jl:
            n=jlfiles()-self.before
            if n: self.jl=max(n,key=os.path.getmtime)
            else: return
        with open(self.jl,errors='replace') as f:
            f.seek(self.pos); chunk=f.read(); self.pos=f.tell()
        self.buf+=chunk
        while '\n' in self.buf:
            l,self.buf=self.buf.split('\n',1)
            try:d=json.loads(l)
            except: continue
            self.tl.append({'t':time.time(),'kind':'jsonl','rec':brief(d)})
    def loop(self):
        while not self.stop:
            raw=self.cap(); self.poll_jsonl(); st=self.classify(raw)
            for k,v in st.items():
                if self.state.get(k)!=v:
                    self.state[k]=v; self.log('screen',k=k,v=v)
                    h=hashlib.md5(raw.encode()).hexdigest()[:10]
                    if h not in self.seen:
                        self.seen.add(h); open(f'{self.dir}/caps/{time.time():.3f}.txt','w').write(raw)
            time.sleep(.02)
    def type(self,x,enter=True,note=None):
        t('send-keys','-t',self.sess,'-l',x); time.sleep(.3)
        if enter: self.mark('enter:'+(note or x[:24])); t('send-keys','-t',self.sess,'Enter')
    def keys(self,*k): self.mark('keys:'+' '.join(k)); t('send-keys','-t',self.sess,*k)
    def paste(self,x,note):
        s.run(T+['load-buffer','-b','pb','-'],input=x,text=True); t('paste-buffer','-b','pb','-t',self.sess); time.sleep(.5); self.mark('enter:'+note); t('send-keys','-t',self.sess,'Enter')
    def wait_screen(self,mk,pred,to=60):
        t0=time.time()
        while time.time()-t0<to:
            if pred(self.state.get(mk,'')): return True
            time.sleep(.03)
        return False
    def wait_json(self,pred,to=60):
        t0=time.time()
        while time.time()-t0<to:
            if any(e['kind']=='jsonl' and pred(e['rec']) for e in self.tl): return True
            time.sleep(.05)
        return False
    def idle(self,to=90):
        # settled: a Stop record arrived and the spinner has been gone a second
        t0=time.time(); 
        while time.time()-t0<to:
            c=self.cap(False)
            if not re.search(r'esc to interrupt',c) and not re.search(r'\d+s ·|\(\d+s',' '.join(c.splitlines()[-14:])):
                time.sleep(1.5)
                c=self.cap(False)
                if not re.search(r'esc to interrupt',c) and not re.search(r'\d+s ·|\(\d+s',' '.join(c.splitlines()[-14:])): return True
            time.sleep(.3)
        return False
    def done(self,kill=True):
        time.sleep(1.5); self.stop=True; self.th.join()
        open(f'{self.dir}/foot.txt','w').write(self.cap(False))
        if kill: t('kill-session','-t',self.sess)
        json.dump({'t0':self.t0,'jl':self.jl,'tl':self.tl},open(f'{self.dir}/timeline.json','w'),indent=0,ensure_ascii=False)
        print(self.name,'done jl=',bool(self.jl),len(self.tl),flush=True)
def brief(d):
    ty=d.get('type'); o={'type':ty}
    if ty=='queue-operation':
        for k in('operation','reason','commandUuid','deliveryId','timestamp'):
            if k in d:o[k]=d[k]
        c=d.get('content'); o['content']=c[:70] if isinstance(c,str) else c
    elif ty=='attachment':
        a=d.get('attachment') or {}; o.update(att=a.get('type'),uuid=d.get('uuid'),timestamp=d.get('timestamp'))
        if a.get('type')=='queued_command': o.update(prompt=str(a.get('prompt'))[:70],origin=a.get('origin'),source_uuid=a.get('source_uuid'),attkeys=sorted(a.keys()))
    elif ty=='user':
        m=(d.get('message') or {}).get('content')
        o.update(uuid=d.get('uuid'),timestamp=d.get('timestamp'),text=m[:70] if isinstance(m,str) else ('blocks:'+','.join(x.get('type','?')+':'+str(x.get('text',''))[:60] for x in m) if isinstance(m,list) else None),isMeta=d.get('isMeta'))
        for k in('promptId','origin'):
            if k in d:o[k]=d[k]
    elif ty=='assistant':
        m=(d.get('message') or {}).get('content') or []
        o.update(blocks=[x.get('type') for x in m if isinstance(x,dict)],timestamp=d.get('timestamp'))
    else:
        o['timestamp']=d.get('timestamp')
    return o
