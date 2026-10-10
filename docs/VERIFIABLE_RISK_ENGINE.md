# 可验证 AI 风控引擎 · 深化设计 v2

> **Don't trust the model. Verify the verdict.**
> 不去证明「AI 想得对」，而是证明「每一笔成交都过了当时公开的规矩，而且事后任何人都能复算、能定位到具体一条」。

---

## 0. 给评委的英文摘要（English summary）

> VetoOS is a **separation-of-powers** layer for AI trading on Hyperliquid HIP-3.
> The model proposes; a deterministic rule engine decides; the venue's own state
> is the only source of truth about fills.
>
> What we make **verifiable** is not the model's judgement but the *gate*:
>
> - **Reproducible** — a verdict is a pure function of a fully-specified input
>   tuple. Anyone can re-run it and must get the identical verdict, rule-by-rule trace included.
> - **Content-addressed rules** — the policy *and the engine version* are hashed into every verdict,
>   so "which rules were in force" is never a matter of opinion.
> - **Tamper-evident** — every verdict is a hash-chained *Veto Receipt*; editing, deleting,
>   reordering or replaying one is detected and located by sequence number.
> - **Non-retroactive** — receipt-chain Merkle roots are anchored on HyperEVM,
>   so history already published cannot be rewritten afterwards.
> - **AI-bounded** — the model's advice is *committed* (hashed) before the decision and
>   *revealed* after, so nobody can back-date good advice or bury bad advice.
>   Model output is data, never control.
> - **Human-bound** — releasing the brake requires a signature from an account that
>   **cannot** be the hot trading key, bound to the exact frozen state it releases.
>
> We are explicit about what this does **not** prove (see §3.3): it proves the rules were
> followed, not that the rules are wise; and it cannot out-run a fully compromised host
> whose anchors have not yet been published.

---

## 1. v1 → v2 深化了什么

v1（本文件上一版）已经有了正确的骨架：纯函数判决、收据、哈希链、签名、HyperEVM 锚定、`verify` 命令。
v2 补的是**让这套骨架真的站得住**的部分——每一条都是被追问时会崩的地方：

| # | v1 的说法 | v2 的深化 | 为什么必须补 |
|---|---|---|---|
| 1 | 「判决是纯函数，第三方可以复算」 | 定义**完整输入契约 `DecisionInput`**：intent + market + account + **history + now** + policy + **engine 版本**。当前 `RiskContext` 里 `history`/`now`/`frozen` 是隐藏状态，不归档就无法复算 | 不写全输入，「可复算」只是口号 |
| 2 | （未提） | **规则集内容寻址**：`rulesetHash` + `engineVersion` 进收据；改规则 = 换哈希 | 改了规则却拿旧哈希复算，会得出"篡改"的错误结论 |
| 3 | 收据 JSON 用 `JSON.stringify` | **规范化序列化（RFC 8785 风格）+ 金额用十进制字符串**，禁止浮点进入哈希 | 键顺序/浮点格式差异会让合法数据算出不同哈希——这是**当前代码里真实存在的问题**（§4.4） |
| 4 | 「收据串成哈希链」 | 加 **`hash_alg` 版本字段** + 旧链兼容策略 | 一改哈希算法，历史日志全部验不过 |
| 5 | 「状态」与「日志」是两份东西 | **状态是日志的投影**：`history`/`frozen` 由收据链纯函数投影得出，不另存真相 | 消除"隐藏状态"这一类 bug，也让复算只需日志 |
| 6 | AI「不参与判决」 | AI 建议 **commit-reveal**：决策前先承诺哈希，决策后揭示原文；AI 输出**永不作为控制输入**（防 prompt injection） | 否则"AI 不参与"只是承诺，不是结构 |
| 7 | 「人工解冻」 | **权力分离靠密钥分离**：热交易 key ≠ 解冻 key，启动时强制校验；解冻签名**绑定到被解冻的那一刻**（防重放） | 如果服务器持有解冻 key，"人类在环"就是名义上的 |
| 8 | 「定期锚定链头」 | 锚 **Merkle 根** + inclusion proof，可只披露单条收据；合约防回滚（`seq` 单调） | 链头只能证明"某段历史存在"，Merkle 才能**选择性披露** |
| 9 | 未提验证的验证 | **确定性测试 + 黄金向量 + 篡改矩阵 + CI 门禁**：让「可验证」本身可验证 | 没有测试的密码学承诺没有说服力 |
| 10 | 未提边界 | 明确**能证明什么 / 不能证明什么**（§3.3） | 过度承诺是被评委一击致命的地方 |

---

## 2. 威胁模型：我们到底在防谁

