# dsh-context-folding

把较旧的大段工具输出换成可恢复的短摘录，原文继续保存在 DSH 的追加日志里。

这是面向 **DeepSeek Harness 0.2.1-rc.2** 的第三方 Cordis 插件。它注册真实的 `context_folding` 工具，通过原生 `tool/result` 单节点 surface replacement 改变后续模型看到的消息，不改写原始事件，不修改冻结的模型请求，不使用私人 SDK，不启动额外服务。

本版范围是**工具结果**。所有 system、developer、user、assistant 消息原样保留；工具调用、结果身份、错误状态和非文本块原样保留。它没有接入源码注释折叠、透明代码编辑、精确计费或替代 DSH compaction。

## 兼容性与安装

本版仅对发布包 `0.2.1-rc.2` 验证，`engines.dsh` 与宿主 peer dependencies 都固定到该版本。参考源码提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 的 package 版本是 `0.2.1-rc.3`，不能把两者视为相同接口。本项目构建和测试要求 Node.js 24 或更高版本。

从 GitHub 下载源码，构建安装包，然后安装到已使用该版本的 DSH profile：

```sh
git clone https://github.com/LIghtJUNction/dsh-context-folding.git
cd dsh-context-folding
npm ci --ignore-scripts
npm pack
dsh plugin --profile web add "$PWD/dsh-context-folding-0.1.0.tgz" --ignore-scripts
```

`npm pack` 会运行本项目的构建脚本，生成包含编译结果的安装包。pnpm 默认会拦截 Git 依赖的构建脚本；对 Git 地址直接使用 `--ignore-scripts` 则不会生成编译入口，因此应使用上面的本地打包路径。

TUI 用户将 `web` 换成自己的 profile 名称。重启该 profile，在工具清单确认 `context_folding`，再让模型调用 `{"action":"list"}`。默认只有估算上下文达到阈值才自动折叠，刚安装时列表为空或结果未折叠属于正常情况。

包内包含 `dsh.bundle.patch` 元数据、导出的 `cordis.patch.yml`、编译后的 JavaScript 与类型声明。GitHub 的 `dsh-plugin` topic 用于社区发现，不参与插件加载。

本地开发也可以构建后使用绝对路径 overlay：

```yaml
- insert:
    - id: context-folding
      name: /absolute/path/dsh-context-folding/dist/index.js
      config:
        auto: true
```

```sh
dsh web --patch /absolute/path/local-overlay.yml
```

本项目的离线集成测试使用真正的 rc.2 Cordis/DSH 服务、工具执行链路和 JSONL 后端；模型适配器用确定性脚本代替远程模型。独立 profile 的真实启动也验证了工具注册；真实模型及你现有的其他插件组合仍需要各自验收。

## 模型工具

工具不接受 `sessionId`、文件路径或访问令牌。服务端只使用 DSH 为当前调用绑定的活跃 Agent 与 Session，对象必须仍属于对应宿主 registry。引用中的哈希用于防止内容错配，不是认证凭据。

### 列举

```json
{"action":"list","offset":0,"limit":20}
```

返回 `entries`、`nextOffset`、每项的 `ref`、工具名、原始/当前 seq、折叠状态、手动标记、是否仍在 surface、最近消息保护状态和原文字节数。默认 20 项，最多 100 项。已被 DSH compaction 遮蔽的结果仍可出现在列表中，其 `active` 为 false。

### 精确读取与分页

```json
{"action":"read","ref":"<list 返回的 ref>","block":0,"offset":0,"limit":4000}
```

`page.data` 是所选原始块的一页；`nextOffset` 非空时继续同一块，为空后按 `nextBlock` 进入下一块。所有偏移和长度都按 Unicode 码点计数，不按 UTF-16 单元或 UTF-8 字节计数。文本页的 `encoding` 为 `text`；非文本块以完整 JSON 字符串分页，`encoding` 为 `json`，先拼接所有页再解析。默认 4000 码点，最多 24000。读操作不改变标记，恢复工具自己的输出永不被本插件再次折叠。

`sha256` 校验的是完整原始工具消息的 `JSON.stringify` 文本；它不只是当前页的哈希。`messageId`、`source` 和 role 说明结果身份。

### 手动折叠

```json
{"action":"fold","ref":"<ref>","summary":"工具证据：编译通过；详细输出已归档。"}
```

摘要必须非空、最多 2000 码点。标记明确写作 `agent-written, unverified`：插件不证明摘要在语义上正确。请求必须来自已经记入日志的真实模型工具调用；直接构造的未记账 dispatch 不能修改标记。

工具返回 `status: "queued"` 表示成功回执落日志后，在下一次获准的 pre-step 应用。它不表示执行函数返回的一瞬间就修改了历史。最近结果仍受保护；不在活动 surface 的结果不能手动折叠。新摘要可更新已有折叠，重复相同内容不追加相同 replacement。

### 保留与取消标记

```json
{"action":"keep","ref":"<ref>"}
```

```json
{"action":"unmarked","ref":"<ref>"}
```

两者都恢复仍在活动 surface 的原文，并阻止自动策略再次选择这条结果。`keep` 表示明确保留；`unmarked` 表示明确取消折叠标记，**也不会恢复为自动选择状态**。只有从未手动标记的条目才使用默认自动策略。

