import sys,os,time
sys.path.insert(0,os.path.dirname(__file__))
from lib158 import *
env=f'env {strip} -u TMUX PROBE={P} claude --setting-sources project --model haiku --permission-mode default --mcp-config $PROBE/mcp.json --dangerously-load-development-channels server:muxprobe'
t('new-session','-d','-s','p','-x','140','-y','50','-c',proj,env); time.sleep(4); t('send-keys','-t','p','Enter'); time.sleep(3); print(cap()[:1500]); t('kill-server')
