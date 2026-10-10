import { describe, expect, it } from "vitest";
import { leafHash, merkleProof, merkleRoot, verifyMerkleProof } from "./merkle.js";

const leaves = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)];

describe("merkle", () => {
  it("is deterministic and order-sensitive", () => {
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves]));
    expect(merkleRoot(leaves)).not.toBe(merkleRoot([...leaves].reverse()));
  });

  it("handles the empty and single-leaf cases", () => {
    expect(merkleRoot([])).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot([leaves[0]!])).toBe(leafHash(leaves[0]!));
  });

  it("proves inclusion for every index, including odd levels", () => {
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(leaves, i);
      expect(proof.root).toBe(merkleRoot(leaves));
      expect(verifyMerkleProof(proof)).toBe(true);
    }
  });

  it("rejects a tampered leaf and a tampered path", () => {
    const proof = merkleProof(leaves, 2);
    expect(verifyMerkleProof({ ...proof, leaf: "f".repeat(64) })).toBe(false);
    const badSteps = proof.steps.map((s, i) => (i === 0 ? { ...s, hash: "0".repeat(64) } : s));
    expect(verifyMerkleProof({ ...proof, steps: badSteps })).toBe(false);
  });

  it("refuses an out-of-range index instead of returning a wrong proof", () => {
    expect(() => merkleProof(leaves, 5)).toThrow(/out of range/);
    expect(() => merkleProof(leaves, -1)).toThrow(/out of range/);
  });

  it("domain-separates leaves from internal nodes", () => {
    // A two-leaf tree must not be confusable with a single leaf whose value is
    // the concatenation of the two (second-preimage defence).
    const root = merkleRoot([leaves[0]!, leaves[1]!]);
    expect(root).not.toBe(leafHash(leaves[0]! + leaves[1]!));
  });
});