如果结果已经被 DSH compaction 遮蔽，工具会返回 `active: false` 并说明只能改变策略标记；它不会把孤立的旧工具结果重新插入会话，避免破坏调用配对。原文仍可 `read`。

## 配置

| 字段 | 默认值 | 作用 |
| --- | ---: | --- |
| `auto` | true | 自动选择旧工具结果；关闭不会自动展开已有折叠 |
| `keepRecentMessages` | 12 | 保留 surface 最后的这些节点；最小为 1 |
| `minTextChars` | 4096 | 自动候选的最小文本码点数 |
| `headChars` | 192 | 自动/手动折叠保留的全局头部码点数 |
| `tailChars` | 96 | 保留的全局尾部码点数 |
| `triggerTokens` | 64000 | 自动策略使用的估算触发阈值 |
| `maxFoldsPerStep` | 4 | 每步最多新增/更新多少折叠；恢复不受此限制 |

位置按当前 surface 顺序计算，不能拿 replacement 的新 seq 判断消息年龄。自动策略使用机械头尾摘录，标注 `automatic extract`，不调用模型生成摘要，也不推断工具执行结论。

估算为 `ceil(UTF-8 JSON bytes / 4)`，计入当时已派生消息、待接收消息和工具 schema，但不包含后续系统提示组装与供应商封装。它不是 tokenizer 结果、模型窗口剩余量或账单证明。

每个 replacement 必须同时减少文本码点数与**整个 content JSON 的 UTF-8 字节数**，包含标记、摘要与非文本开销；不满足就保留原文。这个保证不等于供应商最终完整请求、缓存费用或 DSH compaction 预算一定降低。

## 运行与失败语义

1. 注册 host-only `contextFolding` projection，从标准 `tool/call` / `tool/result` 重建恢复索引与标记。没有新增自定义持久化事件。
2. 在 `agent/pre-step` 获准后检查活跃身份、取消信号、实际可见的原生恢复工具和最新 surface。
3. `sessions.flush` 先确认原文已经交给持久化提供者；没有提供者则不折叠。
4. 重新读取状态，逐项同步 append 宿主公开的 `compaction/prune` 计量记录及只改变 content 的 replacement，再等待最终 flush。原始日志不删除、不改写。
5. `llm/stream` 最后只读检查冻结请求；已有折叠但恢复工具不在实际 schema 中时停止请求。

单个 append 是宿主提供的原子提交；计量记录和 replacement、多个 replacement 都不是全批事务。计量记录本身不改变预算，只有紧邻的有效 replacement 消费它；两者中间不 await。后项失败不会抹掉前项已经提交的事件。flush 失败则停止模型请求，下一轮即使没有新计划也必须重试落盘。已确认的原文仍可恢复。

宿主 `tokenMeter` 是必需服务。折叠与恢复都声明被替换节点的旧估算成本，使 `TokenMeter.measure`、`contextPressure` 和 `contextBreakdown` 在测试范围内同步变化；这些数值仍是宿主估算，不是精确计费。没有采用“裸 replacement 后假设所有预算视图自然更新”的做法。

工具默认 exclusive，使用每 Session 的重入守卫；所有 await 后重新验证身份和状态。取消发生在提交前则不追加，发生在已提交之后不伪造回滚。工具的后置策略把结果改成失败、或破坏规范回执时，手动标记不生效。并发会话的状态由宿主隔离。

## 边界

- 只支持模型直接可调用的 native 工具表面。PTC 模式仅展示 `run_code` 时不新建折叠；插件仍加载时会尝试展开已有折叠。
- 任意第三方工具 guard 可能在以后拒绝 read；公开接口不能提前证明未来每次执行都会获准。本插件检查定义身份、可见 schema 和实际请求，不能越过宿主策略。
- 插件卸载后，它自己的检查代码也随之消失。卸载前应对活跃折叠执行 keep 并完成一轮，再停机/卸载；否则原始日志虽仍存在，恢复工具会暂时不可用。重新加载插件可重建恢复索引。
- 其他插件已经改变消息投影或 replacement 时，不覆盖它的结果。全局 compaction 仍由 DSH 控制；本插件不承诺替代或推迟它。
- JSONL 重启恢复已测试。宿主有意 fork 复制到子会话的日志视为子会话已获准的历史，可在子会话自身恢复；不读取父会话的文件或对象。
- 原文与索引会占用日志及内存空间；这不是磁盘压缩工具，也不自动清理原始证据。索引只用于宿主，不发布到客户端 projection snapshot。
- 码点边界保留代理对，但可能拆分组合字符/字素簇；逐页拼接仍恢复原始字符串。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm pack
```

`test/content.test.ts` 检查 Unicode、文本/非文本保留、完整字节变短、标记规范验证和分页；`test/projection.test.ts` 检查事件来源链、回执、重放和 checkpoint；`test/controller.test.ts` 注入取消、持久化、并发与第三方变更故障；`test/host.test.ts` 运行真实 rc.2 宿主及 JSONL restart/resume。

发布版本兼容证据、无法完全保证的宿主边界与最小上游方案见 `docs/COMPATIBILITY.md`。本次实际运行回执由交付文档提供，不把预期测试结果写成已运行事实。
