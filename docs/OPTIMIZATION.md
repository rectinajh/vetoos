# VetoOS 拿奖优化清单 v2

> 依据：Colosseum Crypto World's Fair 评审六维（**product functionality · potential impact · novelty · UX · open-sourced · business plan**）+ 官方 workshop《Perfecting Your Hackathon Submission》的实操标准（pitch video 是评委看的第一件东西、技术 demo 视频讲"怎么做的"、要有用户验证与团队背景、超 3 分钟/堆 buzzword/漏团队介绍是高频扣分项）。
>
> 时间：现在是 **10/10 23:30 北京**。截止 **2026-10-13 06:59Z = 北京 10/13 14:59 = 10/12 23:59 PT**，还剩 **约 63 小时**。
> 结论先说：**项目的"里子"是够拿奖的**（真实主网 HIP-3 读 + 真实测试网成交 + 纯函数风控引擎 + 75 个测试全绿 + typecheck 干净）。**丢分几乎全在"外面一层"**：几处功能名不副实、演示会自己把自己限流打爆、以及提交材料还停在草稿态。

---

## 执行状态（10/11 更新）

| 项 | 状态 | 落点 |
|---|---|---|
| P0-1 并发同 id | ✅ | `broker.ts` in-flight 共享 + cloid（`intentIdToCloid`）；链上证据见 EVIDENCE §4 |
| P0-2 日亏熔断 | ✅ | `getRealizedPnlSince`（userFills closedPnl − fee，00:00Z 起，10s TTL） |
| P0-3 控制台自限流 | ✅ | `app.ts` 分级缓存 + 面板统一 2s 刷新、hidden 暂停 |
| P0-4 HIP-3 写路径 | ✅ | 测试网 `xyz:XYZ100`（asset 750000）真实成交 oid 62353082432，见 EVIDENCE §3 |
| P0-5 截止时间 | ✅ | SUBMISSION.md |
| P0-6 团队 | ⏳ **需本人提供**：姓名/背景/所在地/队长 | SUBMISSION.md §Team 为显式 TODO |
| P0-7 视频/截图 | ⏳ 用户自录 | — |
| P0-8 商业计划 | ✅ | SUBMISSION.md §3（分层定价 / TAM / 分发 / 90 天） |
| P1-9 签名前复查冻结 | ✅ | `processIntent` late freeze check |
| P1-10 写错误落账 | ✅ | audit `error` + processed 缓存烧掉 id |
| P1-11 周期对账 | ✅ | `reconcileTick` 60s：全会话对账 + openOrders 扫描 + PnL 刷新 |
| P1-12 多进程 | ✅ | `brokerd.lock` + CLI 经 HTTP 转发；demo/reset 运行中拒绝 |
| P1-13 XSS | ✅ | `esc()` 覆盖全部 innerHTML |
| P1-14 服务端测试 | ✅ | `app.test.ts` 15 例，总计 115 测试 |
| P1-15 价格精度 | ✅ | `roundPrice`（5 有效数字 ∧ 6−szDecimals 小数）+ `roundSize` 浮点修正 |
| P1-16 公开证据 | ✅ | `docs/EVIDENCE.md` |
| P1-17 英文材料 | ✅ | `docs/PRD.md` / `docs/ARCHITECTURE.md` 英文重写，中文移至 `docs/zh/` |
| P1-18 评委可跑 | ✅ | `pnpm demo:offline` / `pnpm brokerd:offline`（FixtureAdapter，临时目录） |
| P1-19 仓库门面 | ✅ | README 重写 + CI 徽章 + CONTRIBUTING + repo description/topics |
| P2-20–26 | ✅ | 写保护 token + 可选 GET 鉴权、body 限制/400、cap 按 max(主网 mark, 测试网 mark) 评估、reduce_only 按真实仓位校验、审计哈希链 + `/v1/audit/verify`、ai-risk 流动性 unknown、`LedgerStore.clear` 修复 |
| P2-27 HIP-4 | — | 仅作叙事守则：材料中不声称已支持 |

---

## 0. 评审维度记分板

