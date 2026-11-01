#!/usr/bin/env python3
# Records hook events with wall-clock time. UserPromptSubmit can be slowed or blocked by mode files.
import json,sys,time,os
P=os.environ['PROBE']; i=json.load(sys.stdin); ev=i['hook_event_name']; t=time.time()
rec={'t':t,'ev':ev}
for k in ('tool_name','final','message_id','session_id'):
    if k in i: rec[k]=i[k]
if ev=='UserPromptSubmit': rec['prompt_head']=i.get('prompt','')[:40]
open(P+'/events.jsonl','a').write(json.dumps(rec)+'\n')
if ev=='UserPromptSubmit':
    if os.path.exists(P+'/mode_slow') and 'SLOW' in i.get('prompt',''): time.sleep(4)
    if os.path.exists(P+'/mode_block') and 'BLOCK' in i.get('prompt',''):
        print(json.dumps({'decision':'block','reason':'probe blocked'}))
