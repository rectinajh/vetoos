# VetoOS

**HIP-3 上的 AI 新范式风控 OS**  
**把账对得上，把规矩立住，防住上头与 FOMO，才能走得更远。**

*Don't trust the agent. Verify the fill. · Verify the fill. Enforce the rules. Outlast FOMO.*

主战场：**Hyperliquid HIP-3（builder 永续）**。  
VetoOS 是跑在真实 HIP-3 市场之上的**开源风控操作系统**：AI / 策略只负责提案，唯一能下单的出口是写死的 Risk Broker；用真实盘口与仓位做否决与对账，挡住失控与 FOMO。

## 这是什么 / 不是什么

| 是 | 不是 |
|----|------|
| 插在策略/AI 与 Hyperliquid 之间的唯一出入口 | 又一个 AI 喊单 / Trading OS |
| 确定性规矩 + 成交真相层 | 只让 LLM 打个风险分 |
| 密码朋克：规则 > 模型、可审计、默认可开源 | 闭源「相信我们」的黑盒 agent |

## 文档

- [产品需求文档 (PRD)](docs/PRD.md)
- [技术架构](docs/ARCHITECTURE.md)

## 核心流程（人话）

1. **提案** — 策略或 AI 输出标准交易意图（Intent IR），不能直连交易所  
2. **安检** — 杠杆 / 日亏 / 盘口容量 / 频率 / 冷静期；不过则拒绝并说明原因  
3. **对账** — 回报与 Hyperliquid 真实状态核对；不一致则冻结继续下单  

## 真实 HIP-3

风控输入与演示下单均针对 **已上线的 HIP-3 市场**（官方 `perpDexs` / `metaAndAssetCtxs`），使用真实标记价、资金费与仓位数据；本届不自建质押部署新 DEX。

## 状态

黑客松筹备中（Colosseum Crypto World's Fair · Hyperliquid 赛道）。MVP 目标见 PRD。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
