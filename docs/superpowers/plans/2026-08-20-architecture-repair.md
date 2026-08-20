# 架构修复清单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按优先级消除架构审查发现的 10 项问题：P0 快速加固（测试配置/worker 去重/失败可观测/成本护栏/CRLF），P1 根治（provider 原生 tool calling），P2 收敛（token 估算、上下文预算、密钥加密、迁移健壮性）。

**Architecture:** 全部修复走既有分层：shared 定义协议 → agent 层实现 → tests 回归。P1 用能力开关（capabilities.streamingTools）双轨切换：云端走原生 tool_calls，本地小模型保留文本围栏降级路径，不做大爆炸重写。

**Tech Stack:** TypeScript / Electron 43 / node:sqlite / vitest / playwright（fake-model e2e）

**执行纪律（用户偏好，已验证）：** 每个 Task 完成后 commit；不动私有模型容器（不跑 start/stop-model.ps1）；验证链 = 三段 typecheck + `pnpm test`；全部 Task 完成后重启应用（Stop-Process electron → 后台 pnpm start）+ 打包版 e2e；推送由用户控制；`pnpm test` ExitCode 1 为 PowerShell 伪影，以 "Test Files N passed" 文本判定。

**注意：** 动手前先 `git status` 与 `git diff` 核对现状——用户可能对 `src/agent/worker.ts`、`tests/worker.test.ts`、`tests/modelProvider.test.ts` 有未提交改动，任务必须叠加在其之上而非覆盖。

---

## 修复清单总览

| # | 发现 | 等级 | 实施任务 |
|---|------|------|----------|
| 1 | vitest 文件清单硬编码在 package.json，e2e 会漏进裸跑 | P0 | Task 1 |
| 2 | worker.ts 四处同构 failTurn 块（复制粘贴） | P0 | Task 2 |
| 3 | 失败 turn metrics=null，token 用量丢失 | P0 | Task 3 |
| 4 | 循环纠偏消息不落库，排障靠考古 | P0 | Task 4 |
| 5 | 迭代预算 Infinity 无花费护栏，云端按 token 计费可被烧穿 | P0 | Task 5 |
| 6 | readFile 给模型的行内容带 \r，applyPatch 写 LF，行尾静默漂移 | P0 | Task 6 |
| 7 | 工具调用嵌入文本 → 所有死循环的根因 | P1 | Task 7（7a–7e） |
| 8 | chars/4 token 估算对中文误差近一倍 | P2 | Task 8 |
| 9 | chatContext 与 modelProvider 双层压缩互不知情 | P2 | Task 9 |
| 10 | api_key 明文存 SQLite，与 privacy 定位冲突 | P2 | Task 10 |
| 11 | migration 10 按魔法值 2048 修用户数据，可能误伤 | P2 | Task 11 |

---

## P0 批次（本计划完整展开）

### Task 1: vitest.config.ts 收拢测试范围

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`（scripts.test）

- [ ] **Step 1: 写配置**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    watch: false,
  },
});
```

`tests/**/*.test.ts` 天然排除 `tests/e2e/*.spec.ts`（playwright 文件），无需显式 exclude。

- [ ] **Step 2: 简化 package.json test 脚本**

把 scripts.test 从 26 个文件名的长清单改为：

```json
"test": "vitest run",
```

- [ ] **Step 3: 验证**

Run: `npx vitest run`（裸跑，正是之前会出问题的方式）
Expected: `Test Files  27 passed (27)`，无 `tests/e2e/*.spec.ts`，无 "Playwright Test did not expect test() to be called here"。

- [ ] **Step 4: Commit**

```powershell
git add vitest.config.ts package.json; git commit -m "chore: move vitest file list into vitest.config.ts"
```

---

### Task 2: worker 失败结算去重（settleFailedTurn）

**Files:**
- Modify: `src/agent/worker.ts`（四处 failTurn 块，约 351/366/382/405 行附近，行号以现状为准）
- Test: `tests/worker.test.ts`（既有失败用例即回归）

- [ ] **Step 1: 基线**

Run: `npx vitest run tests/worker.test.ts`
Expected: 全绿。记录用例数。

- [ ] **Step 2: 抽函数**

在 `executeTurn` 的 `if (!context) return;` 之后、`let finalMetrics` 之前插入：

