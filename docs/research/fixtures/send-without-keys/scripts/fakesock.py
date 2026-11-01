#!/usr/bin/env python3
# Fake inbox: records every line a sender writes to it. Used only to read the frame shape.
import socket,sys,os,time,json,re
path,out=sys.argv[1:3]
if os.path.exists(path): os.unlink(path)
s=socket.socket(socket.AF_UNIX); s.bind(path); s.listen(5)
while True:
    c,_=s.accept(); c.settimeout(5); b=b''
    try:
        while True:
            d=c.recv(65536)
            if not d: break
            b+=d
    except socket.timeout: pass
    open(out,'a').write(json.dumps({'t':time.time(),'raw':re.sub(r'("[A-Za-z_]*[Tt]oken[A-Za-z_]*"\s*:\s*")[^"]*',r'\1<redacted>',b.decode(errors='replace'))})+'\n'); c.close()
