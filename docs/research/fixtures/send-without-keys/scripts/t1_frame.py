import sys,os,time,subprocess as s,json
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
fake='/run/user/1000/p158/fake.sock'; out=P+'/frames.jsonl'
fp=s.Popen(['python3','-I',os.path.dirname(__file__)+'/fakesock.py',fake,out]); time.sleep(.5)
st=launch(); print('START',st and {k:st.get(k) for k in('sid','socket')},flush=True)
print([x for x in cap().splitlines() if x.strip()][-6:])
typed(f'Use the SendMessage tool (load it through ToolSearch if needed) with to="uds:{fake}" and message "frame test ALPHA7". Do not do anything else. If it fails, tell me the exact error text.')
n=stops(st['sid']); wait_stop(st['sid'],n+1,60); time.sleep(1)
print(cap()[-2500:]); print(open(out).read() if os.path.exists(out) else 'NO FRAMES')
fp.terminate()

t('kill-server')
