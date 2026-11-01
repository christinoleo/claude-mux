#!/usr/bin/env python3
# Logs every hook event to $PROBE/events.jsonl. Records the path of the messaging
# socket and never touches the token variable.
import json,sys,time,os
P=os.environ['PROBE']; i=json.load(sys.stdin); ev=i['hook_event_name']
rec={'t':time.time(),'ev':ev,'sid':i.get('session_id')}
for k in ('tool_name','source'):
    if k in i: rec[k]=i[k]
if ev=='UserPromptSubmit': rec['prompt']=i.get('prompt','')[:300]; rec['prompt_len']=len(i.get('prompt','')); rec['prompt_sha']=__import__('hashlib').sha1(i.get('prompt','').encode()).hexdigest()
if ev=='SessionStart':
    rec['socket']=os.environ.get('CLAUDE_CODE_MESSAGING_SOCKET')
open(P+'/events.jsonl','a').write(json.dumps(rec)+'\n')
if ev=='UserPromptSubmit' and os.path.exists(P+'/mode_block'):
    print(json.dumps({'decision':'block','reason':'probe'}))
