import json,os,sys
for n in sys.argv[1:]:
    d=json.load(open(os.environ["PROBE159_DIR"]+f'/run/{n}/timeline.json')); print('#####',n)
    tl=d['tl']; base=next((e['t'] for e in tl if e['kind']=='mark'),d['t0'])
    for e in tl:
        r=round(e['t']-base,2)
        if e['kind']=='mark': print(f'{r:7} MARK  {e["m"]}')
        elif e['kind']=='screen': print(f'{r:7} SCR   {e["k"]} = {e["v"]}')
        else:
            x=e['rec']
            if x['type'] in('queue-operation','user') or (x['type']=='attachment' and x.get('att')=='queued_command'):
                print(f'{r:7} JSONL',json.dumps(x,ensure_ascii=False)[:300])
            elif x['type']=='assistant': print(f'{r:7} jsonl assistant {x.get("blocks")}')
            elif x['type'] in('system',): print(f'{r:7} jsonl system')