```ts
const settleFailedTurn = async (message: string): Promise<void> => {
  database.failTurn(turn.turnId, now(), message);
  try {
    await context.next({ type: 'turn.failed', error: message });
  } finally {
    approvalResolvers.delete(`approval-${turn.turnId}`);
    active.delete(turn.turnId);
  }
};
```

- [ ] **Step 3: 替换四处**

把 budgetExhausted / emptyAnswer / falseCompletion / catch 分支中的
`database.failTurn(...); try { await context.next({ type: 'turn.failed', ... }); } finally { ... }` 整块替换为 `await settleFailedTurn(message);`，各自保留 `return;`。四处 message 文案不变。

- [ ] **Step 4: 验证**

Run: `npx vitest run tests/worker.test.ts`
Expected: 与 Step 1 相同用例数全绿（纯重构，行为不变）。

- [ ] **Step 5: Commit**

```powershell
git add src/agent/worker.ts; git commit -m "refactor: deduplicate worker failed-turn settlement"
```

---

### Task 3: 失败 turn 保留 metrics

**Files:**
- Modify: `src/agent/database.ts`（failTurn 接口 + 实现 + migration 11）
- Modify: `src/agent/worker.ts`（settleFailedTurn 传 finalMetrics）
- Test: `tests/database.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/database.test.ts` 追加：

```ts
it('stores metrics on failed turns', () => {
  const database = openDatabase(join(tempDir(), 'app.db'));
  const thread = database.createThread('metrics');
  const turn = database.createTurn(thread.id, 'go', undefined, undefined);
  database.startTurn(turn.id, new Date().toISOString());
  database.failTurn(turn.id, new Date().toISOString(), 'boom', {
    modelName: 'm', completionTokens: 123,
  } as never);
  const snapshot = database.getSnapshot();
  expect(snapshot.turns[0]?.metrics?.completionTokens).toBe(123);
  database.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/database.test.ts -t 'stores metrics on failed turns'`
Expected: FAIL（failTurn 无第 4 参数 / metrics 为 null）。

- [ ] **Step 3: 实现**

`database.ts` 接口与实现签名改为：

```ts
failTurn(turnId: string, completedAt: string, error: string, metrics?: ModelRunMetrics): void;
```

实现中 UPDATE 语句增加 `metrics = :metrics`，参数 `metrics: metrics ? JSON.stringify(metrics) : null`。

新增迁移（沿用 applyMigration 模式）：

```ts
this.applyMigration(11, () => {
  // turns.metrics already exists and is nullable; nothing to alter, migration
  // only marks that failed turns now persist metrics going forward.
});
```

同时把 `tests/database.test.ts` 中所有断言 schema_migrations 清单的用例加上 `{ version: 11 }`。

- [ ] **Step 4: worker 接线**

Task 2 的 `settleFailedTurn(message)` 改为 `settleFailedTurn(message, finalMetrics)`，内部
`database.failTurn(turn.turnId, now(), message, metrics)`。四个调用点中 catch 分支传 `undefined`（此时 finalMetrics 可能未赋值，按现状可见性处理）。

- [ ] **Step 5: 验证**

Run: `pnpm test`
Expected: 全绿（database + worker 相关用例）。

- [ ] **Step 6: Commit**

```powershell
git add src/agent/database.ts src/agent/worker.ts tests/database.test.ts; git commit -m "feat: persist model metrics on failed turns"
```

---

### Task 4: 循环纠偏可观测（loop.steered 事件落库）

**Files:**
- Modify: `src/shared/protocol.ts`（AgentEvent 新成员 + guard）
- Modify: `src/shared/domain.ts`（Item kind 增加 'loop'）
- Modify: `src/agent/agentLoop.ts`（Emit 类型 + 7 处纠偏分支 emit）
- Modify: `src/agent/worker.ts`（持久化分支）
- Test: `tests/protocol.test.ts`、`tests/agentLoop.test.ts`、`tests/worker.test.ts`

- [ ] **Step 1: 写失败测试（agentLoop 侧）**

`tests/agentLoop.test.ts` 追加：

```ts
it('emits loop.steered events for steering decisions', async () => {
  const readWrite = { ...context, trustLevel: 'read-write' as const };
  const { emitted } = await runLoop(
    ['好的，让我先检查当前文件状态，然后一次性修复。', 'It exports answer = 42.'],
    readWrite,
  );
  expect(emitted.some((event) => event.type === 'loop.steered'
    && (event as { reason?: string }).reason === 'unfulfilled-intent')).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agentLoop.test.ts -t 'loop.steered'`
