#!/usr/bin/env python3
"""Drive interactive Claude Code sessions in a private tmux server and time MessageDisplay.

usage: drive.py <root> <scenario[:label]> ...   (see SCEN below)
Environment: CLAUDE_BIN selects another binary; default is `claude` on PATH.

Every session: private socket, --setting-sources project, --model haiku,
--permission-mode default, every inherited CLAUDE* variable unset.
Results append to <root>/results.jsonl; raw events, the final pane and the
session transcript stay in <root>/runs/<label>/.
"""
import subprocess as sp,time,json,os,sys,glob,uuid,shutil
ROOT=os.path.realpath(sys.argv[1]); PROJ=ROOT+'/probe156-proj'; TOOLS=ROOT+'/tools'
SOCK=['tmux','-L','p156']; PORT=39156
BIN=os.environ.get('CLAUDE_BIN','claude')
MUX_SRC=os.environ.get('MUX_SRC','')
BUN=shutil.which('bun'); BUNDIR=os.path.dirname(BUN)
def tm(*a): return sp.run(SOCK+list(a),capture_output=True,text=True).stdout
def cap(): return tm('capture-pane','-p','-t','p','-S','-2000')
def send(x):
    tm('send-keys','-t','p','-l',x); time.sleep(.4); tm('send-keys','-t','p','Enter')

def logger(run): return {'type':'command','command':f'PROBE_RUN={run} python3 -I {TOOLS}/hook.py'}
def bun(run,**env):
    # same shape as hookCommand() in src/setup/hooks.ts: PATH="$PATH:<dir>" 'bun' '<script>' <event>
    pre=' '.join(f'{k}={v}' for k,v in env.items())
    return {'type':'command','command':f'{pre} PROBE_RUN={run} MUX_SRC={MUX_SRC} PATH="$PATH:{BUNDIR}" bun {TOOLS}/display-hook.ts message-display'}
def http(run,qs='',**kw): return {'type':'http','url':f'http://127.0.0.1:{PORT}/hook?run={run}{qs}',**kw}
COND={
 'none':lambda r:None,
 'bun':lambda r:bun(r),
 'http':lambda r:http(r),
 'async':lambda r:{**bun(r),'async':True},
 'slow1000':lambda r:bun(r,DELAY_MS=1000),
 'slow1000async':lambda r:{**bun(r,DELAY_MS=1000),'async':True},
 'httpslow1000':lambda r:http(r,'&delay=1000'),
 'httphang1s':lambda r:http(r,'&hang=1',timeout=1),
 'httphang10':lambda r:http(r,'&hang=1'),
 'httpslow1000async':lambda r:http(r,'&delay=1000',**{'async':True}),
 'httpdead':lambda r:{'type':'http','url':'http://127.0.0.1:39157/hook'},
 'rewrite':lambda r:bun(r,REWRITE=1),
 'slowrewrite':lambda r:bun(r,REWRITE=1,DELAY_MS=1000),
 'asyncrewrite':lambda r:{**bun(r,REWRITE=1),'async':True},
}
def settings(run,cond,extra=None):
    h={e:[{'hooks':[logger(run)]}] for e in('UserPromptSubmit','Stop','SubagentStart','SubagentStop','SessionStart')}
    for e in('PreToolUse','PostToolUse'): h[e]=[{'matcher':'*','hooks':[logger(run)]}]
    m=COND[cond](run)
    if m: h['MessageDisplay']=[{'hooks':[m]}]
    s={'hooks':h,**(extra or {})}
    json.dump(s,open(PROJ+'/.claude/settings.json','w'),indent=1)

