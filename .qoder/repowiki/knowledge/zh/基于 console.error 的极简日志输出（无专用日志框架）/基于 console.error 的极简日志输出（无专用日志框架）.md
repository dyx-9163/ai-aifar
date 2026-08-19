---
kind: logging_system
name: 基于 console.error 的极简日志输出（无专用日志框架）
category: logging_system
scope:
    - '**'
source_files:
    - src/main.ts
    - src/agent/worker.ts
    - src/main/agentRequestBroker.ts
    - package.json
---

## 1. 使用的系统/方法

本仓库**没有引入任何第三方日志框架**（package.json 中不存在 winston、pino、bunyan、debug、electron-log、signale、chalk 等依赖）。代码中的“日志”仅通过 Node.js/Electron 内置的 `console.error` 输出，且全仓仅出现一次：

- `src/main.ts:88` — `console.error('Failed to start agent runtime:', error);`

该调用位于主进程 `createWindow()` 启动 Agent 运行时失败时的 catch 分支，用于向 Electron 控制台输出错误。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `src/main.ts` | 唯一使用 `console.error` 的位置，记录 Agent 子进程启动失败 |
| `src/preload.ts` | 暴露 IPC 桥，不产生日志 |
| `src/agent/worker.ts` | Agent 工作线程，所有异常路径均通过结构化事件/数据库持久化，不直接写日志 |
| `src/main/agentRequestBroker.ts` | 请求代理，超时与断连以 Promise reject 形式返回错误，不打印日志 |

## 3. 架构与约定

- **无集中式 Logger**：没有 logger 初始化、log level 配置、sink 路由或结构化字段定义。每个模块各自处理错误。
- **错误传播优先于日志**：Agent 工作线程 (`worker.ts`) 将运行期错误通过 `safeErrorMessage` → `turn.failed` 事件 + `database.failTurn` 持久化到 SQLite，而不是写入控制台；主进程通过 IPC 把错误转发给渲染进程。
- **调试/诊断信息走应用内通道**：例如 `app:health` IPC handler 返回 `{ ok, version }`，供测试或 UI 查询，而非打印日志。
- **模型运行时（model-runtime/）** 是独立 Docker Compose 编排的 llama.cpp server，其日志由容器/进程自身管理，不在本仓库代码中捕获。

## 4. 约定与约束

- **当前约束**：仓库未强制要求使用特定日志库；现有代码模式表明——业务逻辑错误应通过协议事件和数据库持久化传递，仅在进程级不可恢复错误（如 Agent 子进程无法 fork）时使用 `console.error`。
- **可观察性现状**：由于缺少统一日志框架，生产环境无法按级别过滤、按目标分流（文件/远程）、或附加上下文字段（如 threadId、turnId），这与 `SequencedEvent` 中携带的 `threadId/turnId/modelProfileId/sequence` 等结构化字段形成对比——后者用于事件流，而非控制台日志。
- **测试侧**：端到端测试 (`tests/e2e/app.spec.ts`) 通过 Playwright 启动 Electron 并检查 UI 行为，不校验控制台日志内容。

综上，该仓库的“日志系统”实质上是**无框架、无级别、无 sink 的裸 `console.error` 输出**，真正的可观测性集中在结构化事件流与 SQLite 持久化上。