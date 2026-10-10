/**
 * vetoos anchor — publish a receipt Merkle root, or record it locally
 * (docs/VERIFIABLE_RISK_ENGINE.md §9).
 *
 * L1 proves the local hash chain is internally consistent and L2 proves every
 * verdict recomputes, but both run on the machine that holds the log. An
 * attacker who owns that machine can rewrite the file and every local check
 * still passes. The anchor is the one link the host cannot forge: the root is
 * in a block, so a later rewrite of the receipts below it stops matching.
 *
 * The journal is append-only JSONL and the writer is idempotent, so re-running
 * after a crash never produces a second record for the same {seq, root}: the L3
 * reader requires anchor seq to strictly increase and would otherwise report
 * the duplicate as a rollback.
 *
 *   pnpm tsx apps/demo-cli/src/anchor.ts --receipts logs/audit-2026-10-10.jsonl
 *   pnpm tsx apps/demo-cli/src/anchor.ts --receipts <file> \
 *     --rpc https://rpc.hyperliquid-testnet.xyz/evm --key 0x… --contract 0x…
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { merkleRoot, readAuditFile } from "@vetoos/audit";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.js";

/** Minimal ABI for the single call this writer makes; the contract is dependency-free. */
const VETO_ANCHOR_ABI = [
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "seq", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

export interface AnchorOptions {
  /** Receipts file. Defaults to today under VETOOS_STATE_DIR (or logs/). */
  receipts?: string;
  /** Local anchor journal. Defaults to <receipts dir>/anchors.jsonl. */
  anchors?: string;
  /** Anchor only the first n receipts. Defaults to every chained receipt. */
  limit?: number;
  /** HyperEVM RPC URL. Required together with key and contract to go on-chain. */
  rpc?: string;
  /** 0x-prefixed 32-byte private key that pays for the anchor transaction. */
  key?: string;
  /** Deployed VetoAnchor address. */
  contract?: string;
}

/** One journal line; field-compatible with the reader in verifyAnchors(). */
export interface AnchorRecord {
  seq: number;
  root: string;
  receiptCount: number;
  ts: string;
  txHash?: string;
  chainId?: number;
  contract?: string;
}

export interface AnchorRun {
  receiptsFile: string;
  anchorsFile: string;
  root: string;
  receiptCount: number;
  seq: number;
  /** True when an identical {seq, root} record was already in the journal. */
  alreadyAnchored: boolean;
  /** True when this record carries a transaction hash. */
  onChain: boolean;
  record: AnchorRecord;
}

interface OnChainAnchor {
  txHash: string;
  chainId: number;
  contract: string;
}

function todayFile(dir: string): string {
  return join(dir, "audit-" + new Date().toISOString().slice(0, 10) + ".jsonl");
}

/** Journal lines we can still read; a half-written trailing line is skipped. */
function readAnchorJournal(path: string): AnchorRecord[] {
  if (!existsSync(path)) return [];
  const out: AnchorRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AnchorRecord);
    } catch {
      // A crash mid-append can leave a partial line. The duplicate check only
      // needs complete records, and the verify reader tolerates the same.
    }
  }
  return out;
}

/**
 * Send the anchor transaction. Returns null when any of rpc/key/contract is
 * missing — that is the dry-run path, not an error.
 */
