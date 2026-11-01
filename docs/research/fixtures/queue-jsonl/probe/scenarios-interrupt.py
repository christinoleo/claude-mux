import sys,time,os; sys.path.insert(0,sys.path[0])
from lib import *
only=set(sys.argv[1:])
def want(n): return not only or n in only
def tooluse(r): return r.get('type')=='assistant' and 'tool_use' in (r.get('blocks') or [])
def sleeper(x,n):
    x.type(f'Run the Bash command `sleep {n}` with the Bash tool, in the foreground, not in the background, then reply DONE.',note='start'); x.wait_json(tooluse,30); time.sleep(1.5)
def settle(x,n=26):
    time.sleep(n)
if want('E3'):  # Esc during a running tool, one queued
    x=Sc('E3',['QE3ONE']); sleeper(x,20); x.type('QE3ONE say one',note='Q'); time.sleep(1.5); x.keys('Escape'); settle(x,10); x.done()
if want('E4'):  # Esc, Esc during a running tool, one queued
    x=Sc('E4',['QE4ONE']); sleeper(x,20); x.type('QE4ONE say one',note='Q'); time.sleep(1.5); x.keys('Escape'); time.sleep(.3); x.keys('Escape'); settle(x,10); x.done()
if want('F3'):  # send-now chord during a running tool
    x=Sc('F3',['QF3ONE']); sleeper(x,20); x.type('QF3ONE say one',note='Q'); time.sleep(2); x.keys('C-x','C-s'); settle(x,35); x.done()
if want('M3'):  # kill -9 with an entry waiting, then resume
    x=Sc('M3',['QM3ONE']); sleeper(x,20); x.type('QM3ONE say one',note='Q'); time.sleep(1.5)
    pid=t('list-panes','-t','M3','-F','#{pane_pid}').strip(); x.mark('kill -9'); s.run(f'pkill -9 -P {pid}; kill -9 {pid}',shell=True); time.sleep(1); jl=x.jl; x.done()
    sid=os.path.basename(jl)[:-6]; r=Sc('M4',['QM3ONE'],cmd=ENV+' --resume '+sid); r.jl=jl; r.pos=os.path.getsize(jl); r.mark('resumed'); time.sleep(5); r.type('Reply with the single word RESUMED.',note='next'); time.sleep(8); r.done()
