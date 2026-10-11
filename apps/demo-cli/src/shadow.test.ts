import { describe, expect, it } from "vitest";
import { loadShadowPolicy, scalePolicyToAccount } from "./shadow.js";

describe("shadow policy handling", () => {
  it("loads the shipped conservative template", () => {
    const policy = loadShadowPolicy();
    expect(policy.max_leverage).toBeGreaterThan(0);
    expect(policy.max_orders_per_minute).toBeGreaterThan(0);
  });

  it("scales the order cap and daily loss to the account", () => {
    const base = loadShadowPolicy();
    const { policy, scaled } = scalePolicyToAccount(base, 1_000_000);
    expect(scaled).toBe(true);
    // A fixed $1,000 cap applied to a $1M account refuses 100% of its orders
    // and tells the user nothing, so the cap follows the account size.
    expect(policy.max_order_notional_usd).toBeGreaterThanOrEqual(100_000);
    expect(policy.max_daily_loss_usd).toBeGreaterThanOrEqual(50_000);
    // Rules that are not size-dependent must not be touched.
    expect(policy.max_leverage).toBe(base.max_leverage);
    expect(policy.max_same_side_adds_per_hour).toBe(base.max_same_side_adds_per_hour);
    expect(policy.cooldown_seconds_after_deny).toBe(base.cooldown_seconds_after_deny);
  });

  it("leaves small accounts on the shipped template rather than shrinking it", () => {
    const base = loadShadowPolicy();
    const { policy } = scalePolicyToAccount(base, 100);
    expect(policy.max_order_notional_usd).toBe(base.max_order_notional_usd);
    expect(policy.max_daily_loss_usd).toBe(base.max_daily_loss_usd);
  });

  it("returns the base policy when the account value is unknown", () => {
    const base = loadShadowPolicy();
    expect(scalePolicyToAccount(base, 0)).toEqual({ policy: base, scaled: false });
  });
});