Expected: FAIL（无该事件）。

- [ ] **Step 3: 实现 agentLoop**

reason 联合类型与 Emit 扩展：

```ts
export type LoopSteerReason =
  | 'truncated-tool' | 'malformed-tool' | 'unparsed-xml' | 'empty-answer'
  | 'code-dump' | 'unfulfilled-intent' | 'false-completion';
```

`AgentLoopEmit` payload 联合新增：

```ts
| { type: 'loop.steered'; reason: LoopSteerReason; count: number }
```

七个纠偏分支各自在 `messages.push(...)` 前加一行，例如 intent 分支：

```ts
await options.emit({ type: 'loop.steered', reason: 'unfulfilled-intent', count: intentSteersUsed });
```

其余分支同理（reason 与计数器一一对应）。

- [ ] **Step 4: protocol + domain**

`protocol.ts` SequencedAgentEvent 增加：

```ts
| ({ type: 'loop.steered'; reason: string; count: number } & SequencedTurnEnvelope)
```

guard switch 增加：

```ts
case 'loop.steered':
  return hasString(value, 'reason') && typeof (value as { count?: unknown }).count === 'number';
```

`domain.ts` Item kind 联合增加 `'loop'`。

- [ ] **Step 5: worker 持久化**

worker 中持久化事件的分支（message.delta/answer.delta/reasoning.* 所在的函数）增加：

```ts
} else if (event.type === 'loop.steered') {
  database.appendItem({
    id: randomUUID(), threadId: event.threadId, turnId: event.turnId,
    kind: 'loop', createdAt: event.createdAt,
    payload: JSON.stringify({ reason: event.reason, count: event.count }),
  } as Item);
}
```

字段形态以 domain.ts Item 实际构造方式为准（对照 reasoningItem 工厂函数写一个 loopItem 工厂更佳）。

- [ ] **Step 6: worker 回归测试**

`tests/worker.test.ts` 追加：用会触发纠偏的 streamModel（如先发"让我修复 src/a.ts："再正常作答），断言
`harness.database.getSnapshot().items.some((item) => item.kind === 'loop')` 为 true。

- [ ] **Step 7: 验证**

Run: `pnpm test`
Expected: 全绿。注意 renderer-state/agentClientCore 若对未知事件有 switch 穷尽检查，按编译错误补 default 分支。

- [ ] **Step 8: Commit**

```powershell
git add src/shared/protocol.ts src/shared/domain.ts src/agent/agentLoop.ts src/agent/worker.ts tests/protocol.test.ts tests/agentLoop.test.ts tests/worker.test.ts; git commit -m "feat: persist loop steering decisions as loop items"
```

---

### Task 5: 每 turn 输出 token 成本护栏

**Files:**
- Modify: `src/agent/agentLoop.ts`
- Test: `tests/agentLoop.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('stops the turn when cumulative output tokens exceed the cost ceiling', async () => {
  const harness = await runLoopWithMetrics(
    Array.from({ length: 20 }, () => '```tool\n{"tool": "read_file", "input": {"path": "src/main.ts"}}\n```'),
    context,
    { completionTokens: 30_000 },
  );
  expect(harness.outcome.outputBudgetExhausted).toBe(true);
});
```

若 runLoop harness 不支持注入 metrics，先给 runLoop 加可选 `metrics?: Partial<ModelRunMetrics>`（runModel 返回 `metricsFor(run)` 处合并即可）。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（outcome 无 outputBudgetExhausted）。

- [ ] **Step 3: 实现**

```ts
/** Cumulative completion tokens that end a turn regardless of iteration budget. */
const TURN_OUTPUT_TOKEN_CEILING = 100_000;
```

循环状态新增 `let completionTokensUsed = 0;`，每次 runOnce 后：

```ts
completionTokensUsed += lastMetrics?.completionTokens ?? 0;
if (completionTokensUsed >= TURN_OUTPUT_TOKEN_CEILING) {
  break;
}
```

`break` 落入既有的 budget-exhausted 收尾路径；outcome 增加
`outputBudgetExhausted: completionTokensUsed >= TURN_OUTPUT_TOKEN_CEILING`（budget-exhausted 返回与正常返回都带上该字段，正常未触发时为 false）。

