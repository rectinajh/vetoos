// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// VetoOS P2 — anchors the Veto Receipt chain to HyperEVM.
//
// Deploy (HyperEVM testnet, chainId 998):
//   forge create contracts/VetoAnchor.sol:VetoAnchor \
//     --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $PRIVATE_KEY
//
// Deploy (HyperEVM mainnet, chainId 999):
//   forge create contracts/VetoAnchor.sol:VetoAnchor \
//     --rpc-url https://rpc.hyperliquid.xyz/evm --private-key $PRIVATE_KEY
//
// Anchor a root manually (apps/demo-cli/src/anchor.ts sends the same call):
//   cast send <contract> "anchor(bytes32,uint64)" <0x-root> <seq> \
//     --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $PRIVATE_KEY
//
// Read the current anchor back:
//   cast call <contract> "latestRoot()(bytes32)" --rpc-url https://rpc.hyperliquid-testnet.xyz/evm
//   cast call <contract> "latestSeq()(uint64)"  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm

/// @title VetoAnchor
/// @notice Publishes the newest Merkle root over an ordered list of Veto Receipt
/// hashes, so a later rewrite of the local audit log stops matching a block.
/// @dev The root commits to the ordered receipt hashes of the first `seq`
/// chained events; one receipt is later proven against it with a Merkle
/// inclusion proof (selective disclosure, no other position revealed).
/// The contract stores only the newest root and seq — history lives in the
/// Anchored events. Monotonic seq is what makes rollback detectable: an older
/// root can never be re-anchored, so a truncated file is caught by the verifier.
/// Permissionless on purpose: any holder of a root may anchor it, and the call
/// only ever moves forward. Anchoring proves "this history existed at this
/// block", not "this history is correct" — correctness is answered by replaying
/// each archived decision input (L2), which this contract cannot do.
contract VetoAnchor {
    /// @notice Emitted for every accepted anchor.
    /// @param root Merkle root over the first `seq` receipt hashes.
    /// @param seq Sequence number of the last receipt covered by `root`.
    /// @param prevRoot Root before this call (0x0 for the first anchor).
    event Anchored(bytes32 indexed root, uint64 seq, bytes32 prevRoot);

    /// @notice Newest anchored Merkle root.
    bytes32 public latestRoot;

    /// @notice Sequence number of the last receipt covered by `latestRoot`.
    uint64 public latestSeq;

    /// @notice Anchor a newer root. Reverts unless `seq` advances, which is the
    /// whole rollback protection: an older anchor can never be replaced or
    /// deleted, only a strictly longer history published.
    /// @param root Merkle root over the first `seq` receipt hashes.
    /// @param seq Sequence number of the last receipt covered by `root`.
    function anchor(bytes32 root, uint64 seq) external {
        require(seq > latestSeq, "seq must advance");
        emit Anchored(root, seq, latestRoot);
        latestRoot = root;
        latestSeq = seq;
    }
}
