"""A tiny MCP server (stdio, JSON-RPC) for the tests: tools `add` and `secret`."""
import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue  # a notification
    method, mid = message["method"], message["id"]
    if method == "initialize":
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "test", "version": "0"}}
    elif method == "tools/list":
        result = {"tools": [
            {"name": "add", "description": "Add two numbers", "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]}},
            {"name": "secret", "description": "Not offered when filtered", "inputSchema": {"type": "object"}},
        ]}
    elif method == "tools/call":
        args = message["params"]["arguments"]
        if message["params"]["name"] == "add":
            result = {"content": [{"type": "text", "text": str(args["a"] + args["b"])}]}
        else:
            result = {"content": [{"type": "text", "text": "nope"}], "isError": True}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown"}}), flush=True)
        continue
    # A notification first, as real servers send them, to check it is skipped.
    print(json.dumps({"jsonrpc": "2.0", "method": "notifications/message", "params": {}}), flush=True)
    print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}), flush=True)