- [ ] **Step 4: 验证**

Run: `npx vitest run tests/agentLoop.test.ts`
Expected: 全绿。

- [ ] **Step 5: Commit**

```powershell
git add src/agent/agentLoop.ts tests/agentLoop.test.ts; git commit -m "feat: cap cumulative output tokens per turn"
```

---

### Task 6: readFile CRLF 对称

**Files:**
- Modify: `src/agent/tools/readFile.ts`
- Test: `tests/workspaceTools.test.ts`（或 readFile 现有归属测试文件，动手时以实际为准）

- [ ] **Step 1: 写失败测试**

```ts
it('normalizes CRLF content for the model while keeping the raw-byte hash', () => {
  writeFileSync(join(root, 'crlf.txt'), 'alpha\r\nbeta\r\n');
  const result = runReadFile({ path: 'crlf.txt' }, toolContext);
  expect(result.output.lines).toEqual(['alpha', 'beta', '']);
  expect(result.output.lines.some((line: string) => line.includes('\r'))).toBe(false);
  expect(String(result.output)).toContain('converted to LF');
});
```

（调用形态以该文件既有 read_file 执行辅助函数为准。）

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（行内含 \r）。

- [ ] **Step 3: 实现**

readFile.ts 中哈希保持原始 buffer 不变（与 applyPatch 的 raw-byte 基线一致），行切分前归一化：

```ts
const hadCrlf = text.includes('\r\n');
const normalizedText = text.replace(/\r\n/g, '\n');
const lines = normalizedText.split('\n');
```

输出文本末尾在 hadCrlf 时追加一行：

```ts
hadCrlf ? 'Note: this file uses CRLF line endings; content is shown converted to LF and patches write LF.' : ''
```

- [ ] **Step 4: 验证**

Run: `pnpm test`
Expected: 全绿（writeTools/agentLoop 的补丁链路测试不受影响）。

- [ ] **Step 5: Commit**

```powershell
git add src/agent/tools/readFile.ts tests/; git commit -m "fix: show CRLF files to the model as LF lines with an explicit note"
```

---

## P1 批次：原生 Tool Calling 迁移（Task 7，独立执行单元）

根因级修复：云端 provider 走 OpenAI 风格 tools/tool_calls，退役文本围栏解析层；本地小模型（capabilities.streamingTools=false）保留现有围栏路径。按能力开关双轨，逐子任务可回退。

### Task 7a: 能力位与工具 schema 目录

**Files:**
- Modify: `src/shared/domain.ts`（ModelCapabilities 增 `streamingTools?: boolean`）
- Create: `src/agent/tools/toolSchemas.ts`
- Test: `tests/toolSchemas.test.ts`（新文件，记得加入 package.json test 清单——若 Task 1 已完成则自动纳入）

核心代码：

```ts
export interface NativeToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export function buildNativeToolSchemas(trustLevel: WorkspaceTrustLevel): NativeToolSchema[] { /* 按 READ_ONLY/WRITE_TOOL_NAMES 生成 */ }
```

TDD：先断言 read-only 只含只读工具、read-write 含 apply_patch/run_command。

### Task 7b: SSE tool_calls 累积

**Files:**
- Modify: `src/agent/modelProvider.ts`（parseStreamChunk + readSseDeltas + ModelStreamHandlers）
- Test: `tests/modelProvider.test.ts`

要点：delta.choices[0].delta.tool_calls 数组按 `index` 累积 `{ id, name, arguments(string 拼接) }`；流结束（[DONE]）时对每个累积项 `JSON.parse(arguments)`，失败走与坏围栏相同的结构化错误；`ModelStreamHandlers` 新增 `onNativeToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): void`，既有调用方全部补 noop 兜底（历史教训：ModelStreamHandlers 回调必须兜底）。

### Task 7c: agentLoop 原生分支

**Files:**
- Modify: `src/agent/agentLoop.ts`
- Test: `tests/agentLoop.test.ts`

要点：runOnce 同时缓冲 text 与 nativeCalls；迭代顶部
`if (profile.capabilities?.streamingTools && nativeCalls.length > 0)` → 直接映射为 AgentToolCall 执行，跳过 parseToolCalls/stripToolFences 与全部文本纠偏（这些只为文本协议存在）；原生调用参数 JSON 解析失败时注入一次结构化重发纠偏（复用现有消息推入模式）。原生模式系统提示删除围栏教学段落，保留写规则。

