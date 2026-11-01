#!/usr/bin/env python3
# asyncRewake on SessionStart: waits for a mailbox file, then exits 2 with its text on stderr.
import os,sys,time
f=os.environ['PROBE']+'/rewake'
t0=time.time()
while time.time()-t0<170:
    if os.path.exists(f):
        x=open(f).read(); os.remove(f); sys.stderr.write(x); sys.exit(2)
    time.sleep(.2)
