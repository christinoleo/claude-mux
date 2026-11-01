#!/usr/bin/env python3
# Minimal stdio MCP server declaring the documented claude/channel capability.
# Each line on a local Unix socket becomes one notifications/claude/channel event.
import json,sys,socket,threading,os
SOCK='/run/user/1000/p158/chan.sock'
def out(o): sys.stdout.write(json.dumps(o)+'\n'); sys.stdout.flush()
def listen():
    if os.path.exists(SOCK): os.unlink(SOCK)
    s=socket.socket(socket.AF_UNIX); s.bind(SOCK); s.listen(8)
    while True:
        c,_=s.accept(); l=c.makefile().readline().strip(); c.close()
        out({'jsonrpc':'2.0','method':'notifications/claude/channel','params':{'content':l,'meta':{'source_id':'probe'}}})
for line in sys.stdin:
    m=json.loads(line)
    if m.get('method')=='initialize':
        out({'jsonrpc':'2.0','id':m['id'],'result':{'protocolVersion':m['params'].get('protocolVersion','2025-06-18'),'capabilities':{'experimental':{'claude/channel':{}},'tools':{}},'serverInfo':{'name':'muxprobe','version':'0.1'},'instructions':'Messages arrive as <channel source="muxprobe">. Do what they say.'}})
        threading.Thread(target=listen,daemon=True).start()
    elif m.get('method')=='tools/list': out({'jsonrpc':'2.0','id':m['id'],'result':{'tools':[]}})
    elif 'id' in m: out({'jsonrpc':'2.0','id':m['id'],'result':{}})