async function anchorOnChain(
  opts: AnchorOptions,
  root: string,
  seq: number,
): Promise<OnChainAnchor | null> {
  const { rpc, key, contract } = opts;
  if (!rpc || !key || !contract) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("--key must be a 0x-prefixed 32-byte private key");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    throw new Error("--contract must be a 0x-prefixed 20-byte address");
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  // publicActions adds getChainId/waitForTransactionReceipt to the wallet
  // client, so one client covers the whole write path. No chain is configured:
  // the RPC is the source of truth for its own chain id.
  const client = createWalletClient({ account, transport: http(rpc) }).extend(publicActions);
  const chainId = await client.getChainId();
  const txHash = await client.writeContract({
    address: contract as `0x${string}`,
    abi: VETO_ANCHOR_ABI,
    functionName: "anchor",
    // Explicit null: the client holds no chain object, the RPC supplies chainId.
    chain: null,
    args: [("0x" + root) as `0x${string}`, BigInt(seq)],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(
      "anchor transaction reverted: " + txHash + " (chainId " + chainId + ", contract " + contract + ")" +
        " — the contract only accepts a strictly advancing seq, so seq " + seq + " may already be anchored",
    );
  }
  return { txHash, chainId, contract: contract.toLowerCase() };
}

/**
 * Compute the root over the requested slice, anchor it when the on-chain config
 * is complete, and append exactly one journal line. Re-running with the same
 * file and limit is a no-op.
 */
export async function runAnchor(opts: AnchorOptions = {}): Promise<AnchorRun> {
  const config = loadConfig();
  const receiptsFile = opts.receipts ?? todayFile(config.stateDir);
  const anchorsFile = opts.anchors ?? join(dirname(receiptsFile), "anchors.jsonl");

  if (!existsSync(receiptsFile)) {
    throw new Error("receipts file not found: " + receiptsFile + " (pass --receipts <file>)");
  }
  const events = readAuditFile(receiptsFile);
  const chained = events.filter((e) => typeof e.hash === "string");
  if (chained.length === 0) {
    throw new Error("no chained receipts in " + receiptsFile + " — nothing to anchor");
  }

  const limit = opts.limit ?? chained.length;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer, got " + String(opts.limit));
  }
  const slice = chained.slice(0, limit);
  const root = merkleRoot(slice.map((e) => e.hash));
  const receiptCount = slice.length;
  const seq = slice[slice.length - 1]!.seq;

  const existing = readAnchorJournal(anchorsFile);
  const replay = existing.find((a) => a.seq === seq && a.root === root);
  if (replay) {
    return {
      receiptsFile,
      anchorsFile,
      root,
      receiptCount,
      seq,
      alreadyAnchored: true,
      onChain: typeof replay.txHash === "string",
      record: replay,
    };
  }

  // The transaction goes first: a record without a tx hash has to stay
  // distinguishable from an on-chain anchor, and two lines with the same seq
  // would make the L3 reader report a rollback.
  const tx = await anchorOnChain(opts, root, seq);
  const record: AnchorRecord = {
    seq,
    root,
    receiptCount,
    ts: new Date().toISOString(),
    ...(tx ? { txHash: tx.txHash, chainId: tx.chainId, contract: tx.contract } : {}),
  };
  mkdirSync(dirname(anchorsFile), { recursive: true });
  appendFileSync(anchorsFile, JSON.stringify(record) + "\n");
  return {
    receiptsFile,
    anchorsFile,
    root,
    receiptCount,
    seq,
    alreadyAnchored: false,
    onChain: tx !== null,
    record,
  };
}

export async function anchorCommand(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const limitRaw = arg("--limit");
  if (limitRaw !== undefined && !/^[0-9]+$/.test(limitRaw)) {
    process.stderr.write("[anchor] --limit must be a positive integer, got " + limitRaw + "\n");
    return 1;
  }
  const opts: AnchorOptions = {
    ...(arg("--receipts") ? { receipts: arg("--receipts")! } : {}),
    ...(arg("--anchors") ? { anchors: arg("--anchors")! } : {}),
    ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
    ...(arg("--rpc") ? { rpc: arg("--rpc")! } : {}),
    ...(arg("--key") ? { key: arg("--key")! } : {}),
    ...(arg("--contract") ? { contract: arg("--contract")! } : {}),
  };
  const onChainFlags = [opts.rpc, opts.key, opts.contract].filter((v) => v !== undefined).length;
  if (onChainFlags > 0 && onChainFlags < 3) {
    process.stdout.write(
      "[anchor] note — on-chain anchoring needs --rpc, --key and --contract together; recording a local dry run\n",
    );
  }

  let run: AnchorRun;
  try {
    run = await runAnchor(opts);
  } catch (err) {
    process.stderr.write("[anchor] " + (err instanceof Error ? err.message : String(err)) + "\n");
    return 1;
  }

  process.stdout.write(
    "[anchor] " + run.receiptCount + " receipts, merkle root " + run.root + " (last seq " + run.seq + ")\n",
  );

  if (run.alreadyAnchored) {
    process.stdout.write(
      "[anchor] already anchored: seq " + run.seq + " root " + run.root +
        (typeof run.record.txHash === "string" ? " tx " + run.record.txHash : " (local record)") +
        "; nothing appended to " + run.anchorsFile + "\n",
    );
    return 0;
  }

  if (run.onChain) {
    process.stdout.write(
      "[anchor] anchored on chainId " + run.record.chainId + ": tx " + run.record.txHash +
        " (contract " + run.record.contract + ")\n",
    );
  } else {
    process.stdout.write("[anchor] dry run — no RPC/key/contract given; wrote local anchor record\n");
  }
  process.stdout.write("[anchor] appended " + run.anchorsFile + "\n");
  return 0;
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  anchorCommand(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error("[fatal] " + (err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    });
}
