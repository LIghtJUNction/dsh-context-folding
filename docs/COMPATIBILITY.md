# 接口核实与交付边界

## 版本基线

- 实际构建/集成依赖：npm 发布版 `@deepseek-ai/dsh-* 0.2.1-rc.2`，详见 `package-lock.json` 中的精确版本、公开 tarball 地址与 integrity。
- 公开源码参考：[deepseek-harness 固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)。该提交 package 为 `0.2.1-rc.3`，仅用于原理和结构核对。
- 理念参考：[magpie-context-folding 固定提交](https://github.com/LIghtJUNction/magpie-context-folding/tree/d607698cba8b7c4ebfe5d2dacf5f881fefbce748)。本实现独立适配 DSH，没有声称 Magpie 的所有能力已经移植。

## 已使用的公共接口

| 接口 | 实际用途 | rc.2 证据位置 |
| --- | --- | --- |
| Cordis `apply / inject / ctx.plugin` | 插件入口及真实宿主加载 | `@deepseek-ai/cordis` 公开声明，实际集成测试 |
| `tools.register / get / schemas / execute` | 注册工具、检查定义身份与原生可见性 | `dsh-tools/lib/types/index.d.ts` |
| `ToolDefinition.output.presentationMeta` | 保存手动命令的完整成功回执 | 同文件 `ToolOutputDefinition` |
| `agent/pre-step` | 在正式请求前追加耐久 replacement | `dsh-agent/lib/types/runtime-types.d.ts` |
| `session.append / surface.nodes / deriveEventMessage / deriveMessages` | 原始日志不变、派生消息可重建 | `dsh-session/lib/types/index.d.ts` |
| `sessions.flush` | 原文与替换的持久化检查点 | 同文件 `SessionStore.flush` |
| `tokenMeter.estimateMessage` 与 `compaction/prune` | 同步声明旧节点估算成本，使折叠/恢复更新宿主预算投影 | `dsh-token-meter/lib/types/index.d.ts`、`dsh-compaction/lib/types/types.d.ts` |
| `sessionProjections.register / stateOf` | host-only 恢复索引与标记回放 | `dsh-session-projection/lib/types/index.d.ts` |
| `llm/stream / isAgentLoopRequest` | 冻结请求发出前的只读可达性检查 | `dsh-llm/lib/types/index.d.ts` |
| `agents.create / resume`、JSONL persistence | 离线真实宿主与两次重启 | `test/host.ts` 与 `test/host.test.ts` |

rc.2 的 `tools.modeFor` 是 private，本实现没有调用。rc.3 已出现独立 native executor 包，rc.2 仍有内建执行链路，本实现没有从新源码拷贝不存在的调用方式。

## 为什么采用原生 tool/result replacement

宿主规定工具 replacement 必须只覆盖当前一个工具结果，且只改变 `content`，必须引用被覆盖的 seq。调用来源、message id、toolCallId、错误状态、meta、turn 与 step 不允许变化。本插件完整复制当前事件其余数据，只换 content。

参考：[surface.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/surface.ts) 的 `assertToolResultRewrite`、`replacementRange` 与 source 校验；[原生 pruner](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/compaction/compaction-tool-result-pruner/src/index.ts) 的 `pruneSession`。相同约束已经在实际 rc.2 包运行验证。

工具结果原文留在 append-origin 事件。恢复标记含原始 seq 与完整消息哈希，解析后还必须验证真实 replacement 来源链、根事件、非 content 字段，以及从原文重新生成的全部折叠内容。普通工具输出中粘贴一个相同标记不会获得控制权。

手动标记只认自己的原生工具成功结果：真实 tool/call、相同 callId/turn/step、严格参数、meta、模型可见规范回执必须一致。单独在正文伪造 JSON，或让失败/后置替换结果残留 meta，都不构成有效命令。

生产代码不调用已禁止新增使用的 `eventAt / snapshotEvents / ownEvents`。测试为独立比对完整日志会用快照读取。`appendPluginRecord` 在源码说明中明确禁止仓库外插件调用，因此没有把它当外部插件持久化接口。也没有靠 TypeScript declaration merge 假装自定义 event 已加入运行时 catalog。

## 最大可用范围与没有实现的部分

实现了原生插件加载、真实模型可调用工具、旧工具输出自动折叠、手动 fold/keep/unmarked、文本和非文本原文分页、重启恢复、会话隔离、严格变短、取消/并发/失败处理。所有 system/developer/user/assistant 内容保持原样。

没有实现源码函数级折叠、注释标记读取、透明编辑参数展开、语义摘要模型、精确 tokenizer/账单节省、全批事务或替代 DSH compaction。没有借修改 `agent/request` 的配置 waterfall 来改消息，也没有修改深冻结的 LOOP request。

第三方投影改变了当前消息时，恢复 raw 原文可能撤销它对图片等内容的处理。因此本版选择拒绝覆盖，要求当前派生内容与索引里的原始/规范 replacement 相符。DSH compaction 已移除活动节点时，只提供 read，不把孤立工具结果重新加入 surface。

## 无法由这个外部插件独自保证的宿主行为

1. **卸载后仍能强制恢复可达。** 插件自己的钩子随卸载消失，原生 replacement 仍是合法日志。可行的上游最小接口是让已提交的可逆替换声明必需恢复能力，宿主在每次请求/卸载时统一检查，缺能力则恢复或拒绝，而不是让已卸载代码负责保护。
2. **任意未来 guard 都允许 read。** 当前 tools 公共接口能证明注册与可见性，不能证明以后所有动态审批。可行的上游接口是每次请求绑定一份不可伪造的只读恢复能力，按真实 agent 与具体读取动作授权。
3. **第三方自定义持久化消息事件。** 单纯声明 TypeScript 类型和注册 `SessionMessageProjection` 不会扩展日志运行时 catalog。若要支持更广泛的非工具消息变换，需要正式的可注册事件 schema/版本/恢复依赖契约。
4. **多记录变更与预算更新的原子事务。** 当前只承诺一个 append 的原子性。本插件逐项提交，失败后保留先前已提交的真实结果并阻止请求；需要全批事务时，应由宿主提供统一校验和提交边界，不能通过撤改旧日志模拟。

实际 rc.2 验证曾发现：裸 replacement 下 `TokenMeter.measure` 正确，但 `contextPressure/contextBreakdown` 轻量投影忽略变更量。因此最终实现已接入公开的相邻 `compaction/prune` shadow-price 协议；恢复增加内容也按有符号变化正确计算。没有将 UI 估算漂移误报成重复计费。claim 成功而 replacement 失败时，claim 不改变 token 总量，后续普通事件使其失效；本插件立即中止该轮，不继续追加同批其他 replacement。这对事件仍不是事务。

这些是接口建议，没有对上游推送、建 PR 或运行远程 CI。