class Sess:
    def __init__(self,label,cond,extra=None,resume=None):
        self.run=f'{ROOT}/runs/{label}'; os.makedirs(self.run,exist_ok=True)
        self.label=label; self.cond=cond; self.sid=resume or str(uuid.uuid4())
        settings(self.run,cond,extra)
        strip=' '.join('-u '+k for k in os.environ if k.startswith('CLAUDE') and k!='CLAUDE_BIN')
        flag=f'--resume {self.sid}' if resume else f'--session-id {self.sid}'
        cmd=f'env {strip} -u TMUX DISABLE_AUTOUPDATER=1 {BIN} --setting-sources project --model haiku --permission-mode default {flag}'
        tm('kill-session','-t','p')
        tm('new-session','-d','-s','p','-x','140','-y','50','-c',PROJ,cmd)
        for _ in range(60):
            time.sleep(.5); c=cap()
            if 'trust' in c.lower() and 'Yes' in c: tm('send-keys','-t','p','Enter'); time.sleep(1)
            if 'shortcuts' in c or 'for bypass' in c or '⏵' in c: break
        time.sleep(2)
    def evs(self):
        f=self.run+'/events.jsonl'
        out=[]
        if os.path.exists(f):
            for l in open(f,errors='replace'):
                try: out.append(json.loads(l))
                except ValueError: pass
        return out
    def jl(self):
        g=glob.glob(os.path.expanduser(f'~/.claude/projects/*probe156-proj/{self.sid}.jsonl'))
        return g[0] if g else None
    def nstop(self): return sum(e['ev']=='Stop' for e in self.evs())
    def wait_stop(self,n,to=150):
        t0=time.time()
        while time.time()-t0<to:
            if self.nstop()>=n: return True
            time.sleep(.1)
        return False
    def timed(self,prompt,first,last,to=170):
        """Send a prompt; record when the first and last markers reach pane and JSONL."""
        st=self.nstop(); base=len(self.evs())
        t0=time.time(); send(prompt); t0=time.time()
        seen={}; pos=0; buf=''; stopped=0
        while time.time()-t0<to:
            now=time.time()-t0; c=cap()
            j=self.jl()
            if j:
                with open(j,errors='replace') as f: f.seek(pos); more=f.read(); pos=f.tell(); buf+=more
            for ch,txt in(('pane',c),('jsonl',buf)):
                if first.lower() in txt.lower() and ch+'_first' not in seen: seen[ch+'_first']=round(now,2)
                if last.lower() in txt.lower() and ch+'_last' not in seen: seen[ch+'_last']=round(now,2)
            if len(seen)==4: break
            if self.nstop()>st:
                stopped=stopped or now
                if now-stopped>5: break
            time.sleep(.05)
        self.wait_stop(st+1,60)
        time.sleep(1.5)
        return t0,seen,self.evs()[base:]
    def close(self):
        open(self.run+'/pane.txt','w').write(cap())
        j=self.jl()
        if j: shutil.copy(j,self.run+'/transcript.jsonl')
        tm('kill-session','-t','p'); time.sleep(.5)

