import sys,os,time,json,socket,uuid
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
MS='/run/user/1000/p158/mod.sock'
FROM='uds:/run/user/1000/p158/nobody.sock'
def frame(text):
    return json.dumps({'msgV':1,'msg_id':str(uuid.uuid4()),'type':'user','message':{'role':'user','content':f'<cross-session-message from="{FROM}" from-name="mux-probe" from-mode="prompting">\n{text}\n</cross-session-message>'},'priority':'next','from':FROM})+'\n'
def give(id,text):
    c=socket.socket(socket.AF_UNIX); c.settimeout(3); c.connect(MS); c.sendall((json.dumps({'id':id,'text':text,'kind':'prompt'})+'\n').encode()); c.recv(100); c.close()
def result(id):
    f=P+f'/acks/{id}.result.json'
    return json.load(open(f)) if os.path.exists(f) else None
st=launch(extra='--plugin-dir $PROBE/mod-inbox'); sid=st['sid']; sock=st['socket']; time.sleep(1); print('START',sid,flush=True)
# 1. PostToolUse mailbox while a turn runs
n=stops(sid); typed('Run Bash `sleep 8`, then Bash `sleep 2` one after the other, then reply DONE.'); time.sleep(4)
open(P+'/mailbox','w').write('The user also says: include the word HOOKX1 in your reply.')
wait_stop(sid,n+1,50); time.sleep(.5); print('A posttooluse',find_jl(sid,'HOOKX1')[:3],flush=True); print(cap()[-600:],flush=True)
# 2. asyncRewake while idle
n=stops(sid); tp=time.time(); open(P+'/rewake','w').write('The user says: reply with the word WAKEX2'); wait_stop(sid,n+1,15); print('B rewake s',round(time.time()-tp,1),find_jl(sid,'WAKEX2')[:3],flush=True); print(cap()[-600:],flush=True)
# 3. Mod submit under an open permission dialog
n=stops(sid); typed('Run this exact Bash command: touch probe_dialog.txt'); 
t0=time.time()
while time.time()-t0<25 and 'Do you want' not in cap(): time.sleep(.2)
dlg='Do you want' in cap(); print('C dialog',dlg,flush=True)
give('underdialog','Reply with the single word DLGX3'); time.sleep(4)
print('C result while dialog open',result('underdialog'),'still dialog','Do you want' in cap(),flush=True); print(cap()[-700:],flush=True)
# socket post under the same dialog
print('C socket',post(sock,frame('Reply with the word DLGX4'),read=.5)); time.sleep(3); print('C still dialog','Do you want' in cap(),find_jl(sid,'DLGX4')[:2],flush=True)
t('send-keys','-t','p','Down'); time.sleep(.2); t('send-keys','-t','p','Down'); time.sleep(.2); t('send-keys','-t','p','Enter')
time.sleep(20); print('C after answer',result('underdialog'),flush=True); print(cap()[-900:],flush=True)
# 4. Large multi-line text and order through the mod
n=stops(sid); big='Reply with the word BIGX5 and nothing else. Ignore these lines.\n'+''.join(f'line {i} alpha beta\n' for i in range(400)); 
typed('Run Bash `sleep 6`, then reply DONE.'); time.sleep(3); give('big',big); give('o2','Reply with the word ORDX6'); give('o3','Reply with the word ORDX7')
wait_stop(sid,n+3,70); time.sleep(.6)
ups=[e for e in evs() if e['ev']=='UserPromptSubmit'][-4:]; print('D ups',[(e.get('prompt_len'),e.get('prompt','')[:40]) for e in ups],[result(x) and str(result(x))[:60] for x in('o2','o3')],flush=True); print(cap()[-500:],flush=True)
t('kill-server')
# 5. inbound hold, socket reply
time.sleep(.5); st=launch(extra="--settings '{\"crossSessionInbound\":\"hold\"}'"); sid=st['sid']; sock=st['socket']; print('E start',flush=True)
print('E post',post(sock,frame('Reply with the word HOLDX8'),read=2)); time.sleep(3); print('E jsonl',find_jl(sid,'HOLDX8')[:3],'stops',stops(sid),flush=True); print(cap()[:900],flush=True)
t('kill-server')