| 维度 | 现状 | 拿奖还差什么 | 优先级 |
|---|---|---|---|
| Functionality | 引擎纯函数、fail-closed、订单路径真实；75 测试 + typecheck 全绿 | 3 个"名义功能实则失效"（并发双下单 / 日亏熔断 / 限流自爆）；服务端 0 测试 | **P0** |
| Impact | HIP-3 数量在涨、agent 交易缺刹车，命题成立 | 没有市场规模数字、没有真实用户对话 | P0/P1 |
| Novelty | "提案/否决分离 + fill-truth 对账"是真差异点 | HIP-3 **写**路径从未真正跑通，README 却写"Real HIP-3, not a mock" | **P0** |
| UX | 控制台有舞台感、双语否决理由 | 控制台存储型 XSS；429 会让演示卡住；评委无密钥跑不起来 | P0/P1 |
| Open-source | MIT、SDK、OpenAPI、policy 模板、示例 | PRD/ARCHITECTURE 全中文；client 包 private 且不能发布；无 CONTRIBUTING/good-first-issue | P1/P2 |
| Business plan | 有雏形（open core + builder code + 托管） | 全是定性描述，无定价/无 TAM/无分发指标，还有一行 TODO | **P0** |
| 表达（视频/材料） | 有很好的两套脚本 | **视频、demo 链接、截图、团队介绍、logo PNG 全部为零** | **P0** |
| Traction | 有真实成交与真实 freeze 的日志 | 证据在被 gitignore 的 logs/ 里，公开面看不到；网上搜不到 VetoOS | P1 |

---

## P0 — 不修就丢基本分（10/10 晚 ~ 10/11 白天做完）

