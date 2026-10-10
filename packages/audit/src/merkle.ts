/**
 * Merkle tree over receipt hashes (docs/VERIFIABLE_RISK_ENGINE.md §9).
 *
 * Why a tree and not the chain head: the head proves "this history existed",
 * but verifying it means publishing the whole chain. A Merkle root lets us
 * anchor 32 bytes on HyperEVM and later disclose ONE receipt with an inclusion
 * proof — an auditor can confirm "receipt #42 is in the anchored set" without
 * seeing any other position.
 *
 * Domain separation (0x00 leaf / 0x01 node) prevents second-preimage games
 * where an internal node is presented as a leaf.
 *
 * Odd levels promote the last node unchanged instead of duplicating it —
 * duplication makes two different leaf sets produce the same root.
 */

import { createHash } from "node:crypto";

export interface MerkleProofStep {
  /** Sibling digest. */
  hash: string;
  /** "left" = sibling sits to the left of the running hash. */
  position: "left" | "right";
}

export interface MerkleProof {
  /** Index of the leaf in the ordered leaf list. */
  index: number;
  leaf: string;
  root: string;
  steps: MerkleProofStep[];
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

const LEAF_PREFIX = "00";
const NODE_PREFIX = "01";

export function leafHash(value: string): string {
  return sha256Hex(LEAF_PREFIX + value);
}

function nodeHash(left: string, right: string): string {
  return sha256Hex(NODE_PREFIX + left + right);
}

/** Root over an ordered list of raw leaf values (receipt hashes). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256Hex("empty");
  let level = leaves.map(leafHash);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : nodeHash(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/** Inclusion proof for one leaf; verifiable against the root without the other leaves. */
export function merkleProof(leaves: string[], index: number): MerkleProof {
  if (index < 0 || index >= leaves.length) {
    throw new Error(`merkleProof: index ${index} out of range (0..${leaves.length - 1})`);
  }
  const steps: MerkleProofStep[] = [];
  let level = leaves.map(leafHash);
  let idx = index;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (right === undefined) {
        next.push(left);
        continue;
      }
      // Record the sibling that the running hash will be combined with.
      if (i === idx) steps.push({ hash: right, position: "right" });
      else if (i + 1 === idx) steps.push({ hash: left, position: "left" });
      next.push(nodeHash(left, right));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return { index, leaf: leaves[index]!, root: level[0]!, steps };
}

export function verifyMerkleProof(proof: MerkleProof): boolean {
  let running = leafHash(proof.leaf);
  for (const step of proof.steps) {
    running = step.position === "left" ? nodeHash(step.hash, running) : nodeHash(running, step.hash);
  }
  return running === proof.root;
}
