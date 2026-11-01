#!/usr/bin/env python3
# Logger for every event other than MessageDisplay. It never changes behaviour.
import json,sys,time,os
t=time.time(); i=json.load(sys.stdin)
keep={k:i[k] for k in ('session_id','agent_id','agent_type','tool_name','tool_use_id','transcript_path','source','agent_transcript_path') if k in i}
open(os.environ['PROBE_RUN']+'/events.jsonl','a').write(json.dumps({'src':'py','t':t,'tEnd':time.time(),'ev':i['hook_event_name'],'input':keep})+'\n')