def md(evs): return [e for e in evs if e['ev']=='MessageDisplay']
def summ(t0,seen,evs):
    m=md(evs); st=[e for e in evs if e['ev']=='Stop']
    byidx=sorted(m,key=lambda e:(e['input']['message_id'],e['input']['index']))
    s=dict(seen)
    s['batches']=len(m)
    s['messages']=len({e['input']['message_id'] for e in m})
    if m:
        s['hook_first']=round(min(e['t'] for e in m)-t0,2); s['hook_last']=round(max(e['t'] for e in m)-t0,2)
        s['hook_lastend']=round(max(e['tEnd'] for e in m)-t0,2)
        s['hook_ms_med']=round(sorted((e['tEnd']-e['t'])*1000 for e in m)[len(m)//2],1)
        s['lines_per_batch']=[e['input']['delta'].count('\n') for e in sorted(m,key=lambda e:e['t'])][:60]
        order=[e['input']['index'] for e in sorted(m,key=lambda e:e['t'])]
        s['out_of_order']=sum(a>b for a,b in zip(order,order[1:]))
        iv=sorted((e['t'],e['tEnd']) for e in m)
        s['overlaps']=sum(iv[i+1][0]<iv[i][1] for i in range(len(iv)-1))
        s['finals']=sum(bool(e['input'].get('final')) for e in m)
        s['fields']=sorted(m[0]['input'].keys())
    if st: s['stop']=round(st[0]['t']-t0,2)
    if 'pane_last' in s and 'jsonl_last' in s: s['pane_minus_jsonl']=round(s['pane_last']-s['jsonl_last'],2)
    return s
def save(label,cond,**r):
    rec={'label':label,'cond':cond,'bin':BIN,**r}
    open(ROOT+'/results.jsonl','a').write(json.dumps(rec)+'\n')
    print(json.dumps({k:v for k,v in rec.items() if k!='lines_per_batch'}),flush=True)

P150='Write exactly 150 numbered lines, each of the form "Lnnn alpha beta gamma delta" with nnn from 001 to 150. Plain text only: no code fence, no tools, no preamble, nothing after the last line.'
def lines150(label,cond):
    s=Sess(label,cond); t0,seen,evs=s.timed(P150,'L003 alpha','L150 alpha'); r=summ(t0,seen,evs); s.close(); save(label,cond,scenario='lines150',**r)
PARA='Write one single paragraph of about 1000 words on how bridges carry load. It must contain no line breaks at all. The first word must be ZEBRA joined to FISH as one capitalised word, and the last word must be OSTRI joined to CHES as one capitalised word. No markdown, no tools, no preamble.'
def para(label,cond):
    s=Sess(label,cond); t0,seen,evs=s.timed(PARA,'ZEBRAFISH','OSTRICHES'); r=summ(t0,seen,evs); s.close(); save(label,cond,scenario='para',**r)
MIX='Reply with exactly this structure, no tools, no preamble. The heading "# MIX" joined to "START" as one word. Then a fenced python code block of 30 short lines. Then a markdown table of 20 rows and 3 columns. Then a bulleted list of 10 items. Then one 100-word paragraph without line breaks. Finally a line with MIX joined to END as one word.'
def mix(label,cond):
    s=Sess(label,cond); t0,seen,evs=s.timed(MIX,'MIXSTART','MIXEND'); r=summ(t0,seen,evs); s.close(); save(label,cond,scenario='mix',**r)
ALIGN=('Do these steps in order, one message per step. Do not combine them. (1) Say exactly: ALIGN-A one. then call the Read tool on notes.txt. '
 '(2) After it returns, say exactly: ALIGN-SAME. then call the Read tool on notes.txt again. (3) After it returns, say exactly: ALIGN-SAME. then call the Glob tool with pattern *.txt. '
 '(4) After it returns, write three lines: ALIGN-Z first, ALIGN-Z second, ALIGN-Z third, with nothing after them.')
def align(label,cond):
    s=Sess(label,cond); t0,seen,evs=s.timed(ALIGN,'ALIGN-A one','ALIGN-Z third'); r=summ(t0,seen,evs); s.close(); save(label,cond,scenario='align',**r)
def alignpoll(label,cond):
    """The align prompt, recording when each transcript entry becomes visible on disk (20ms poll)."""
    s=Sess(label,cond); st=s.nstop(); t0=time.time(); send(ALIGN); pos=0; seen=[]; buf=''
    while time.time()-t0<60:
        j=s.jl()
        if j:
            with open(j,errors='replace') as f: f.seek(pos); more=f.read(); pos=f.tell(); buf+=more
            while '\n' in buf:
                l,buf=buf.split('\n',1)
                try:
                    d=json.loads(l)
                except ValueError: continue
                if d.get('type')=='assistant':
                    c=d['message']['content']
                    txt=''.join(b.get('text','') for b in c if b['type']=='text')
                    seen.append({'t':time.time(),'msg':d['message']['id'],'kinds':[b['type'] for b in c],'text':txt[:40]})
        if s.nstop()>st: break
        time.sleep(.02)
    time.sleep(1); json.dump(seen,open(s.run+'/disk.json','w'))
    m={}
    for e in md(s.evs()): m.setdefault(e['input']['message_id'],[]).append(e)
    order=sorted(m.values(),key=lambda b:min(x['t'] for x in b)); texts=[x for x in seen if x['text']]
    rows=[]
    for b,x in zip(order,texts):
        f=[e for e in b if e['input']['final']][0]; tool=any(y['msg']==x['msg'] and 'tool_use' in y['kinds'] for y in seen)
        rows.append({'text':x['text'][:16],'tool':tool,'batches':len(b),'first_batch_minus_disk':round(min(e['t'] for e in b)-x['t'],3),'final_minus_disk':round(f['t']-x['t'],3)})
    s.close(); save(label,cond,scenario='alignpoll',rows=rows)
SUB=('Use the Agent tool exactly once, in the foreground (run_in_background false), with subagent_type general-purpose. Tell the subagent: "First say exactly SUBTEXT-ONE and then call the Read tool on notes.txt. '
 'After that say exactly SUBTEXT-TWO and stop." When it has returned its result, reply with PARENT joined to -DONE as one word.')
def sub(label,cond):
    # A label ending in -fg disables background agents so the parent waits for the subagent.
    s=Sess(label,cond,extra={'env':{'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS':'1'}} if label.endswith('-fg') else None); base=len(s.evs()); t0=time.time(); send(SUB); t0=time.time(); seen={}
    while time.time()-t0<90:
        if 'PARENT-DONE' in cap(): seen['pane_last']=round(time.time()-t0,2); break
        time.sleep(.2)
    time.sleep(2); r=summ(t0,seen,s.evs()[base:]); r['subagent_events']=sum(1 for e in s.evs() if e['input'].get('agent_id'))
    r['subagent_md']=sum(1 for e in md(s.evs()) if e['input'].get('agent_id'))
    d=s.jl()[:-6]+'/subagents'
    if os.path.isdir(d): shutil.copytree(d,s.run+'/subagents',dirs_exist_ok=True)
    s.close(); save(label,cond,scenario='sub',**r)
THINK='Think carefully, step by step, in your reasoning about which of 17, 21, 23, 27 are prime; mention THINKMARK in your reasoning only. Then reply with one line: THINKREPLY followed by the primes.'
def think(label,cond):
    s=Sess(label,cond,extra={'alwaysThinkingEnabled':True,'showThinkingSummaries':True}); t0,seen,evs=s.timed(THINK,'THINKREPLY','THINKREPLY'); r=summ(t0,seen,evs); s.close(); save(label,cond,scenario='think',**r)
def interrupt(label,cond):
    """Press Escape once the hook has reported some lines, mid-message."""
    s=Sess(label,cond); st=s.nstop(); t0=time.time(); send(P150); t0=time.time(); esc=None
    while time.time()-t0<60:
        if sum(e['input'].get('index',0)>=1 for e in md(s.evs()))>=1 and 'L040 alpha' in cap(): esc=round(time.time()-t0,2); tm('send-keys','-t','p','Escape'); break
        time.sleep(.05)
    time.sleep(6); evs=s.evs(); r=summ(t0,{},evs); r['esc_at']=esc
    r['stop_events']=s.nstop()-st
    m=sorted(md(evs),key=lambda e:e['input']['index']); r['last_delta_tail']=m[-1]['input']['delta'][-30:] if m else None
    r['hook_text_lines']=sum(e['input']['delta'].count('\n') for e in m)
    # A next turn in the same session shows whether the abandoned message ever finalises.
    send('Reply with exactly: AFTERINT'); s.wait_stop(1,40); time.sleep(2)
    evs=s.evs(); r['total_finals_after_next_turn']=sum(bool(e['input'].get('final')) for e in md(evs)); r['msgs_after_next_turn']=len({e['input']['message_id'] for e in md(evs)})
    s.close(); save(label,cond,scenario='interrupt',**r)
def twoturn(label,cond):
    """Two turns, for async-output leakage and displayContent checks; pane kept in the run dir."""
    s=Sess(label,cond); t0,seen,evs=s.timed('Reply with these three lines exactly:\nmixedcase one\nmixedcase two\nmixedcase three','mixed','three'.upper() if 'rewrite' in cond and 'async' not in cond else 'case three'); r=summ(t0,seen,evs)
    r['pane_upper']='MIXEDCASE ONE' in cap(); r['pane_lower']='mixedcase one' in cap()
    t0,seen,evs=s.timed('Did any system or hook message mention displayContent, MessageDisplay or upper-case text since my last message? Answer with one line beginning NEXTTURN yes or NEXTTURN no.','NEXTTURN','NEXTTURN'); r['next_turn_pane']=[l.strip() for l in cap().splitlines() if 'NEXTTURN' in l][-1:]
    s.close(); save(label,cond,scenario='twoturn',**r)
def resume(label,cond):
    """Finish a message, then resume the session: does the history fire the hook again?"""
    s=Sess(label,cond); t0,seen,evs=s.timed('Reply with exactly: RESUMEMARK','RESUMEMARK','RESUMEMARK'); n=len(md(s.evs())); s.close(); sid=s.sid
    s2=Sess(label,cond,resume=sid); time.sleep(4); n2=len(md(s2.evs())); pane='RESUMEMARK' in cap(); s2.close()
    save(label,cond,scenario='resume',batches_before=n,batches_after_resume=n2,history_visible=pane)
def printmode(label,cond):
    """Non-interactive: docs say one call per message."""
    run=f'{ROOT}/runs/{label}'; os.makedirs(run,exist_ok=True); settings(run,cond)
    env={k:v for k,v in os.environ.items() if not (k.startswith('CLAUDE') and k!='CLAUDE_BIN')}; env.pop('TMUX',None)
    t0=time.time(); r=sp.run([BIN,'-p','Write ten lines, PRINTLINE 1 to PRINTLINE 10. No tools.','--setting-sources','project','--model','haiku','--permission-mode','default'],capture_output=True,text=True,cwd=PROJ,env=env,timeout=120)
    evs=[json.loads(l) for l in open(run+'/events.jsonl')]; m=md(evs)
    save(label,cond,scenario='print',batches=len(m),index=[e['input']['index'] for e in m],final=[e['input']['final'] for e in m],delta_lines=[e['input']['delta'].count('\n') for e in m],stdout_lines=r.stdout.count('\n'))
SCEN=dict(alignpoll=alignpoll,lines150=lines150,para=para,mix=mix,align=align,sub=sub,think=think,interrupt=interrupt,twoturn=twoturn,resume=resume,print=printmode)
open(PROJ+'/notes.txt','w').write('short note\n')
srv=sp.Popen([BUN,TOOLS+'/http-sink.ts',str(PORT)],stdout=sp.DEVNULL); time.sleep(.7)
try:
    for spec in sys.argv[2:]:   # scenario:cond:label
        sc,cond,label=spec.split(':')
        try: SCEN[sc](label,cond)
        except Exception as e: print('FAIL',spec,repr(e),flush=True)
finally:
    srv.kill(); tm('kill-server')
