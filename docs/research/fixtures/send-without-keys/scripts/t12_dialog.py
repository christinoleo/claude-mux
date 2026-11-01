# What a paste and Enter do to an open permission dialog.
import sys,os,time,json,subprocess as sp
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
def send(text):
    sp.run(T+['load-buffer','-b','pi','-'],input=text.encode()); t('paste-buffer','-b','pi','-t','p'); t('delete-buffer','-b','pi'); t('send-keys','-t','p','Enter')
st=launch(); sid=st['sid']; f=proj+'/dialog_probe.txt'
if os.path.exists(f): os.remove(f)
n=stops(sid); typed('Run exactly this Bash command: touch dialog_probe.txt  Then reply DONE.')
t0=time.time()
while time.time()-t0<25 and 'Do you want' not in cap(): time.sleep(.1)
print('dialog open','Do you want' in cap(),'file before',os.path.exists(f),flush=True)
send('please stop, do not run that'); time.sleep(5)
print('file after',os.path.exists(f),'dialog','Do you want' in cap(),flush=True); print('\n'.join(l[:120] for l in cap().splitlines() if l.strip())[-900:],flush=True)
t('kill-server')
