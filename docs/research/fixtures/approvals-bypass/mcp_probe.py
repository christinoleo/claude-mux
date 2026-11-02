#!/usr/bin/env python3
"""Minimal stdio MCP server for the approvals-bypass research (claude-mux #161).

Two tools: elicit_probe asks the client for a form through elicitation/create, and
confirm_probe is marked anthropic/requiresUserInteraction. Neither touches anything;
what the server received is appended to $PROBE/mcp.jsonl.
"""
import json, os, sys

P = os.environ["PROBE"]


def log(**kw):
    with open(P + "/mcp.jsonl", "a") as f:
        f.write(json.dumps(kw) + "\n")


def send(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


SCHEMA = {"type": "object", "properties": {}}
TOOLS = [
    {"name": "elicit_probe", "description": "Asks the user for a colour and returns it.", "inputSchema": SCHEMA},
    {"name": "confirm_probe", "description": "Returns the word confirmed.", "inputSchema": SCHEMA,
     "_meta": {"anthropic/requiresUserInteraction": True}},
]
pending = None
for line in sys.stdin:
    m = json.loads(line)
    log(recv=m)
    method, mid = m.get("method"), m.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": m["params"]["protocolVersion"],
              "capabilities": {"tools": {}}, "serverInfo": {"name": "probe", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call" and m["params"]["name"] == "elicit_probe":
        pending = mid
        send({"jsonrpc": "2.0", "id": "elicit-1", "method": "elicitation/create", "params": {
            "message": "Probe wants a colour", "requestedSchema": {
                "type": "object", "properties": {"color": {"type": "string", "title": "Colour"}}, "required": ["color"]}}})
    elif method == "tools/call":
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "confirmed"}]}})
    elif mid == "elicit-1":
        log(elicit_result=m.get("result"), elicit_error=m.get("error"))
        send({"jsonrpc": "2.0", "id": pending, "result": {"content": [{"type": "text", "text": "elicit result: " + json.dumps(m.get("result"))}]}})
    elif mid is not None and method:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
