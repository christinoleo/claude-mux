#!/usr/bin/env python3
# Child of the mod: takes one JSON line per connection on a Unix socket and prints it for the mod.
import socket,sys,os
path=sys.argv[1]
os.makedirs(os.path.dirname(path),exist_ok=True)
if os.path.exists(path): os.unlink(path)
s=socket.socket(socket.AF_UNIX); s.bind(path); os.chmod(path,0o600); s.listen(16)
while True:
    c,_=s.accept(); f=c.makefile('rb'); l=f.readline()
    sys.stdout.write(l.decode()); sys.stdout.flush(); c.sendall(b'{"received":true}\n'); c.close()