| 对手 | 动机 | 挡它的那一层 |
|---|---|---|
| **失控的 AI / 策略** | 越过仓位、杠杆、频率限制 | 确定性规则引擎是**唯一的签名出口**；AI 没有私钥 |
| **被 prompt 注入的 AI** | 伪造"已获批"的解释，诱导运营放行 / 篡改自己的建议记录 | AI 输出是**数据不是控制**，永不进入判决路径；建议先 commit 后 reveal（§6） |
| **运营者 / 开发者** | 事后改日志、删掉不利记录、改规则让某笔单"本来合规" | 哈希链（定位到 seq）+ 规则集哈希 + 签名 + **链上锚定**（发布后不可回改） |
| **被入侵的 Broker 进程** | 偷密钥、乱下单、自己解冻 | 最小权限（API/Agent Wallet 只能交易不能提币）+ **热 key ≠ 解冻 key** + 限额规则在引擎内不在调用方 + 熔断 |
| **交易所 / 网络** | 虚假成交、漏单、行情缺失 | Fill Truth 逐笔对账 + **fail-closed**（无行情即拒） |
| **重放 / 重复提交** | 同一意图下两次单 | 幂等 + 并发去重 + venue `cloid`（已实现）+ 解冻签名绑定状态（§7） |
| **回滚** | 用旧的 `broker-state.json` 覆盖当前状态，把已发生的亏损"删掉" | `seq` 单调 + 链上锚定的 `seq` 不可回退（§9.3） |

**信任边界（一句话版）**：模型是**不可信输入**；运营者是**需要被审计的主体**；venue 是**唯一真相源**（但见 §3.3 的预言机边界）；主机是**可能被攻破的**。

---

## 3. 四个可验证性质，四套机制

这是整个设计的骨架。四个性质互相独立，**各自只由一套机制提供**，不许混为一谈：

| 性质 | 回答的问题 | 机制 | 需要信任谁 |
|---|---|---|---|
| **完整性 Integrity** | 记录有没有被改过？ | 哈希链（`seq` + `prev_hash` + `hash`） | 不需要信任任何人（纯密码学） |
| **真实性 Authenticity** | 这条记录确实是我们发的？ | 收据签名密钥（与交易 key 分离）+ 域分离 | 信任 broker 收据公钥 |
| **可复算 Reproducibility** | 这个判决是不是按当时规则算出来的？ | 纯函数 + 完整输入归档 + 规则集内容寻址 | 不需要信任任何人（可重新执行） |
| **不可回改 Non-retroactivity** | 这段历史能不能被整段重写？ | Merkle 根锚定到 HyperEVM（`seq` 单调） | 信任 Hyperliquid 的共识 |

> 之所以要拆开，是因为它们**会被用不同的方式攻击**：改一行 → 完整性；冒充别人 → 真实性；
> 偷换规则或输入 → 可复算；整机被控后重写全部 → 只有锚定能挡住。
> 「不可回改」是唯一一个本地机制**根本做不到**的性质——这也是必须上链的原因。

### 3.3 明确不承诺的部分（写进 README，主动讲）

- **不证明规则本身是对的**。我们证明「规则被忠实执行」，不证明「规则写得好」。风控策略的优劣仍然是人的责任。
- **不解决预言机信任**。我们证明「*若*行情快照为真，*则*判决为真」。快照来源与哈希会归档（§5.4），但行情本身的真实性由 venue 保证。
- **不是零知识**。复算需要公开输入，因此**不隐私**。要同时满足"可验证 + 隐私"需要 ZK/TEE——那是路线图，不是现在（§13 明确列为"不做"）。
- **挡不住已被完全控制、且尚未锚定的主机**。锚定之后的历史改不了；锚定之前的尾部是弱点。验证器会明确报 `unanchored tail: N`。

---

## 4. 判决可复算：`DecisionInput` 契约（本版最重要的深化）

### 4.1 现在的洞

`evaluateIntent(intent, policy, ctx)`（[engine.ts](packages/risk/src/engine.ts)）看起来是纯函数，但 `ctx` 里有三样东西**不是**从 intent 或 policy 推出来的：

    RiskContext = { now, frozen, freezeReason?, market, account, history }

- `history` —— 决定冷却期、同向加仓次数、频率三条规则的结果；
- `now` —— 决定所有时间窗口；
- `frozen` —— 最高优先级规则。

只归档 intent + policy 的"复算"是**假的**：同样的 intent 在历史不同时会得出不同判决。所以第一件事是把输入定义完整：

    interface DecisionInput {
      schema: "vetoos.decision/1";
      intent: Intent;                 // 来自 @vetoos/intent
      policy: Policy;                 // 语义哈希
      policyBytesHash: string;        // 文件字节哈希（溯源用）
      market: MarketSnapshot;         // mark/funding/OI/depth/szDecimals
      account: AccountSnapshot;       // equity/availableMargin/dailyPnl/positionNotional
      history: HistoryEvent[];        // 窗口内的 intent/fill/deny
      frozen: boolean;
      freezeReason?: string;
      now: number;                    // 判决时刻（唯一的时间来源）
      engineVersion: string;          // 引擎语义版本，改了必须 bump
      rulesetHash: string;            // 见 §4.3
    }

    inputsHash  = sha256(canonical(DecisionInput))
    verdictHash = sha256(canonical({ decision, code, trace }))
    receipt     = { …, inputsHash, verdictHash, … }

