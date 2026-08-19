---
kind: logging_system
name: 无专用日志框架：基于 console.error 与结构化事件流的轻量输出
category: logging_system
scope:
    - '**'
source_files:
    - src/main.ts
    - src/preload.ts
    - src/renderer/main.ts
    - src/agent/worker.ts
    - src/main/agentRequestBroker.ts
    - src/shared/redaction.ts
---

## 1. 使用的系统/方法

该仓库**没有引入任何第三方日志库**（如 winston、pino、bunyan、debug、log4js 等）。`package.json` 的 `dependencies` 与 `devDependencies` 中均不存在日志相关依赖。所有进程内诊断输出仅通过 Node/Electron 原生的 `console.error` 完成，且只出现在主进程启动 Agent 子进程失败时的异常路径上。

Agent Worker 与渲染进程**完全不使用 `console.*` 或 `process.stdout/stderr`**；业务运行状态通过结构化的 IPC 事件流（`SequencedEvent`）持久化到 SQLite 数据库并由渲染端消费，而非写入控制台。

## 2. 关键文件

- `src/main.ts`：唯一出现 `console.error` 的位置（第 88 行），用于记录 Agent 运行时启动失败。
- `src/preload.ts`：仅暴露 `contextBridge` API，不包含任何日志调用。
- `src/renderer/main.ts`：Vue 应用入口，无日志初始化。
- `src/agent/worker.ts`：Agent Worker 进程核心，零 `console.*` 调用；错误通过 `safeErrorMessage` → `database.failTurn` + `turn.failed` 事件上报。
- `src/shared/redaction.ts`：提供 `safeErrorText`，是错误信息脱敏的唯一集中点，被 worker 与多处错误处理复用。
- `src/main/agentRequestBroker.ts`：请求/响应代理，错误以 Promise reject 形式传递，不写日志。

## 3. 架构与约定

### 3.1 进程边界与输出通道

| 进程 | 输出方式 | 说明 |
|---|---|---|
| Electron Main (`src/main.ts`) | `console.error` | 仅在 `startAgentRuntime()` 捕获异常时打印，格式为字符串拼接 |
| Agent Worker (`src/agent/worker.ts`) | 无控制台输出 | 所有运行期状态通过 `postEvent` 发送结构化 `SequencedEvent`，并同步写入 SQLite（`persistStreamEvent`） |
| Renderer (`src/renderer/*`) | 无控制台输出 | 通过 `desktop.subscribe('agent:event')` 消费事件流 |
| Preload | 无输出 | 仅做 IPC 桥接 |

### 3.2 结构化“日志”即领域事件

项目将传统意义上的“日志”替换为**领域事件流**：
- 事件类型包括 `turn.queued`、`turn.started`、`answer.delta`、`reasoning.raw.delta`、`approval.required`、`turn.completed`、`turn.failed` 等（见 `src/agent/worker.ts` 中的 `createTurnEventEmitter` 与 `execute` 函数）。
- 每个事件携带 `threadId`、`turnId`、`modelProfileId`、`sequence` 等上下文字段，由 `createTurnEventEmitter` 自动注入。
- 事件先持久化到 SQLite（`persistAndPost`），再经 MessageChannel 发送到渲染端，保证崩溃可恢复。

### 3.3 错误处理约定

- 错误统一通过 `safeErrorMessage(error, profile?.apiKey ? [profile.apiKey] : [])` 脱敏后返回，避免泄露密钥。
- 失败分支走 `database.failTurn(turnId, now(), message)` + `turn.failed` 事件，而非写入控制台。
- 主进程侧的 `console.error` 仅作为兜底诊断输出，不承载业务语义。

## 4. 约定与约束

- **禁止在业务模块中直接调用 `console.log/debug/warn/info`**：当前代码库中除主进程启动失败路径外，没有任何 `console.*` 调用，表明团队倾向于用结构化事件替代控制台输出。
- **错误消息必须脱敏**：通过 `shared/redaction.ts` 的 `safeErrorText` 统一处理，限制长度（默认 500 字符）并过滤敏感字段（如 `apiKey`）。
- **运行态输出必须结构化**：所有跨进程的状态变更都通过带 `type` 字段的 JSON 事件传递，便于测试断言（见 `tests/` 下大量针对协议与事件的测试）。
- **无日志级别配置**：因为没有日志框架，所以不存在 log level 策略；调试依赖 IDE 控制台与 SQLite 中持久化的事件数据。
- **无日志轮转/归档**：输出目标仅为 Node 标准输出（Main 进程）和 SQLite 数据库（Worker 进程），无外部 sink 配置。

## 5. 结论

该仓库采用“**无日志框架 + 结构化事件流**”的模式：将传统日志职责拆分为两条线——进程级异常用 `console.error` 简单输出，业务运行态则通过强类型的 `SequencedEvent` 管道持久化并消费。这种设计使“日志”成为可查询、可回放的数据流，而非不可控的控制台文本。