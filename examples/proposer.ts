/**
 * A strategy in five lines: propose through the guarded exit, read the
 * bilingual verdict. Run with: pnpm tsx examples/proposer.ts
 * (Requires `pnpm brokerd` running.)
 */
import { createClient, makeIntent } from "@vetoos/client";

const vetoos = createClient("http://127.0.0.1:4399");
const res = await vetoos.submitIntent(
  makeIntent({ source: "example-strategy", market: "BTC", side: "buy", size: "0.0005", order_type: "market" }),
);
console.log(res.decision?.code, "-", res.decision?.message_zh);
