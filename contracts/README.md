# VetoAnchor — receipt-chain anchoring (P2)

VetoOS receipts are hash-chained locally (`packages/audit`). That proves little
to a third party on its own: whoever controls the machine can rewrite the file
and recompute every hash. This contract puts one 32-byte commitment per anchor
batch on HyperEVM, so a rewrite after the fact stops matching a block.

## What gets anchored

A Merkle root over an ordered slice of Veto Receipt hashes — the hashes of the
first `receiptCount` chained events in a receipts file, as produced by
`packages/audit/src/merkle.ts`. The journal line that records it also stores
`seq`, the sequence number of the last receipt the root covers, and the
`txHash` / `chainId` / `contract` when the root was actually published.

## Why a Merkle root and not the chain head

The chain head proves "this history existed" too, but verifying it means
publishing the whole chain. A Merkle root is 32 bytes, costs almost no gas,
and supports selective disclosure: an auditor receives an inclusion proof for
one receipt (`vetoos verify --prove N`) and can confirm "receipt 42 is in the
anchored set" without seeing any other position, size or PnL.

## What an anchor proves, and what it does not

Proves: the history up to `seq` already existed in exactly this form when the
anchor transaction was included in a block. Rollback is detectable because the
contract only ever moves forward — `require(seq > latestSeq, "seq must advance")`.

Does not prove: that the contents are lawful, that the rules were correct, or
that market data was real. Those are answered by the L2 replay check, which
recomputes every verdict from its archived decision input. L2 proves "computed
correctly", L3 proves "not rewritten afterwards"; they are complementary, and
an anchor says nothing about the unanchored tail after its `seq`.

Anchoring is permissionless by design: any holder of a root may anchor it, and
the call can only move the contract forward. There is no owner, no pause and no
upgrade path.

## How to deploy

The MVP anchors on HyperEVM testnet (chainId 998). Mainnet (chainId 999) uses
the same bytecode and the same commands with the mainnet RPC.

    # testnet (998)
    forge create contracts/VetoAnchor.sol:VetoAnchor \
      --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
      --private-key $PRIVATE_KEY

    # mainnet (999)
    forge create contracts/VetoAnchor.sol:VetoAnchor \
      --rpc-url https://rpc.hyperliquid.xyz/evm \
      --private-key $PRIVATE_KEY

## How to anchor a root

The writer is `apps/demo-cli/src/anchor.ts`. With all three of `--rpc`,
`--key` and `--contract` it sends the transaction and stores the tx hash in the
journal; with fewer than three it records a local dry-run line and sends nothing.

    # local record only (no key, no network)
    pnpm tsx apps/demo-cli/src/anchor.ts --receipts logs/audit-2026-10-10.jsonl

    # testnet anchor
    pnpm tsx apps/demo-cli/src/anchor.ts \
      --receipts logs/audit-2026-10-10.jsonl \
      --rpc https://rpc.hyperliquid-testnet.xyz/evm \
      --key 0x... --contract 0x...

    # the same call with cast, for a manual anchor
    cast send <contract> "anchor(bytes32,uint64)" <0x-root> <seq> \
      --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $PRIVATE_KEY

    # read the current anchor back
    cast call <contract> "latestRoot()(bytes32)" --rpc-url https://rpc.hyperliquid-testnet.xyz/evm
    cast call <contract> "latestSeq()(uint64)"  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm

Then check it locally:

    pnpm tsx apps/demo-cli/src/index.ts verify --receipts <file>

`verify` runs the L3 check, recomputes the root over the first `receiptCount`
receipt hashes and reports the unanchored tail. A root that does not match, or
an anchor `seq` that does not strictly increase, fails L3.

