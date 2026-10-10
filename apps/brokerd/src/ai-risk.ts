/**
 * AI risk score — PRESENTATION ONLY.
 *
 * The six radar axes are computed from the same deterministic counters the
 * rule engine uses. An LLM (when configured) only summarizes them into a
 * human-readable score and comment. It never feeds back into allow/deny —
 * the boundary is the product.
 */

export interface RiskAxis {
  key: string;
  label: string;
  value: number; // 0-100
  /** True when the underlying input could not be read — rendered as "unknown", never faked. */
  unknown?: boolean;
}

export interface AiRiskReport {
  axes: RiskAxis[];
  score: number;
  level: "low" | "moderate" | "high" | "critical";
  comment_en: string;
  comment_zh: string;
  source: "llm" | "heuristic";
  ts: string;
}

export interface AiRiskInputs {
  frozen: boolean;
  fomoUsed: number;
  fomoCap: number;
  rateUsed: number;
  rateCap: number;
  dailyLossUsed: number;
  dailyLossCap: number;
  marginPct: number; // 0-1
  cooldownRemainingS: number;
  deniesLastHour: number;
  /** 0-100 worst-side book utilization vs max order; null when the book could not be read. */
  liquidityUtilPct: number | null;
  equityUsd: number;
  tradeMarket: string;
}

const clamp = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

export function buildAxes(i: AiRiskInputs): RiskAxis[] {
  return [
    i.liquidityUtilPct === null
      ? // Fail-closed presentation: an unreadable book is reported as unknown
        // (drawn at full radius, flagged) rather than a comforting number.
        { key: "liquidity", label: "流动性 liquidity", value: 100, unknown: true }
      : { key: "liquidity", label: "流动性 liquidity", value: clamp(i.liquidityUtilPct) },
    { key: "leverage", label: "杠杆 margin", value: clamp(i.marginPct * 100) },
    { key: "behavior", label: "行为 FOMO", value: clamp(Math.max(i.fomoUsed / i.fomoCap, i.rateUsed / i.rateCap) * 100) },
    { key: "breaker", label: "熔断 daily-loss", value: clamp((i.dailyLossUsed / i.dailyLossCap) * 100) },
    {
      key: "discipline",
      label: "纪律 cooldown",
      value: clamp(i.cooldownRemainingS > 0 ? 70 : i.deniesLastHour * 12),
    },
    { key: "ledger", label: "账本 reconcile", value: i.frozen ? 100 : 0 },
  ];
}

export function heuristicReport(inputs: AiRiskInputs): AiRiskReport {
  const axes = buildAxes(inputs);
  const peak = Math.max(...axes.map((a) => a.value));
  const mean = axes.reduce((s, a) => s + a.value, 0) / axes.length;
  const score = clamp(peak * 0.65 + mean * 0.35);
  const level = score >= 85 ? "critical" : score >= 60 ? "high" : score >= 30 ? "moderate" : "low";
  const worst = axes.reduce((a, b) => (b.value > a.value ? b : a));
  const unknowns = axes.filter((a) => a.unknown).map((a) => a.key);
  return {
    axes,
    score,
    level,
    source: "heuristic",
    ts: new Date().toISOString(),
    comment_en:
      unknowns.length > 0
        ? `Input unavailable for: ${unknowns.join(", ")} — treated as maximum risk until readable.`
        : `Dominant risk: ${worst.key} at ${worst.value}/100. All gauges within deterministic limits.`,
    comment_zh:
      unknowns.length > 0
        ? `以下维度数据不可读：${unknowns.join("、")}，在可读之前按最高风险处理。`
        : `当前最高维度是「${worst.label.split(" ")[0]}」${worst.value}/100，其余均在确定性限额内。`,
  };
}

interface LlmVerdict {
  score?: number;
  level?: string;
  comment_en?: string;
  comment_zh?: string;
}

/** LLM summarizes the deterministic axes into a score. Advisory only. */
export async function llmReport(inputs: AiRiskInputs): Promise<AiRiskReport | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const axes = buildAxes(inputs);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a risk analyst for a deterministic trading risk-gate. Given six risk axis " +
              "values (0-100) from hard counters, output JSON: score (0-100), level " +
              "('low'|'moderate'|'high'|'critical'), comment_en (<=140 chars), comment_zh (<=80 chars). " +
              "Be sober and specific; mention the dominant axis. You are advisory only, never decide trades.",
          },
          {
            role: "user",
            content: JSON.stringify({
              axes,
              frozen: inputs.frozen,
              equity_usd: inputs.equityUsd,
              market: inputs.tradeMarket,
            }),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0]?.message.content ?? "{}") as LlmVerdict;
    if (typeof parsed.score !== "number") return null;
    const level = (["low", "moderate", "high", "critical"] as const).includes(
      parsed.level as "low" | "moderate" | "high" | "critical",
    )
      ? (parsed.level as AiRiskReport["level"])
      : parsed.score >= 85
        ? "critical"
        : parsed.score >= 60
          ? "high"
          : parsed.score >= 30
            ? "moderate"
            : "low";
    return {
      axes,
      score: clamp(parsed.score),
      level,
      comment_en: String(parsed.comment_en ?? "").slice(0, 300),
      comment_zh: String(parsed.comment_zh ?? "").slice(0, 160),
      source: "llm",
      ts: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