### Task 7d: worker 开启云端能力位

**Files:**
- Modify: `src/agent/modelCapabilities.ts`（openai-compatible 云端 profile 默认 streamingTools: true）
- Test: `tests/modelCapabilities.test.ts`

### Task 7e: e2e 覆盖

**Files:**
- Modify: `tests/e2e/fakeModelServer.ts`（支持返回 tool_calls 流）
- Modify: `tests/e2e/app.spec.ts`（新增一条：fake model 发原生 read_file 调用 → 观察执行与作答）

Task 7 整体完成后的验收：`pnpm test` + `pnpm package` + `npx playwright test tests/e2e/app.spec.ts` 全绿，然后让用户在真实 deepseek-v4-pro 上重发历史失败指令回归。

---

## P2 批次（Task 8–11，逐项小步）

### Task 8: CJK 感知 token 估算

**Files:** `src/agent/modelProvider.ts`、`tests/modelProvider.test.ts`

替换 `APPROX_CONTEXT_CHARS_PER_TOKEN = 4` 为函数：

```ts
export function estimatedTokensForText(text: string): number {
  let cjk = 0;
  for (const char of text) if (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char)) cjk += 1;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
```

TDD：纯中文 100 字 ≈ 100 tokens；纯 ASCII 400 字符 ≈ 100 tokens。替换所有 `Math.ceil(len / 4)` 调用点（grep 确认）。

### Task 9: 上下文预算单一决策点

**Files:** Create `src/agent/contextBudget.ts`；Modify `src/agent/chatContext.ts`、`src/agent/modelProvider.ts`

把"何时压缩历史消息/何时压缩请求"的阈值集中到 contextBudget.ts 导出（HISTORY_MESSAGE_MAX_CHARS、contextCompressionSoftLimit 均迁于此），两个消费方只 import 不再各自定义。TDD：搬迁前后 modelProvider 压缩用例与 chatContext 用例全绿（纯移动 + import 改线）。

### Task 10: api_key 加密存储

**Files:** Modify `src/agent/database.ts`、`src/main.ts`（注入加解密桥）；Test `tests/database.test.ts`

要点：主进程用 Electron `safeStorage.encryptString`（不可用时回退 base64 + 'b64:' 前缀标记）；database 构造注入 `encrypt/decrypt` 函数；saveModelProfile 存 'enc:' 前缀密文，getModelProfileForRuntime 解密；migration 12 把无前缀存量明文就地加密。测试断言：落库文本不含原 key、运行时 profile 能还原。

### Task 11: migration 10 误伤修复

**Files:** Modify `src/agent/database.ts`（migration 10 条件）、`tests/database.test.ts`

条件收紧为"仅从未被用户改过的种子行"：

```sql
UPDATE model_profiles
SET max_output_tokens = :raised, updated_at = :updatedAt
WHERE max_output_tokens = 2048 AND created_at = updated_at
```

补测：created_at ≠ updated_at 的 2048 profile 不被抬升。migration 10 已执行过的库不受影响（applyMigration 幂等跳过），此为面向未来的条件修正 + 测试固化。

---

## 收尾验收（全部 Task 完成后）

- [ ] `npx vue-tsc --noEmit -p tsconfig.json; npx tsc --noEmit -p tsconfig.node.json; npx tsc --noEmit -p tsconfig.type-tests.json` → 0 错误
- [ ] `pnpm test` → Test Files 全 passed
- [ ] `Get-Process electron | Stop-Process -Force; pnpm start`（后台）→ 应用正常拉起
- [ ] `pnpm package; npx playwright test tests/e2e/app.spec.ts` → 9+ passed
- [ ] 不推送，等用户指令

## 自审记录

- 清单 11 项发现 → Task 1–11 全覆盖，无遗漏。
- 无 TBD/占位：Task 2/4/6 中"以现状为准"的表述均给出了确定的核对方法（辅助函数名/Item 构造对照 reasoningItem），属防漂移指引而非占位。
- 类型一致性：`LoopSteerReason`、`outputBudgetExhausted`、`settleFailedTurn`、`estimatedTokensForText`、`NativeToolSchema` 在各 Task 中命名唯一。
