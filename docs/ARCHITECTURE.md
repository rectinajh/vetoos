# VetoOS 技术架构

## 1. 目标与约束

- **目标：** 成为 **HIP-3 上 AI 新范式风控 OS**——策略/AI 的唯一可信下单出口（否决层 + 成交真相层 + 防 FOMO）。  
- **硬约束：** 规则大于模型；模型进程拿不到交易所签名密钥；默认开源、可审计。  
- **黑客松范围：** 必须接真实 HIP-3 数据与至少一笔真实环境下单（测试网优先，主网仅小额）；不要求自建 DEX 或生产级吞吐。

## 2. 逻辑架构

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Strategy A  │  │ Strategy B  │  │ AI Proposer │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │ Intent IR      │                │
       └────────────┬───┴────────────────┘
                    ▼
         ┌─────────────────────┐
         │   Intent Bus        │  排队 / 额度竞争（可选）
         └──────────┬──────────┘
                    ▼
         ┌─────────────────────┐
         │   Risk Broker       │  确定性规则引擎（唯一可签单组件）
         │  · Policy / limits  │
         │  · FOMO / cool-down │
         │  · book capacity    │
         └──────────┬──────────┘
              allow │ deny + reason
                    ▼
         ┌─────────────────────┐
         │ Hyperliquid Adapter │  agent wallet · API · (远期 CoreWriter)
         └──────────┬──────────┘
                    ▼
              Hyperliquid
                    │
                    ▼
         ┌─────────────────────┐
         │   Fill Truth        │  回报 vs 账户/仓位对账 → 不一致则 freeze
         └─────────────────────┘
```

**关键不变量：** 只有 Risk Broker 持有/调用签名能力；策略与 AI 为无密钥提案方。

## 3. 核心模块

| 模块 | 职责 | 备注 |
|------|------|------|
| `intent` | Intent IR schema、校验、序列化 | 版本化 JSON |
| `bus` | 接收意图、简单排队；可选多策略额度 | MVP 可同步调用 |
| `risk` | 规则评估：杠杆、日亏、频率、冷静期、名义上限、盘口深度 | 纯函数优先，配置哈希可公开 |
| `fomo` | 连续同向加仓检测、冷静期时钟 | 属 risk 子模块 |
| `adapter/hl` | 下单/撤单/查仓位；agent wallet | 官方 SDK |
| `truth` | 成交与仓位对账、冻结开关 | 错账 → kill switch |
| `audit` | 否决/放行/冻结日志（人话 + 结构化） | demo 与评委材料 |
| `ui` / `cli` | 最小面板或 CLI 演示 | 黑客松够用即可 |

## 4. Intent IR（草案）

```json
{
  "version": "0.1",
  "id": "uuid",
  "source": "strategy-a | ai-proposer",
  "ts": "ISO-8601",
  "market": "BTC",
  "side": "buy | sell",
  "size": "string-decimal",
  "order_type": "limit | market",
  "limit_px": "optional",
  "reduce_only": false,
  "meta": { "rationale": "optional free text from AI" }
}
```

AI 只许写 `meta` 与意图字段；**不得**携带覆盖 risk 配置的字段。

## 5. 规则引擎（确定性）

评估顺序建议：

1. 全局 freeze（对账失败后）  
2. Policy：允许品种 / 最大杠杆 / 最大名义  
3. 日亏熔断  
4. FOMO：冷静期、同向加仓次数/间隔  
5. 盘口容量（相对深度的 size 上限）  
6. 保证金粗检（读账户状态）  

输出：`{ decision: allow|deny, code, message_zh, snapshot }`。  
**禁止**调用 LLM 作为 allow/deny 的最终决定。

## 6. Fill Truth

1. 记录本地：意图 id → 交易所回报（oid、filled、avg px）  
2. 拉取账户/仓位快照  
3. 对比：方向、数量容差、时间窗  
4. 超差 → `freeze=true`，拒绝一切新意图，直到人工/显式解冻  

## 7. 与 Hyperliquid / 社区提案的关系

| 能力 | MVP | 远期 |
|------|-----|------|
| Info/Exchange API + agent wallet | ✅ | |
| Builder code 归因 | 可选 | 商业可持续 |
| HyperEVM CoreWriter | ❌ | 合约侧强制出口 |
| HIP-3 真实读写 | ✅ 枚举 DEX、真实 ctx、真下单 | 自建 DEX（非本届） |
| HIP-4 | 可选叙事 | 市场级 Policy |



## 7.1 真实 HIP-3 数据路径（必做）

```
perpDexs  →  选择 dex（index≥1，如 xyz）
metaAndAssetCtxs { dex }  →  真实 mark / funding / OI / universe
l2Book / 用户仓位 API  →  Risk Broker 输入
下单 asset = 100000 + dex_index * 10000 + meta_index
Fill Truth ← clearinghouse / 用户状态（真实）
```

- 币名格式：`{dex}:{coin}`（例：文档中的 `xyz:NVDA`）。
- Adapter 必须带 `dex` 维度，不能只接默认主簿。
- Demo 默认配置写死一个流动性足够的 HIP-3 市场；启动时若拉不到真实 meta 则拒绝启动（fail closed）。

## 8. 建议仓库结构

```
vetoos/
  README.md
  docs/
    PRD.md
    ARCHITECTURE.md
  packages/
    intent/
    risk/
    adapter-hl/
    truth/
    audit/
  apps/
    demo-cli/          # 黑客松演示入口
    demo-ui/           # 可选简易面板
  configs/
    policy.example.json
```

## 9. 技术选型（建议，可调）

- 语言：TypeScript 或 Python（跟官方 HL SDK 熟悉度选）  
- 配置：JSON/YAML policy，启动时计算 content hash 写入 audit  
- 日志：结构化 JSONL + 人话摘要  
- 测试：规则单测 + 故障注入（错账、拒单、FOMO 触发）

## 10. 安全注意

- 主密钥不进策略进程；演示用 agent wallet  
- Policy 变更需显式操作并记审计，AI 不可改  
- 异常默认 deny / freeze  

## 11. 演示路径（对接 PRD MVP）

1. 启动 Broker（加载 policy）  
2. 策略 A 合法意图 → allow → 测试网下单 → truth OK  
3. 策略 B 过大/过频 → deny（FOMO 或容量）  
4. 篡改本地账本 → truth freeze → 后续意图全拒

## 12. Grill 锁定默认

- dex: `xyz`
- market: `xyz:XYZ100`
- fail closed; FOMO 3/h + 30s cooldown; reconcile 0.5% or 1 lot
- secrets only in Risk Broker