### P0-1 并发同 id 双下单（功能真实性硬伤）
- **问题**：幂等检查在第一个 `await` 之前完成，两个同 id 请求同时到达会各自通过检查，最终下两次单。
- **证据**：检查在 [broker.ts:192-204](apps/demo-cli/src/broker.ts#L192-L204)，真正的网络 await 在 [:211](apps/demo-cli/src/broker.ts#L211)、[:258](apps/demo-cli/src/broker.ts#L258)，落记录在 [:310](apps/demo-cli/src/broker.ts#L310)；中间没有任何锁。已实测复现：两个并发同 id 请求 → 2 次 placeOrder、仓位翻倍、都没被标 duplicate。
- **怎么改**：在 Broker 里加 keyed in-flight Promise map（同 id 第二次直接 await 第一次的结果），并在下单时带上 venue `cloid = intent.id`（SDK 支持，见 adapter [index.ts:298-311](packages/adapter-hl/src/index.ts#L298-L311) 目前没带）。
- **耗时**：~1h ｜ **维度**：Functionality

### P0-2 日亏熔断线上永远打不着
- **问题**：`dailyRealizedPnlUsd` 全代码只被初始化和重置为 0，从来没有累加过已实现盈亏。控制台仪表和 AI 风险轴因此永远显示 $0，熔断规则形同虚设。
- **证据**：[broker.ts:80](apps/demo-cli/src/broker.ts#L80)、[:89](apps/demo-cli/src/broker.ts#L89) 只置 0；[:237](apps/demo-cli/src/broker.ts#L237) 喂给引擎；[engine.ts:227](packages/risk/src/engine.ts#L227) 读它。单测靠手工注入 [engine.test.ts:130](packages/risk/src/engine.test.ts#L130) 掩盖了这一点。
- **怎么改**：启动时从 venue `userFills` / ledger 汇总当日已实现盈亏，每次平仓成交后累加（平仓盈亏 = (平仓价 − 开仓均价) × 数量 × 方向）。这条修好，"真风控"才站得住。
- **耗时**：~2-3h ｜ **维度**：Functionality + Insight（**这是最能体现"真做风控"的一条**）

### P0-3 控制台把自己限流打爆（演示会卡）
- **问题**：页面每 2s 轮询 8 个端点，其中 `/v1/execution`、`/v1/counterfactual` 完全没缓存，单开一个标签页 ≈ 30 次重请求/分钟，撞 Hyperliquid 限重后 429 → withBackoff 耗尽 → 500。
- **证据**：[dashboard.ts:674](apps/brokerd/src/dashboard.ts#L674) 的 2s 轮询；无缓存的 [server.ts:218-226](apps/brokerd/src/server.ts#L218-L226) 与 [server.ts:252-325](apps/brokerd/src/server.ts#L252-L325)（counterfactual 还逐行调 getMarketContext）；对比已缓存的 [server.ts:77](apps/brokerd/src/server.ts#L77)（2.5s）与 [:138](apps/brokerd/src/server.ts#L138)（5s）。**我今天实测主网 `perpDexs` 已经直接返回 429** —— 这不是理论风险。
- **怎么改**：counterfactual / execution 加 ≥30s 缓存；合成一个后台刷新器统一拉取；页面 `document.hidden` 时暂停轮询。
- **耗时**：~1.5h ｜ **维度**：Functionality + UX（**录视频时卡一次就废一条 take**）

### P0-4 HIP-3 写路径从没跑通，但 README 写着 "Real HIP-3, not a mock"
- **问题**：读路径是真的（启动日志 market `xyz:XYZ100` / asset_id 110000 / 真实 mark·funding·OI），但**所有真实成交都落在测试网主板的 BTC**（ledger 里 0.0005 BTC @ ~82504，assetId=3）。`.env.example` 直接把 `VETOOS_TRADE_MARKET` 钉成 BTC，理由是"testnet 的 xyz 镜像被 deployer 门控"。HIP-3 track 的评委 100% 会问这一条。
- **证据**：[README.md:50-51](README.md#L50-L51)、[SUBMISSION.md:38](docs/SUBMISSION.md#L38)；成交记录 [ledger.jsonl](logs/ledger.jsonl)；启动日志 [audit-2026-10-10.jsonl](logs/audit-2026-10-10.jsonl)。**但我今天实测：测试网上 `xyz` dex 存在，`xyz:XYZ100` markPx=31000 且未 delisted（70 个资产、37 个有实时价），felix/volmex/stocks/nq 等 dex 也可用** —— 说明"deployer 门控"这个判断可能已经过期。
- **怎么改（30 分钟实验，收益最大）**：设 `VETOOS_TRADE_MARKET=xyz:XYZ100` 跑 `pnpm preflight`，然后下一笔 cap 之内的小单（例如 0.001 xyz:XYZ100 ≈ $31）。
  - **成功** → 立刻改成真·HIP-3 成交，把 "Real HIP-3, not a mock" 变成字面事实，**这是整份材料里性价比最高的一件事**。
  - **被拒** → 把 venue 返回的原始拒绝文案截图，作为"HIP-3 测试网交易闸门"的一手证据，README/视频里如实拆成两句："否决读主网真实 HIP-3 盘口；下单落在测试网，因为 xyz 的测试网交易由 deployer 门控（附原文）"。诚实 + 有证据，比含糊过去得分高。
- **耗时**：0.5h 实验 +（成功）2h 改叙事与素材 ｜ **维度**：Novelty + Functionality + 表达

### P0-5 提交材料：截止时间写错
- **问题**：[SUBMISSION.md:116](docs/SUBMISSION.md#L116) 写"10/13 15:59 北京"，正确的是 **10/13 14:59 北京（06:59Z / 10/12 23:59 PT）**，比它写的早一小时。写错真的会迟到。
- **怎么改**：全文统一成 `2026-10-13 06:59Z = 北京 14:59`，并且**10/12 白天就提交**，不要卡点。
- **耗时**：5min ｜ **维度**：合规（一票否决级）

### P0-6 团队 / founder-market fit 还是 TODO
- **问题**：[SUBMISSION.md:43](docs/SUBMISSION.md#L43) 与 [:105](docs/SUBMISSION.md#L105) 都是 TODO。官方 workshop 把"不提团队背景"列为最常见的扣分项之一，solo founder 更要主动解释"为什么是你"。
- **怎么改**：3-5 行：姓名 + GitHub/X 链接 + 与"交易/基础设施/风控"相关的经历（哪怕是非职业的：自己跑过 bot、被爆过仓、做过什么系统）。solo 就明说 solo，并给出"为什么我适合做这个"。
- **耗时**：1h ｜ **维度**：Founder-market fit

### P0-7 视频、demo 链接、截图：目前为零
- **问题**：仓库里没有任何 `.mp4/.png`（只有 [logo.svg](assets/logo.svg)），README/docs 里没有 YouTube/Loom 链接，[SUBMISSION.md:17-18](docs/SUBMISSION.md#L17-L18) 未勾选，logo 的 1024×1024 PNG 也没导出。评委首先看 pitch video，没有视频基本等于放弃表达分。另外 §4 的 demo 脚本正好排到 3:00，而硬上限是"≤3 分钟"，**必须压到 ~2:40**。
- **怎么改**：① 先录技术 demo（终端 + 控制台走完四幕，2:30）；② 再录 pitch（问题→产品→为什么是我们→愿景，2:30）；③ 传到 unlisted YouTube/Loom，链接放进 [README.md](README.md) 顶部和提交表单；④ 截 3 张控制台图（绿灯放行 / 否决理由 / freeze 全屏）提交到 `docs/img/`；⑤ 导出 logo PNG。
- **耗时**：4-6h（含重录） ｜ **维度**：表达（**官方明说权重最高**）

### P0-8 商业计划还是草稿
- **问题**：[SUBMISSION.md:77](docs/SUBMISSION.md#L77) 留着"TODO: 加 2-3 个真实用户对话"；§3 没有定价、没有市场规模、没有分发指标；builder-code 收入在 [.env.example](.env.example) 里自己写着"placeholder"。
- **怎么改**：① **定价**：按路由成交额收 bps（对齐 builder code 机制）+ 面向基金的托管订阅（策略模板/告警/合规导出）；② **TAM**：HIP-3 dex 数量与增速、Hyperliquid 上 agent/量化脚本的量级，用能查到的公开数字；③ **验证**：2-3 个具名（或"某交易小组，Discord 截图"）的对话/反馈；④ **90 天计划**：先做哪 10 个用户、怎么拿到前 100 个 star。
- **耗时**：2h ｜ **维度**：Business plan

---

## P1 — 拿分项（10/11 全天）

### P1-9 冻结是"快照"不是"闸门"
- 读 `frozen` 在 [broker.ts:224](apps/demo-cli/src/broker.ts#L224)，真正下单在 [:259](apps/demo-cli/src/broker.ts#L259)，中间隔了 3 个网络 await。对账触发 freeze（或演示里的 tamper 接口）时，已经在途的意图照样会被签名送出去。
- **改**：下单前后各再查一次 `frozen`（下单前查完再签，成本几乎为零）。~30min

### P1-10 写单异常不落账 → 重试可能重复下单
- `placeOrder` 抛错（超时/429/被拒）时不写 processed、不写 audit、不触发对账（[broker.ts:259-313](apps/demo-cli/src/broker.ts#L259-L313)），route 直接 500（[server.ts:504-507](apps/brokerd/src/server.ts#L504-L507)），客户端重试就会再下一次单。
- **改**：写单前先落 "in-flight/unknown"，出错后按 cloid/oid 回查对账，audit 记 `error` 事件。~1.5h

### P1-11 对账只覆盖"单笔"，挂单和场外变动是盲区
- 每笔单都重读 `positionBefore`（[broker.ts:258](apps/demo-cli/src/broker.ts#L258)、[:333](apps/demo-cli/src/broker.ts#L333)），所以挂单成交、强平、第二个进程的仓位变动会被悄悄当成新基准；`setBaseline` 只有 demo 调用（[demo.ts:138](apps/demo-cli/src/demo.ts#L138)）；挂单（resting）从不进 ledger、也不再回查。
- **改**：会话级 baseline + 定时对账循环 + 挂单登记与回查。这里正好用得上 track 资源里明确列出的 **WebSocket API（userFills/webData2，含断线重连与心跳）**，把"fill truth"做成真实时，比轮询更有说服力。~2-3h

### P1-12 多进程状态互相覆盖（演示时会让 CLI 解冻"不生效"）
- `loadState` 只在构造函数里读一次（[broker.ts:72](apps/demo-cli/src/broker.ts#L72)），`saveState` 整文件重写（[:95-97](apps/demo-cli/src/broker.ts#L95-L97)）。brokerd 跑着的时候用 CLI 执行 `unfreeze`，会被 brokerd 的旧内存状态覆盖回去。
- **改**：CLI 改成走 HTTP 命令 brokerd；或加文件锁 + 读-改-写合并。~1h

### P1-13 控制台存储型 XSS（和安全定位直接冲突）
- 构造 `<img src=x onerror=...>` 作为 body 的 key，会穿过校验错误信息（[intent/src/index.ts:110-117](packages/intent/src/index.ts#L110-L117)）→ 落日志（[broker.ts:181-185](apps/demo-cli/src/broker.ts#L181-L185)）→ 被 `innerHTML` 渲染（[dashboard.ts:449-450](apps/brokerd/src/dashboard.ts#L449-L450)）。已复现。
- **改**：feedLine/fills/bycode/alerts 所有插值统一转义（`textContent` 或 escape 函数）。~45min

### P1-14 服务端与适配器网络层零测试
- `apps/brokerd` 下没有任何 `*.test.ts`；adapter 的 `getMarketContext/placeOrder/getAccountState` 没测；broker 只有 2 个顺序执行的幂等测试（并发那个 bug 就是这么漏掉的）。
- **改**：补 route 级测试（鉴权 / 400 / 422 / 500 / unfreeze）与 fake-transport 适配器测试。~2-3h

### P1-15 补 tick/lot 取整的另一半（正好是 track 资源里的一条）
- 官方规则原文：价格**最多 5 位有效数字，且小数位不超过 `6 − szDecimals`（永续）**。当前 [helpers.ts:76-79](packages/adapter-hl/src/helpers.ts#L76-L79) 只做了有效数字，没做小数位上限 —— 对低价、高 szDecimals 的 HIP-3 市场会直接被 venue 拒单。另外 `limit_px` 是原样送单（[adapter index.ts:289-291](packages/adapter-hl/src/index.ts#L289-L291)），没走取整。
- **改**：`roundPx(px, szDecimals)` = 取 5 位有效数字后再截断到 `6 − szDecimals` 位小数；所有价格出口都过它。~45min

### P1-16 公开证据（评委看不到 = 不存在）
- 真实成交（oid 62333378675 / 62333596917 / 62333621581 / 62333624494，0.0005 BTC @ ~82504）和一次真实的"账本篡改 → 对账 freeze"，全部只在被 gitignore 的 `logs/` 里。
- **改**：新建 `docs/EVIDENCE.md`：oid、时间、市场、成交价、对账结果截图（**不含任何密钥**），README 顶部链接过去。~1h

### P1-17 英文材料 + ARCHITECTURE 与代码脱节
- [PRD.md](docs/PRD.md) 与 [ARCHITECTURE.md](docs/ARCHITECTURE.md) 全中文，而规则 §12(a)(i) 要求英文（[SUBMISSION.md:5](docs/SUBMISSION.md#L5) 自己引了这条）；ARCHITECTURE §8 的目录树还写着不存在的 `apps/demo-ui`，漏了 brokerd/proposer-ai/client，§3 列了根本不存在的 bus/fomo/ui 模块，§7.1 用 `xyz:NVDA` 而别处是 `xyz:XYZ100`；README 说"PRD M1–M5"而 PRD 定义的是 M1–M6。
- **改**：给评委看的（PRD/ARCHITECTURE）出英文或双语版；修掉树和图，M1–M6 对齐。~2h

### P1-18 评委跑不起来
- 没有任何 offline/fixture 模式；要跑起来需要密钥 + 一个在主网充值过才能领测试网水龙的账户。
- **改**：加 `pnpm demo --offline`（内置固定盘口 + 假成交，走同一套引擎），或提供一个只读托管控制台。**这条是"开源可组合"最容易拿分的地方**。~2h

### P1-19 仓库门面
- GitHub description/topics/website 还是默认（搜出来是 "Contribute to rectinajh/vetoos development..."），README 写"72 个测试"实际 75（[README.md:59](README.md#L59)），没有 CI badge、没有 CONTRIBUTING、没有 good first issue，没有 tag；`docs/OPTIMIZATION.md` 本身还没提交。
- **改**：一次补齐（description/topics: hyperliquid, hip-3, risk, ai-agent, cypherpunk + website + CI badge + 测试数改成 75 或干脆不写数字），把这篇文章也提交上去。~1h

---

## P2 — 有余力再碰（10/12 之后）

- **P2-20 对外暴露的鉴权**：鉴权只覆盖 POST，GET 全开；解冻口令是字面量 `I_AM_HUMAN`（[server.ts:27-28](apps/brokerd/src/server.ts#L27-L28)、[:442-449](apps/brokerd/src/server.ts#L442-L449)）；`VETOOS_HOST` 可绑 0.0.0.0。若用隧道暴露，至少强制 `VETOOS_PUBLIC_TOKEN` + 常量时间比较，并在 README 安全模型里写明（现在完全没提这个 write-guard）。
- **P2-21 请求健壮性**：无 body 大小上限；畸形 JSON 返回 500 而不是 400（[server.ts:59-65](apps/brokerd/src/server.ts#L59-L65)）。
- **P2-22 输入源混用**：名义/保证金用**主网** mark 算，成交在**测试网** mark±5%（[helpers.ts:89-97](packages/adapter-hl/src/helpers.ts#L89-L97)），cap 会有泄漏 —— 视频里被问到要能答上来。
- **P2-23 `reduce_only` 完全信任提案方**，且跳过杠杆/FOMO/保证金检查（[engine.ts:203](packages/risk/src/engine.ts#L203)、[:266](packages/risk/src/engine.ts#L266)、[:311](packages/risk/src/engine.ts#L311)），而仓位方向其实是已知的（[broker.ts:216-221](apps/demo-cli/src/broker.ts#L216-L221)）→ 用仓位符号自己判定，别信提案方。
- **P2-24 审计链**：JSONL 没有 hash 链/序号（[audit/src/index.ts:42-51](packages/audit/src/index.ts#L42-L51)）；`readFeed` 每次重解析整个文件，遇到半行会 500。既然主打"可审计"，`prev_hash` 链是很有说服力的小改动。
- **P2-25 ai-risk 失败时伪造 `liquidityUtilPct=50`**（[ai-risk.ts:348-355](apps/brokerd/src/ai-risk.ts#L348-L355)）—— 和"fail closed"人设冲突，改成 unknown/null。
- **P2-26** 无 metrics/结构化日志；无 Dockerfile/compose（CI 只有 typecheck+test）；`LedgerStore.clear()` 是坏的（归档但不截断，[ledger.ts:35-39](packages/truth/src/ledger.ts#L35-L39)）。
- **P2-27 HIP-4 叙事**：可以提"市场级策略"，但**不要**扩进 MVP，也别说已经支持。

---

## 明确不做（时间陷阱）

- ❌ 主网真实下单（资金风险 + 合规风险，收益远小于风险）
- ❌ 自己部署一个 HIP-3 dex（要 500k HYPE 质押）
- ❌ 多租户/托管化/数据库迁移/重写 UI —— 三天内做不完，且不加分
- ❌ 为了好看而堆新功能：**现在缺的不是更多代码，是"证明 + 表达"**

---

## 时间表（北京时间）

| 时间 | 做什么 |
|---|---|
| **10/10 今晚** | P0-1 并发锁 · P0-3 限流缓存 · P0-5 改截止时间 · P1-13 XSS 转义（都是小改动，先让演示稳） |
| **10/11 上午** | **P0-4 的 30 分钟 HIP-3 下单实验**（决定后面所有素材怎么写）· P0-2 日亏熔断 |
| **10/11 下午** | P1-9/10/11 冻结闸门与对账 · P1-15 价格取整 · P1-16 EVIDENCE.md |
| **10/11 晚** | P0-8 商业计划 · P0-6 团队介绍 · P1-19 仓库门面 · 全文案英文化 |
| **10/12 上午** | 录技术 demo（2:30）+ 截图 + logo PNG |
| **10/12 下午** | 录 pitch（2:30）→ 上传 → 提交表单（**提前 6 小时以上提交**） |
| **10/12 晚** | 缓冲：补 P1-14 测试 / P1-18 offline 模式 / 社区发帖留 traction 链接 |

> 一句话总结：**把三个"名不副实"改成名副其实（并发、熔断、HIP-3 成交），把演示的稳定性做够，然后用视频和证据把已经做出来的东西讲清楚。**
