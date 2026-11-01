#!/usr/bin/env python3
# PostToolUse: hands the contents of a mailbox file to the model as additionalContext, then empties it.
import json,sys,os
i=json.load(sys.stdin); f=os.environ['PROBE']+'/mailbox'
if os.path.exists(f):
    x=open(f).read(); os.remove(f)
    print(json.dumps({'hookSpecificOutput':{'hookEventName':'PostToolUse','additionalContext':x}}))