### 4.2 为什么"状态是日志的投影"（原则）

`history` 和 `frozen` 不应该另存一份真相，而应该**由收据链纯函数投影得出**：

    history = projectHistory(receipts, windowMs, now)   // 从 VERDICT / FILL_RECONCILE 收据投影
    frozen  = last(KILL_SWITCH | FILL_RECONCILE{mismatch}) > last(UNFREEZE)

好处有三：

1. **没有隐藏状态**：复算只需要收据链 + 当次 intent + 一批行情快照，不需要读 `broker-state.json`。
2. 顺手消掉一整类 bug：状态文件与内存不一致（`pnpm broker unfreeze` 被 daemon 覆盖之类）在结构上不可能发生。
3. 讲给评委听也干净：**"我们的状态是日志的投影，不是另一份真相。"**

测试上要有一条硬断言：`assert(projectHistory(receipts, …) deepEqual ctx.history)` —— 投影与运行时输入必须逐字节一致。

### 4.3 规则集本身必须内容寻址

只哈希 policy 文件是不够的：**引擎代码也是一条规则**。把 `MAX_DECIMALS` 从 6 改成 8，判决可能不变；把一条 deny 规则删掉，判决必变。所以：

- `ENGINE_VERSION`：手写的语义版本（如 `risk/1.3.0`），**任何影响判决的改动必须 bump**；
- `rulesetHash`：在构建/测试期算出——对 `engine.ts` + `policy.ts` 的规范化源码（或它们的编译产物）取哈希，写进一个生成文件 `ruleset.generated.ts`；
- CI 断言：`engine.ts` 改了但 `rulesetHash` 没变 → **测试失败**。

这样"拿旧哈希复算"才有意义：规则没变，哈希不变；规则变了，哈希也变，验证器直接告诉你是"规则不同"而不是"记录被篡改"。

### 4.4 规范化序列化（canonical JSON）——当前代码的真实问题

