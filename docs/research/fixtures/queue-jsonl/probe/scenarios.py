import sys,time,os; sys.path.insert(0,sys.path[0])
from lib import *
only=set(sys.argv[1:])
def want(n): return not only or n in only
LONG='Write exactly 220 numbered lines, each "LINE 001 alpha beta gamma delta epsilon" counting up. Plain text only. Use no tools.'
def tooluse(r): return r.get('type')=='assistant' and 'tool_use' in (r.get('blocks') or [])
def sleeper(x,n): 
    x.type(f'Run the Bash command `sleep {n}` with the Bash tool, then reply DONE.',note='start'); x.wait_json(tooluse,30); time.sleep(1.5)
if want('A256'):
    x=Sc('A256',['QUEUEDA1']); x.type(LONG,note='start'); time.sleep(3); x.type('QUEUEDA1 say ok',note='Q'); x.wait_json(lambda r:r.get('type')=='user' and 'QUEUEDA1' in str(r.get('text')),80); x.idle(); x.done()
if want('B256'):
    x=Sc('B256',['QUEUEDB1']); sleeper(x,12); x.type('QUEUEDB1 say ok',note='Q'); x.wait_json(lambda r:r.get('operation') in('remove','dequeue'),40); x.idle(); x.done()
if want('C'):
    x=Sc('C',['QCONE','QCTWO','QCTHREE']); x.type(LONG,note='start'); time.sleep(2)
    for m in ('QCONE say one','QCTWO say two','QCTHREE say three'): x.type(m,note=m[:6])
    x.idle(120); x.done()
if want('D'):
    x=Sc('D',['QDONE','QDTWO']); sleeper(x,22); x.type('QDONE say one',note='QDONE'); x.type('QDTWO say two',note='QDTWO'); time.sleep(1.5); x.keys('Up'); time.sleep(2); x.keys('C-u'); time.sleep(1); x.idle(40); x.done()
if want('D2'):
    x=Sc('D2',['QD2ONE','QD2EDIT']); sleeper(x,18); x.type('QD2ONE say one',note='Q'); time.sleep(1); x.keys('Up'); time.sleep(1); x.keys('C-u'); time.sleep(.5); x.type('QD2EDIT say edited',note='Qedit'); x.wait_json(lambda r:r.get('operation') in('remove','dequeue'),40); x.idle(40); x.done()
if want('E'):
    x=Sc('E',['QEONE']); sleeper(x,30); x.type('QEONE say one',note='Q'); time.sleep(1.5); x.keys('Escape'); time.sleep(4); x.idle(30); x.done()
if want('E2'):
    x=Sc('E2',['QE2ONE']); x.type(LONG,note='start'); time.sleep(2.5); x.type('QE2ONE say one',note='Q'); time.sleep(.8); x.keys('Escape'); time.sleep(4); x.idle(30); x.done()
if want('F'):
    x=Sc('F',['QFONE']); sleeper(x,30); x.type('QFONE say one',note='Q'); time.sleep(2); x.keys('C-x','C-s'); time.sleep(.2); x.wait_json(lambda r:r.get('operation') in('remove','dequeue'),30); x.idle(50); x.done()
if want('G'):
    x=Sc('G',['QGONE']); x.type(LONG,note='start'); time.sleep(2.5); x.type('QGONE say one',note='Q'); time.sleep(.8); x.keys('C-x','C-s'); x.wait_json(lambda r:r.get('operation') in('remove','dequeue'),40); x.idle(60); x.done()
if want('H'):
    x=Sc('H',['QHONE']); x.type('First write 150 numbered lines "LINE 001 alpha beta gamma" as plain text. Then run the Bash command `touch probe_h.txt` with the Bash tool. Then reply DONE.',note='start'); time.sleep(2.5); x.type('QHONE say one',note='Q')
    x.wait_screen('_dialog',lambda v:v is True,60); x.mark('dialog-seen'); time.sleep(6); x.keys('Enter'); x.wait_json(lambda r:r.get('operation') in('remove','dequeue'),30); x.idle(40); x.done()
if want('J'):
    x=Sc('J',['QJHEAD','Pasted text']); sleeper(x,14); body='QJHEAD start of paste\n'+'\n'.join(f'pasted line {i} of synthetic text' for i in range(40))
    x.paste(body,'paste'); x.wait_json(lambda r:r.get('operation') in('remove','dequeue'),30); x.idle(40); x.done()
if want('K'):
    open(P+'/mode_slow','w').close(); x=Sc('K',['SLOWQK']); sleeper(x,16); x.type('SLOWQK say one',note='Q'); x.wait_json(lambda r:r.get('operation') in('remove','dequeue'),30); x.idle(40); x.done(); os.remove(P+'/mode_slow')
if want('L'):
    open(P+'/mode_block','w').close(); x=Sc('L',['BLOCKQL','QLOK']); sleeper(x,16); x.type('BLOCKQL say one',note='Qblocked'); time.sleep(1); x.type('QLOK say two',note='Qok'); x.wait_json(lambda r:r.get('operation') in('remove','dequeue') and 'QLOK' in str(r.get('content')),30); x.idle(40); x.done(); os.remove(P+'/mode_block')
if want('M'):
    x=Sc('M',['QMONE']); sleeper(x,40); x.type('QMONE say one',note='Q'); time.sleep(1.5)
    pid=t('list-panes','-t','M','-F','#{pane_pid}').strip(); x.mark('kill -9'); s.run(f'pkill -9 -P {pid}; kill -9 {pid}',shell=True); time.sleep(1.5); jl=x.jl; x.done(kill=True)
    sid=os.path.basename(jl)[:-6]; r=Sc('M2',['QMONE'],cmd=ENV+' --resume '+sid); r.jl=jl; r.pos=os.path.getsize(jl); time.sleep(4); r.mark('resumed'); time.sleep(4); r.done()
if want('N'):
    x=Sc('N',['QNONE','QNTWO']); x.type('Reply with the single word READY.',note='warm'); x.idle(30); x.type('/compact',note='compact'); time.sleep(1.2); x.type('QNONE say one',note='QN1'); time.sleep(.6); x.type('QNTWO say two',note='QN2'); x.wait_json(lambda r:r.get('type')=='user' and 'QNONE' in str(r.get('text')),90); x.idle(60); x.done()
if want('R'):
    ms=[f'QR{i:02d}X say {i}' for i in range(12)]; x=Sc('R',ms); sleeper(x,22)
    for m in ms: x.type(m,note=m[:6])
    x.idle(60); x.done()
