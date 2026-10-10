"""A strategy in eight lines of stdlib Python: propose through the guarded exit.

Requires `pnpm brokerd` running. Run with: python3 examples/proposer.py
"""
import json
import uuid
from datetime import datetime, timezone
from urllib.request import Request, urlopen

intent = {
    "version": "0.1",
    "id": str(uuid.uuid4()),
    "source": "python-strategy",
    "ts": datetime.now(timezone.utc).isoformat(),
    "market": "BTC",
    "side": "buy",
    "size": "0.0005",
    "order_type": "market",
}

req = Request(
    "http://127.0.0.1:4399/v1/intents",
    data=json.dumps(intent).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
try:
    res = json.load(urlopen(req))
except Exception as e:  # 422 = denied by rules — the broker still answers with reasons
    res = json.load(e.fp) if hasattr(e, "fp") else {"error": str(e)}

decision = res.get("decision", {})
print(decision.get("code"), "-", decision.get("message_zh"))
