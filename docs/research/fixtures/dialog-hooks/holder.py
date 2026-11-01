#!/usr/bin/env python3
"""A stand-in for the dashboard, never the real claude-mux server.

Usage: holder.py CASE_DIR silent|'<json reply>' [--file]
Socket mode: accepts hooks on CASE_DIR/holder.sock and sends the reply, if any.
File mode: waits for CASE_DIR/pending.json, then writes the reply to answer.json.
"""
import json, os, socket, sys, threading, time

P, reply = sys.argv[1], sys.argv[2]
silent = reply == "silent"


def log(msg):
    with open(P + "/holder.log", "a") as f:
        f.write(f"{time.time():.3f} pid={os.getpid()} {msg}\n")


log("start reply=" + reply)
if "--file" in sys.argv:
    while True:
        if os.path.exists(P + "/pending.json") and not silent:
            tmp = P + "/answer.tmp"
            open(tmp, "w").write(reply)
            os.rename(tmp, P + "/answer.json")
            log("answered via file")
            break
        time.sleep(0.1)
    sys.exit(0)

os.chdir(P)  # A relative path: the full one exceeds the 108-byte AF_UNIX limit.
path = "holder.sock"
if os.path.exists(path):
    os.unlink(path)
srv = socket.socket(socket.AF_UNIX)
srv.bind(path)
srv.listen(8)


def serve(c):
    data = b""
    while b"\n" not in data:
        chunk = c.recv(65536)
        if not chunk:
            return
        data += chunk
    log("hook registered " + data.decode().strip())
    if not silent:
        c.sendall((reply + "\n").encode())
        log("answered via socket")
    threading.Event().wait()


while True:
    conn, _ = srv.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