[audit/src/index.ts:41-44](packages/audit/src/index.ts#L41-L44) 现在是：

    const canonical = JSON.stringify([ev.seq, ev.ts, ev.type, ev.policyHash, ev.data, ev.prev_hash]);

数组外层顺序固定，但 `ev.data` 是任意对象，**键的插入顺序会影响结果**。而且浮点序列化在不同引擎下不保证一致。

**实测（本轮跑过，不是推测）**：

    {market, size, verdict}  → b098f6dd94678c7f…
    {verdict, size, market}  → bea2065a2fae89b0…   ← 同样内容、不同键顺序，哈希完全不同
    JSON.parse(JSON.stringify(x)) 后重算 → 一致（V8 保留插入顺序）
    JSON.stringify(0.1+0.2) = 0.30000000000000004     JSON.stringify(-0) = 0（符号丢失）

**所以边界要说清楚（不要过度声称）**：

- **今天没坏**：V8 下存盘行 `JSON.parse → JSON.stringify` 会保留插入顺序，因此**校验已有日志的链是稳定的**，现有 `verifyChain` 工作正常。
- **会坏的地方有两处**：① 第三方用别的语言（Go/Python/Rust）重实现验证器时，键顺序与浮点格式不保证一致，**「可复算」就跨不过语言边界**；② 归档输入若被重新序列化（重组对象、过数据库、经 `Number()`），哈希会变，**复算会被误报成篡改**。
- 结论：规范化不是「补一个 bug」，而是**让可复算跨实现成立的前提**。

**深化规则（三条，任何一条破了，"可复算"就不成立）**：

1. **规范化 JSON**：键按 Unicode 码点排序、无多余空白、数字用 ECMAScript `Number::toString` 语义（等价 RFC 8785）。实现 `canonicalize(value): string`，所有哈希入口只走它。
2. **金额与价格用十进制字符串**：`"82504.5"` 而不是 `82504.5`。归档的是 venue 原始字符串，不是 `Number()` 之后的值——**哈希不能依赖浮点格式化**。
3. **哈希入口唯一**：`hashOf(x) = sha256(canonicalize(x))`，全仓库只此一个函数，禁止再出现裸 `JSON.stringify` 进哈希。

**兼容性**：已有日志的 `hash` 是按旧规则算的。改算法会验不过历史。做法是给每个事件加 `hash_alg`（旧记录视为 `sha256/v1`，新记录 `sha256/v2`），`verifyChain` 按每条记录自己的 `hash_alg` 分派——**旧链照验，新链更强**。

---

## 5. Veto Receipt（判决收据）规格

### 5.1 字段

    interface VetoReceipt {
      schema: "vetoos.receipt/1";
      seq: number;                 // 1-based，链内单调
      ts: string;                  // ISO8601
      type: ReceiptType;
      policyBytesHash: string;     // 规则文件字节哈希（复现"当时用的是哪个文件"）
      policySemanticHash: string;  // 规范化后的规则内容哈希（复现"当时的规则是什么"）
      engineVersion: string;
      rulesetHash: string;
      inputsHash: string;          // DecisionInput 的哈希（内容寻址，指向归档）
      verdictHash?: string;        // sha256(canonical({decision, code, trace}))
      aiAdviceHash?: string;       // 决策前承诺的 AI 建议哈希（§6）
      humanAuth?: { address: string; signature: string; boundTo: string };  // 人工授权（§7）
      orderIds?: number[];         // venue oid（ALLOW 后）
      data: Record<string, unknown>;  // 类型相关载荷
      prevHash: string;
      hashAlg: "sha256/v1" | "sha256/v2";
      hash: string;                // 见 §4.4
      sig?: string;                // broker 收据密钥签名（§5.3）
    }

### 5.2 收据类型

| 类型 | 何时产生 | 关键载荷 |
|---|---|---|
| `VERDICT` | 每次 allow/deny | verdict / code / trace / inputsHash |
| `ORDER_WRITE` | 下单前后（含未知态） | cloid / oid / status；写前落意图，写后落结果 |
| `FILL_RECONCILE` | 每次对账 | ledger vs venue 差异、容差、结论 ok/mismatch |
| `AI_COMMIT` / `AI_REVEAL` | 决策前 / 决策后 | adviceHash / (nonce, adviceText) |
| `POLICY_CHANGE` | 规则变更 | 旧/新 semantic hash + **人类签名** + 生效 seq |
| `KILL_SWITCH` / `UNFREEZE` | 冻结 / 解冻 | 原因、触发收据 seq、人类签名 |

现有的 `AuditEventType` 已经覆盖了大部分（`intent_received/decision/order_placed/reconcile/freeze/unfreeze`），v2 只是把它们从"日志事件"升级为"可复算的收据"，并补 `AI_COMMIT / AI_REVEAL / POLICY_CHANGE`。

### 5.3 签名与域分离

- 用**独立的收据密钥**（不等于交易 key，也不等于解冻 key）。三把钥匙三种权力：

      HL_PRIVATE_KEY            → 只能交易（agent wallet，不能提币）
      VETOOS_RECEIPT_KEY        → 只能签收据（不能交易，不能解冻）
      HL_ACCOUNT_ADDRESS 的 key → 只在你手里，只能解冻 / 改规则（永不进服务器）

- **域分离**：签名对象不是裸哈希，而是 `"vetoos.receipt/1|" + 域标 + hash`，避免同一把钥匙在别处被复用签名。
- 签名曲线：与现有 EIP-191 `verifyMessage`（[app.ts:521](apps/brokerd/src/app.ts#L521)）保持一致用 secp256k1，`viem` 已在依赖里，不新增依赖。

### 5.4 输入归档（内容寻址）

收据只放哈希，原文进 `logs/inputs/<inputsHash>.json`：

- 好处：链保持小、可只分发收据；归档天然去重（同一份行情被多张收据引用只存一次）。
- **隐私取舍要写清楚**（诚实换分）：归档原文 = 完全可复算但暴露仓位；`--redact` 模式只存哈希 → 复算降级为不可做（验证到 L2 为止）。**默认全量归档，因为这是一个"证明给你看"的产品。**

行情快照单独记来源，回答"你怎么证明这个 mark 不是你编的"：

    market.source = { endpoint, requestHash, responseBytesHash, fetchedAt, httpStatus }

---

## 6. AI 这一层：承诺—揭示，且永不作为控制输入

### 6.1 AI 能做的三件事 / 不能做的三件事

| 能做 | 不能做 |
|---|---|
| 生成 Intent IR（提案） | 签名、下单 |
| 用自然语言解释被拒原因 | 参与 ALLOW/DENY 判决 |
| 建议调参（产出**新** policy 供人审批） | 在运行中修改当前规则 |

### 6.2 commit-reveal：让"我早就提醒过"变成可验证事实

问题：如果 AI 的建议是先给出来、再由规则判决，事后运营方可以**只公布对的建议**，把错的删掉。

    t0  AI 产出建议 advice（含风险分与理由）与随机数 nonce
    t1  写 AI_COMMIT { adviceHash = sha256(nonce || canonical(advice)), modelId, promptHash }   ← 先承诺
    t2  规则引擎判决（不读 advice）
    t3  写 VERDICT { …, aiAdviceHash: adviceHash }                                              ← 绑定
    t4  写 AI_REVEAL { nonce, advice }                                                          ← 后揭示
    验证：sha256(nonce || canonical(advice)) == adviceHash，且时间顺序 t1 < t3 < t4

这就是密码学里的承诺方案用在运营透明度上：**建议在知道结果之前就被锁死**。事后无法编造，也无法否认。

### 6.3 prompt injection 是一等威胁

AI 的输入里有 intent 的文本字段（`source`、`rationale`），那是**攻击者可控的**。因此：

- **AI 输出永不进入判决路径**（结构上：`evaluateIntent` 的入参里没有 AI 字段；写一条测试断言 `DecisionInput` 不含任何 AI 来源字段）。
- AI 解释在 UI 里必须**转义渲染**（已修）并标注为"未验证的模型输出"。
- AI 无法通过"解释"影响 `POLICY_CHANGE`：改规则要**人类签名**，且 `POLICY_CHANGE` 收据里记 `old/new semantic hash` + 生效 `seq`。

### 6.4 AI 建议被采纳了怎么办？

采纳本身是人的签名动作，于是会留下 `POLICY_CHANGE` 收据：谁的签名、从哪个哈希到哪个哈希、从哪个 seq 生效。
于是"模型的影响力"也是**可追溯**的——这正是这套设计想解决的问题：不是禁止 AI 影响决策，而是让影响**留痕且不可事后否认**。

---

## 7. 人的这一层：权力分离靠密钥分离

### 7.1 现状与洞

[app.ts:510-544](apps/brokerd/src/app.ts#L510-L544)：解冻接受一个 EIP-191 签名，签名者必须等于 `HL_ACCOUNT_ADDRESS`；新鲜度检查是消息里的时间戳 120 秒内。

三个洞：

1. **没有强制交易 key ≠ 解冻 key**。[keygen.ts](apps/demo-cli/src/keygen.ts) 会生成 agent key，但 [doctor.ts](apps/demo-cli/src/doctor.ts) **没有校验**它和账户地址不同。如果用户图省事把 `HL_PRIVATE_KEY` 设成主账户私钥，那么**服务器自己就能签出解冻签名**——"人类在环"退化成一句承诺。
2. **签名没有绑定被解冻的对象**：消息只是 `"VetoOS human unfreeze\n" + 时间戳`。120 秒内可重放；而且一张为 A 次冻结签的授权，可以被用来解冻 B 次。
3. 没有一次性 nonce（重放窗口内可重复使用）。

### 7.2 深化方案

**启动强制校验（fail closed）**：`doctor` 与 `brokerd` 启动时断言

    addressOf(HL_PRIVATE_KEY) !== HL_ACCOUNT_ADDRESS          // 热 key 与人类 key 必须不同
    addressOf(VETOOS_RECEIPT_KEY) ∉ { 上面两个 }

不满足直接拒绝启动，并在 README 里写明这条**为什么**存在：*"机器可以交易，但只有人能把刹车松开——这不是流程规定，是密钥结构。"*

**签名绑定状态（防重放）**：解冻消息必须包含**被解冻的那个状态**：

    VetoOS human unfreeze
    action=UNFREEZE
    frozenAtSeq=<冻结收据的 seq>
    chainHead=<冻结时的链头哈希>
    nonce=<一次性随机数>
    expiresAt=<ISO8601>

验证方检查：签名者 = 人类账户、`expiresAt` 未过期、`nonce` 未被用过（本地已用集合）、`frozenAtSeq/chainHead` 与当前冻结状态一致。
然后 `UNFREEZE` 收据里写 `humanAuth = { address, signature, boundTo: frozenAtSeq }` —— **谁在什么时候解了哪一次冻，可被独立验证**。

---

## 8. 验证器：`vetoos verify`

### 8.1 四级验证（可独立运行、可单独失败）

| 级别 | 检查 | 输出 |
|---|---|---|
| **L0 语法** | JSON 可解析、schema 版本已知 | 解析错误数 |
| **L1 完整性** | 哈希链连续（`seq` 单调、`prev_hash` 衔接、`hash` 符合 `hash_alg`） | `brokenAt` + 原因 |
| **L2 真实性 + 可复算** | 收据签名有效；每条 `VERDICT` 用归档输入重跑引擎，`verdictHash` 必须一致 | 第一条复算不符的 seq |
| **L3 不可回改** | Merkle 根与链上锚定一致；锚定 `seq` 不回退；报未锚定尾部长度 | 锚定 tx 哈希 / 差异 |

    pnpm verify --receipts logs/audit-2026-10-10.jsonl --inputs logs/inputs --rpc <hyperevm>

人话输出（就是 demo 里要念的那句）：

    L1 chain        OK   412 receipts, head 9f3c…a1, unanchored tail 37
    L2 signatures   OK   412/412
    L2 replay       OK   168 verdicts recomputed, all match
    L3 anchor       OK   root 4b7e… anchored at seq 375 (tx 0xab…)
    RESULT: VERIFIED

### 8.2 篡改矩阵（每一种攻击都必须被抓到，且报告可区分）

| 攻击 | 应该报什么 |
|---|---|
| 改一张收据的 verdict | L1 `hash mismatch (line edited) @ seq N` |
| 删掉中间一条 | L1 `seq N+1 ≠ N` |
| 调换两条顺序 | L1 `prev_hash mismatch @ seq N` |
| 整段回滚到旧文件 | L3 `anchored seq 375 > local seq 340` |
| 换掉 input 归档 | L2 `inputsHash mismatch @ seq N`（内容寻址直接暴露） |
| 换掉 policy 文件但保留哈希 | L2 `policySemanticHash mismatch` |
| 只改引擎代码不改版本 | CI 失败（rulesetHash 变了）+ L2 `rulesetHash mismatch` |
| 重放旧解冻签名 | 拒绝：nonce 已用 / `boundTo` 与当前冻结状态不符 |

这张表本身就是**测试用例清单**：每一条都要有对应的单测。

---

## 9. 锚定：Merkle 根 → HyperEVM

### 9.1 为什么是 Merkle 而不是链头

链头只能证明"这段历史存在过"，且要验证就必须公开**整条链**。用收据哈希建 Merkle 树：

- **链上只放一个根**（32 字节 + seq），gas 极低；
- **选择性披露**：给审计方一个 inclusion proof，他能在不看到其他仓位的情况下证明"第 42 条收据存在且未被改"；
- 链是增量的，Merkle 根按批次重算即可（每 N 条或每天一次，或每次 freeze 立即锚一次）。

    pnpm verify:prove --seq 42      →  输出 Merkle path + root
    pnpm verify:anchor --root …     →  发一笔 HyperEVM 交易

### 9.2 合约草图（HyperEVM，chainId 998 testnet / 999 mainnet）

    contract VetoAnchor {
        event Anchored(bytes32 root, uint64 seq, bytes32 prevRoot);
        bytes32 public latestRoot;
        uint64  public latestSeq;
        function anchor(bytes32 root, uint64 seq) external {
            require(seq > latestSeq, "seq must advance");   // 防回滚
            emit Anchored(root, seq, latestRoot);
            latestRoot = root; latestSeq = seq;
        }
    }

- 权限：可以无权限（任何人有根都能锚，反而更中立），或限定运营方地址。**MVP 用无权限 + 只在测试网锚一次**，成本≈0。
- 这条正好落在 Hyperliquid track 的资源清单里（HyperEVM / CoreWriter），是**赛道原生**的加分点，而不是硬蹭。

### 9.3 它究竟证明了什么

- 证明：**某个 `seq` 之前的历史，在锚定交易被打包的那一刻就已经是这个样子**。之后再改，与链上根对不上。
- 不证明：内容合法、规则正确、行情真实。那些由 L2 复算回答。
- 所以 L2 与 L3 是**互补**的：L2 证明"算得对"，L3 证明"没被事后改写"。

---

## 10. 让"可验证"本身可验证（测试与 CI）

1. **确定性 property test**：随机生成 1000 组 `DecisionInput`，同一输入跑两次必须得到相同 `verdictHash`；并对输入做键顺序打乱，`inputsHash` 必须不变（这条直接测 §4.4 的规范化）。
2. **黄金向量 conformance suite**：把 N 组 `(DecisionInput, 期望 verdictHash)` 作为 `vectors/*.json` 提交进仓库；CI 每次重跑。
   - 对外价值：**第三方可以用任何语言实现自己的引擎，拿我们的向量对齐**——这才是"开源可组合"的硬证据。
   - 对内价值：任何无意改变判决的重构都会被 CI 拦下。
3. **篡改矩阵测试**：§8.2 每一行一条单测，断言报错信息与 `seq` 定位准确。
4. **投影一致性测试**：`projectHistory(receipts)` 与运行时 `ctx.history` 逐字节相等。
5. **CI 门禁**：`engine.ts` / `policy.ts` 变更必须伴随 `rulesetHash` 与黄金向量更新，否则失败。
6. **已有基础**：`pnpm test` 现在 6 文件 / 75 测试全绿，`pnpm typecheck` 干净，CI 已在跑——把上面这些挂进去即可，不需要新基建。

---

## 11. 落地计划（对着现有代码，按小时）

### 11.1 已经有的资产（不用重做）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| 哈希链 + `verifyChain` | [audit/src/index.ts](packages/audit/src/index.ts) | 直接升级为收据链（加 `hash_alg`） |
| 纯函数引擎 + `trace` | [risk/src/engine.ts](packages/risk/src/engine.ts) | 判决可复算的基础；`trace` 进 `verdictHash` |
| policy 内容哈希 | [risk/src/policy.ts](packages/risk/src/policy.ts) | 加"语义哈希"，双哈希并存 |
| Fill Truth 对账 | [truth/src/index.ts](packages/truth/src/index.ts) | 产出 `FILL_RECONCILE` 收据 |
| EIP-191 解冻 | [app.ts:510-544](apps/brokerd/src/app.ts#L510-L544) | 升级为"绑定状态 + nonce" |
| `/v1/audit/verify` | [app.ts:275](apps/brokerd/src/app.ts#L275) | 扩展为 L1–L3 的 HTTP 入口 |
| 幂等 + cloid 去重 | [broker.ts](apps/demo-cli/src/broker.ts) | 重放攻击已在订单层被挡 |

### 11.2 新增与改动（按性价比排序）

| 优先级 | 工作 | 位置 | 工时 |
|---|---|---|---|
| **P0** | `canonicalize()` + `hashOf()`，哈希入口统一；`hash_alg` 版本化 | 新 `packages/audit/src/canonical.ts` | 2h |
| **P0** | `DecisionInput` 归档（`logs/inputs/<hash>.json`）+ 行情来源记录 | `broker.ts` / `adapter-hl` | 2h |
| **P0** | `verdictHash` 与 6 类收据字段落地 | `audit` + `broker.ts` | 2h |
| **P0** | `pnpm verify`：L0–L2（链 + 签名 + 复算） | 新 `apps/demo-cli/src/verify.ts` | 3h |
| **P0** | 篡改矩阵 8 条测试 | `packages/audit/src/index.test.ts` 等 | 2h |
| **P1** | 密钥分离强制校验（doctor + brokerd 启动断言） | `doctor.ts` / `app.ts` | 1h |
| **P1** | 解冻签名绑定 `frozenAtSeq` + nonce 一次性 | `app.ts` + `dashboard.ts` | 2h |
| **P1** | `state = projection(receipts)`：`projectHistory` + `projectFrozen` + 一致性测试 | 新 `packages/audit/src/project.ts` | 3h |
| **P1** | AI commit-reveal + `DecisionInput` 不含 AI 字段的断言 | `proposer-ai` / `broker.ts` | 2h |
| **P1** | 黄金向量 + 确定性 property test + CI 门禁 | `vectors/` + CI | 2h |
| **P2** | Merkle 树 + inclusion proof | 新 `packages/audit/src/merkle.ts` | 2h |
| **P2** | HyperEVM 锚定合约 + 一次真实锚定 tx | 新 `contracts/VetoAnchor.sol` | 3h |
| **P2** | `rulesetHash` 生成 + CI 校验 | 构建脚本 | 1h |

**合计 ~27h**，其中 P0 = 11h。**只要 P0 做完，"可验证"就已经成立并且可演示**；P1 让它完整；P2 让它上链。

---

## 12. Demo 剧本（30 秒讲清"可信"）与评委问答

### 12.1 30 秒脚本

1. **（5s）** AI 连续追涨 `xyz:XYZ100`，第三笔被 FOMO 规则拒绝 → 屏幕出现收据 `seq 412`。
2. **（5s）** `pnpm verify`：L1 链 OK / L2 签名 OK / L2 复算 OK（"168 条判决全部复算一致"）。
3. **（10s）** 现场把 `seq 412` 的 verdict 从 `DENY` 改成 `ALLOW`，再跑一次 → `hash mismatch @ seq 412`；再把 `seq 300` 删掉 → `seq 301 ≠ 300`。**"改一个字、删一行，都会指向具体第几条。"**
4. **（10s）** 展示一笔真实成交的对账收据 + 链上锚定交易哈希 + 一个 inclusion proof：**"这一条收据能对着 HyperEVM 上的根被证明，而不用公开我的其他仓位。"**

### 12.2 三个必被问的问题

- **"这不就是个日志吗？"**
  → 日志的问题是可以改。这里三层分开：哈希链防**局部篡改**（指向 seq）、归档输入 + 纯函数支持**独立复算**、链上 Merkle 根防**整段重写**。而且我们的状态本身就是日志的投影，不存在"日志和真相两份"的问题。
- **"AI 在哪里？这不就是把 AI 排除掉了吗？"**
  → AI 负责提案、解释、调参三件事，被排除的只有**签名**这一件事。而且它的建议是 **commit-reveal** 的：决策前先承诺哈希，事后无法编造或删除。我们让 AI 的影响**留痕且不可否认**，而不是让它不可审计地影响结果。
- **"规则写错了怎么办？"**
  → 这套机制**不**保证规则正确，只保证规则被忠实执行、且改动留痕（`POLICY_CHANGE` 收据 + 人类签名 + 新旧哈希）。规则的好坏需要人来负责——我们把这部分诚实地留给人类，而不是假装算法能解决。

### 12.3 与评审维度的对应

| 评审维度 | 这个设计提供什么 |
|---|---|
| Functionality | 判决可复算、`verify` 四级校验、8 条篡改矩阵测试 |
| Novelty | 把"承诺方案 + 内容寻址 + 事件溯源 + 链上锚定"组合到一个 AI 交易风控闸门上 |
| Impact | 任何跑 agent 的团队都能用同一套收据格式自证清白（可组合的信任层） |
| UX | 控制台一键 `verify` 徽章；拒绝理由 + 收据一并可导出 |
| Open-source | 黄金向量让第三方**用自己的语言**实现并自证一致 |
| Business plan | 面向基金的"可审计托管"（合规导出、选择性披露）就是付费点 |

---

## 13. 不做（写进路线图，别在三天内碰）

零知识证明 / TEE 机密计算 / 多方门限签名 / 去中心化预言机 / 完整 SPV 客户端 / 跨链验证。
理由一致：**先把"能复算 + 能定位 + 能锚定"做扎实**，这三件事已经足以支撑一个可信的产品叙事；再往上加，是融资之后的事。
---

## 14. 实现状态（截至提交前）

本设计已经落到代码里，不是纸面方案。`pnpm test` 全绿（182 个测试），`pnpm typecheck` 干净。

| 设计项 | 状态 | 代码位置 | 验证方式 |
|---|---|---|---|
| 规范化序列化 + 唯一哈希入口 | 已实现 | `packages/audit/src/canonical.ts` | `canonical.test.ts`（键序不变性、非有限数拒绝、-0 归一） |
| `hash_alg` 版本化（旧链照验） | 已实现 | `packages/audit/src/index.ts` | `tamper.test.ts`（v1/v2 混链） |
| `DecisionInput` 归档（内容寻址） | 已实现 | `packages/risk/src/verdict.ts` + broker | `verify.test.ts` |
| `verdictHash` 与收据字段 | 已实现 | `packages/audit/src/index.ts` + broker | 收据链端到端复算 |
| 规则集内容寻址 + CI 门禁 | 已实现 | `packages/risk/src/ruleset.ts` | `ruleset.test.ts`（改了规则不 stamp 即失败） |
| `pnpm verify` L0–L3 | 已实现 | `apps/demo-cli/src/verify.ts` | 离线演示 21 张收据 8/8 复算通过 |
| 篡改矩阵 8 条 | 已实现 | `packages/audit/src/tamper.test.ts` | 改/删/换序/伪造/截断全部定位到 seq |
| 内容寻址防换档 | 已实现 | `verify.ts` | 换掉归档 → `inputsHash mismatch @ seq 17` |
| 状态 = 日志投影 | 已实现 | `packages/audit/src/project.ts` | `projection.test.ts` 与运行时逐字段相等 |
| 密钥分离强制校验 | 已实现 | `apps/demo-cli/src/keys.ts` + doctor + brokerd 启动 | 热 key = 操作账户时拒绝启动 |
| 解冻绑定冻结状态 + 一次性 nonce | 已实现 | `app.ts` `/v1/freeze-binding` + broker | `projection.test.ts`（错绑定拒绝、重放拒绝） |
| AI commit-reveal | 已实现 | broker + `/v1/ai/commit` / `/v1/ai/reveal` | 揭示必须命中被判决绑定的承诺 |
| 控制路径无 AI 字段 | 已实现 | `assertNoAiControlFields` | 结构化断言（构建时即抛错） |
| ed25519 收据签名 | 已实现 | `packages/audit/src/receiptkey.ts` | `receiptkey.test.ts` + L2 签名校验/冒充拒绝 |
| 黄金向量一致性套件 | 已实现 | `packages/risk/vectors/decisions.json` | `vectors.test.ts`（12 组，覆盖全部 deny code） |
| Merkle 树 + inclusion proof | 已实现 | `packages/audit/src/merkle.ts` | `merkle.test.ts` + `pnpm verify --prove N` |
| HyperEVM 锚定 | 合约与脚本已就绪 | `contracts/VetoAnchor.sol` + `apps/demo-cli/src/anchor.ts` | `pnpm verify` 的 L3 会校验锚定根与回滚 |

**还没做的**（诚实清单）：链上锚定需要一次带 gas 的真实交易才算闭环；`--redact` 归档模式尚未实现；
规则集哈希覆盖 `engine.ts` + `policy.ts` 两个文件，尚未扩展到整个决策路径。
