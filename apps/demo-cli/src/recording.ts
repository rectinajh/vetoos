/**
 * Recording profile (docs/SUBMISSION.md §4): the four-act demo spends ~93
 * seconds of a 3-minute video simply WAITING out three post-deny cool-downs.
 *
 * This compresses the cool-down WINDOW. It does not touch the rule: an instant
 * retry after a denial is still refused by the engine, and the refusal still
 * lands in the receipt chain. What changes is only how long we sit there.
 *
 * It is not a hidden test mode: the profile is written next to the receipts and
 * its hash goes into every receipt, so a viewer can see exactly which rulebook
 * produced the run — and the shipped rulebook is untouched.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashPolicyBytes, type LoadedPolicy } from "@vetoos/risk";

export const RECORDING_COOLDOWN_SECONDS = 3;

export function applyRecordingProfile(
  policy: LoadedPolicy,
  stateDir: string,
  seconds = RECORDING_COOLDOWN_SECONDS,
): LoadedPolicy {
  const compressed = { ...policy.policy, cooldown_seconds_after_deny: seconds };
  const file = join(stateDir, "policy.recording.json");
  const bytes = JSON.stringify(compressed, null, 2) + "\n";
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, bytes, "utf8");
  console.log(
    "[recording] cool-down window compressed to " +
      seconds +
      "s (the shipped rulebook uses " +
      policy.policy.cooldown_seconds_after_deny +
      "s). The rule is unchanged — only the wait. This profile is written to the " +
      "state dir and its hash is recorded in every receipt.",
  );
  return { policy: compressed, contentHash: hashPolicyBytes(bytes), path: file };
}
