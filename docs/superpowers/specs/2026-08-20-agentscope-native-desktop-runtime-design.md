# AgentScope 原生桌面运行时设计

## 文档状态

- 日期：2026-08-20
- 类型：架构设计
- 目标产品：Private AI Desktop
- 迁移策略：分阶段迁移，最终删除 TypeScript Agent 内核
- 运行约束：安装包内置 Python 和 AgentScope，不要求用户安装 Python 或 Docker
- 模型边界：云端、OpenAI-compatible、llama.cpp 和其他私有模型全部经过 AgentScope

## 目标

把 Private AI Desktop 从“Electron 内置 TypeScript Agent 循环”迁移为“Electron 桌面外壳 + AgentScope 原生 Agent 后端”。AgentScope 成为模型、Agent、工具、计划、上下文、记忆、会话、多 Agent、MCP、Skills、RAG、追踪和评测的唯一运行核心。

迁移完成后的产品必须满足：

1. 用户安装客户端后即可运行，不依赖系统 Python、pip、虚拟环境或 Docker。
2. 所有模型调用统一经过 AgentScope，不再由 TypeScript 直接请求模型。
3. AgentScope 作为 Harness，专业 `ReActAgent` 作为默认执行器。
4. Electron 继续提供安全桌面能力，Renderer 不直接接触文件系统、进程或密钥。
5. 任务、操作、审批和结果可持久化、恢复、审计和回放。
6. 迁移期间保留可回退路径；验收完成后删除旧 TypeScript Agent 内核。

## 非目标

- 不把 llama.cpp 或其他模型服务绑定到客户端生命周期；客户端只连接模型端点，不负责随应用启动或停止模型。
- 不在首批迁移中默认启用公网访问、任意 MCP Server 或工作区外文件访问。
- 不同时维护两套长期 Agent 内核。
- 不把模型原始隐藏思维链作为正确性依据；界面只展示提供方明确返回且允许展示的 reasoning 内容。
- 不使用一个巨大的 ReActAgent 代替任务调度、权限、持久化和并发控制。

## 已选方案与备选方案

### 选定：分阶段迁移到 AgentScope 原生 Harness

先引入可独立运行的内置 AgentScope 服务，再依次迁移模型、会话、工具、权限、上下文和多 Agent，最后删除旧内核。该方案能够持续验证现有客户端能力，并为每个阶段提供明确回退点。

### 未选：一次性替换

优点是最终架构形成快；缺点是模型、工具、数据库、IPC、打包和 UI 会同时变化，回归面过大，不适合当前已有大量功能和未提交改动的工程。

### 未选：独立 Docker 或远程 AgentScope 服务

服务隔离清晰，但违背“用户无需 Docker、安装后即可运行”的交付要求。远程部署还会引入额外运维、认证和数据出域边界。

# 第一部分：总体架构与职责边界

## 1.1 目标架构

```text
+---------------- Vue Renderer ----------------+
| Chat | Reasoning | Operations | Plan | Approval |
+------------------------+------------------------+
                         | validated Electron IPC
+---------------- Electron Main ----------------+
| Window / File Picker / Credential Vault         |
| AgentScope Supervisor / Update / Local Auth      |
+------------------------+------------------------+
                         | HTTP + SSE / AG-UI
+-------------- Embedded AgentScope Service ------+
| Task Harness                                     |
|  + Run lifecycle / retry / cancel / recovery     |
|  + Event journal / approval coordination         |
| Agent Orchestrator                               |
|  + routing / handoff / capacity / pipelines      |
| ReAct Agents                                     |
|  + coding / research / review / verification     |
| Model Registry / Formatter / Capability Probe    |
| Toolkit / Middleware / Hooks / MCP / Skills      |
| Plan / Session / Memory / RAG / Tracing / Evals  |
+------------------------+------------------------+
                         |
+---------------- Workspace & Endpoints -----------+
| Authorized local roots | Cloud APIs | llama.cpp  |
+--------------------------------------------------+
```

## 1.2 AgentScope 是 Harness，ReActAgent 是执行器

AgentScope Harness 负责系统级控制：

- 任务创建、排队、暂停、恢复、取消、重试和终止。
- 模型选择、容量限制、Agent 路由、Handoff 和并发 Pipeline。
- 会话、短期记忆、长期记忆、上下文压缩和状态恢复。
- 工具注册、权限中间件、审批、审计和工作区隔离。
- 统一事件、Tracing、评测和错误分类。

`ReActAgent` 负责具体任务中的“判断—调用工具—观察结果—继续—最终回答”循环。系统默认提供以下角色，但只按任务需要实例化：

- `CoordinatorAgent`：理解目标、创建计划、选择单 Agent 或多 Agent 流程。
- `CodingAgent`：搜索、读取、修改代码并处理验证反馈。
- `ResearchAgent`：文档、RAG、MCP 和允许范围内的公网检索。
- `ReviewAgent`：审查差异、安全影响和需求符合性。
- `VerificationAgent`：执行测试、构建和验收检查，输出证据。

普通问答可以使用无工具的轻量 Agent 配置，不强制启动多 Agent；代码修改、研究和复杂任务进入完整 Harness。

## 1.3 最终职责边界

### Vue Renderer

- 只负责展示和用户输入。
- 固定按“原始思考 / 操作记录 / 最终回答”分层展示每轮消息。
- 展示计划、Agent 状态、审批、文件差异、验证结果和错误。
- 不直接访问 Node、Python、文件系统、Shell、模型密钥或模型端点。

### Electron Main / Preload

- 管理窗口、安全 IPC、文件/目录选择和系统通知。
- 使用操作系统安全能力保存模型密钥；AgentScope 数据库只保存 `credentialRef`。
- 启动、认证、健康检查、监督和关闭内置 AgentScope 服务。
- 将 Renderer 请求转发给 AgentScope，将 SSE/AG-UI 事件转发给 Renderer。
- 不承担 Agent 决策、模型调用、工具协议解析或上下文构建。

### AgentScope Service

- 是模型调用、任务执行、Agent 状态和事件日志的唯一事实来源。
- 负责模型兼容、工具执行、权限判断、上下文、计划、记忆和多 Agent。
- 提供版本化 API 和事件协议，不暴露 Python 对象给 Electron。

### 模型服务

- 云端模型、OpenAI-compatible 服务和本地 llama.cpp 都是独立端点。
- AgentScope 只负责连接、能力探测、调用和容量控制。
- 启动或停止客户端、AgentScope 服务不得启动、停止或重启模型服务。

# 第二部分：内置运行时、通信、存储与生命周期

## 2.1 内置 Python 和依赖

每个平台构建独立的受管运行时包：

```text
resources/
  agentscope-runtime/
    python/
    app/
    site-packages/
    runtime-manifest.json
    licenses/
```

约束如下：

- Python 固定为兼容 AgentScope 的 3.11+ 小版本，不查找或调用系统 Python。
- 首次实现以 `agentscope==2.0.6` 为锁定基线；升级必须单独验证并更新锁文件、哈希和许可证清单。
- Python 依赖使用完全锁定版本和文件哈希，构建阶段离线组装，运行阶段不执行 `pip install`。
- AgentScope Service 所需的 FastAPI、Uvicorn、AG-UI、SQLite/SQLAlchemy 和 OpenTelemetry 能力随运行时打包。
- `runtime-manifest.json` 记录 Python、AgentScope、依赖锁、协议版本和构建平台。
- 运行时代码和第三方依赖放在 ASAR 外的只读资源目录；用户数据不得写回安装目录。

## 2.2 服务启动与认证

Electron Main 启动受管 Python 子进程。启动协议为：

1. Electron 生成高熵一次性会话令牌。
2. 令牌通过子进程标准输入传递，不写入命令行、配置文件或日志。
3. Python 只绑定 `127.0.0.1` 的系统分配端口。
4. Python 在标准输出发送一条固定格式的 bootstrap JSON，包含端口、PID、协议版本和运行时版本。
5. Electron 使用令牌调用 `/health` 和 `/ready`，版本匹配后才开放 UI 请求。
6. 所有 HTTP、SSE 和 AG-UI 请求必须携带会话令牌；拒绝非 loopback 来源和缺失令牌请求。

服务接口按版本分组：

```text
/v1/health
/v1/runtime/capabilities
/v1/model-profiles/*
/v1/threads/*
/v1/runs/*
/v1/approvals/*
/v1/events/stream
```

## 2.3 事件协议

优先使用 AG-UI 标准事件表达文本、工具和运行状态；AgentScope 特有能力使用命名空间扩展。每个事件必须包含：

- `protocolVersion`
- `threadId`
- `runId`
- `turnId`
- `agentId`
- 单调递增的 `sequence`
- `timestamp`
- 类型化 `payload`

统一事件至少覆盖：

- 运行：`run.started`、`run.paused`、`run.resumed`、`run.completed`、`run.failed`、`run.cancelled`
- 思考：`reasoning.delta`、`reasoning.completed`
- 操作：`tool.started`、`tool.output`、`tool.failed`
- 计划：`plan.created`、`plan.updated`、`plan.completed`
- Agent：`agent.started`、`agent.handoff`、`agent.completed`
- 审批：`approval.required`、`approval.resolved`
- 回答：`answer.delta`、`answer.completed`
- 上下文：`context.compaction.started`、`context.compaction.completed`

Electron 和 Renderer 不根据显示文本判断事件类型。断线重连时使用 `Last-Event-ID` 或最后 `sequence` 补发缺失事件，并按事件 ID 去重。

## 2.4 数据所有权与迁移

最终状态使用 AgentScope Service 管理的 SQLite 数据库作为 Agent 数据事实来源：

```text
<userData>/agentscope/agentscope.sqlite
<userData>/agentscope/artifacts/
<userData>/agentscope/logs/
<userData>/agentscope/checkpoints/
```

数据库保存：

- thread、run、turn、message 和事件日志。
- Agent、计划、工具调用、审批和验证记录。
- 工作区授权、非敏感模型配置、能力探测和并发配置。
- 会话状态、短期记忆、长期记忆索引和压缩摘要。
- 文件检查点、Artifact 元数据、Tracing 关联 ID 和评测结果。

密钥不进入 AgentScope SQLite。Electron 安全存储保存密钥，并在 AgentScope 启动后通过认证接口注入内存；日志、事件和错误统一脱敏。

现有 `app.sqlite` 采用非破坏性迁移：

1. 迁移前创建只读备份和 schema/version 记录。
2. 导入工作区、线程、消息、模型配置和审批历史。
3. 使用迁移映射表保证重复启动不会重复导入。
4. 导入后对数量、外键、事件顺序和密钥缺失进行校验。
5. 旧库在最终验收前只读保留；不进行双写。

禁止 TypeScript 和 Python 同时写同一个 SQLite 文件。

## 2.5 生命周期与恢复

- AgentScope 服务随桌面应用启动，并在应用完全退出时执行有界优雅关闭。
- 关闭窗口但应用仍在托盘运行时，AgentScope 和任务继续运行。
- 应用完全退出前保存任务检查点；未完成任务下次启动显示为“可恢复”，不自动继续执行有副作用操作。
- AgentScope 意外退出时，Electron 最多执行有限次数、带退避的自动重启；连续失败后进入明确的 Runtime Error 页面。
- 模型服务生命周期始终独立。AgentScope 重启不得重启 llama.cpp，也不得修改其 Compose、进程或端口。
- 应用更新使用先验兼容检查、数据库备份、原子替换和失败回退；运行时版本与 API 协议不匹配时拒绝执行任务。

# 第三部分：AgentScope 生态能力与执行闭环

## 3.1 模型注册与统一调用

所有模型配置由客户端 UI 创建，但由 AgentScope Model Registry 保存非敏感元数据并完成调用。模型配置至少包含：

- 部署类型：`cloud` 或 `private`
- 协议：`openai` / `openai-compatible`
- Base URL、模型 ID、`credentialRef`
- 上下文窗口、最大输出 Token、流式、视觉、工具调用和思考能力
- 并发容量来源、最近探测结果和探测时间

OpenAI-compatible 模型优先使用 AgentScope `OpenAIChatModel` 与匹配 formatter。提供方的非标准思考字段、工具参数或视觉格式放入独立 Adapter，不进入 Agent 或 UI。

私有模型连接测试尝试读取服务公开的并发/slot 信息；能可靠识别 `LLAMA_PARALLEL` 或等价能力时使用其值，否则安全回退为 `1`。云端模型不探测本地 slot，只应用用户配置或提供方速率限制。Harness 的 Capacity Manager 在提交模型请求前统一排队。

## 3.2 Toolkit、MCP、Skills 和工作区

工具最终迁移为 Python 原生 AgentScope Toolkit：

- 工作区：目录树、代码搜索、按行读取、文件元数据。
- 修改：结构化补丁、创建、删除、重命名、检查点和撤销。
- 命令：受限进程执行、超时、取消、输出上限和子进程清理。
- Git：状态、差异、日志和最终变更审查。
- 验证：发现并运行类型检查、测试、构建和格式检查。
- 时间：返回带时区的结构化当前时间，禁止模型为时间问题调用任意 Shell。
- 多模态：图片附件、OCR/视觉内容和 Artifact 引用。

AgentScope Skill 按需加载 `SKILL.md`，项目规则解析器分层加载工作区 `AGENTS.md`。MCP Server 必须显式安装、声明权限和配置凭据；默认不允许任意网络 MCP 或工作区外读写。

迁移中可以使用 `LegacyToolBridge` 暂时调用现有 TypeScript 工具，但 AgentScope 始终拥有任务状态、权限决定和事件。每个工具迁移完成并通过合同测试后，从 Bridge 删除；最终删除 Bridge 和 Node Agent Utility Process。

## 3.3 权限与审批

权限策略通过 AgentScope middleware 在工具执行前强制实施，而不是依赖模型自觉：

- 只读工作区：允许搜索和读取；拒绝写入和有副作用命令。
- 读写工作区：允许经过策略判断的补丁和验证命令。
- 删除、批量移动、依赖安装、网络访问、发布、Git 写操作和工作区外访问必须审批。
- 路径必须规范化并验证最终目标仍位于授权根目录。
- 同一工作区允许多个只读 Agent 并发；写操作使用工作区级串行锁和内容哈希前置检查。
- 用户拒绝审批后，Agent 可以调整计划，但不得用其他工具绕过拒绝。

## 3.4 Plan、多 Agent 和并发

`PlanNotebook` 保存任务计划、步骤状态和恢复点。由于 AgentScope 当前 Plan 子任务按顺序执行，真正并发由 Harness 的 Pipeline/Router 管理：

- 独立的搜索、分析和审查任务可以 fan-out 并发。
- 具有数据依赖的任务按顺序执行。
- 多个 Agent 不得同时写同一文件；写入先汇总到 Coordinator，再按检查点应用。
- 每个模型请求都经过 Capacity Manager。本地并发上限由探测值或回退值控制。
- Agent 不是固定数量；Coordinator 根据任务复杂度选择单 Agent 或多 Agent。

## 3.5 会话、记忆与上下文压缩

AgentScope Session 保存 Agent、Memory、Plan 和工具状态。上下文按以下优先级组装：

1. 稳定系统指令和安全策略。
2. 用户原始目标和后续明确约束。
3. 工作区规则与所需 Skills。
4. 当前计划、已完成步骤和待办事项。
5. 修改文件、检查点和最近差异。
6. 最近工具结果、验证失败和待决审批。
7. 与当前步骤直接相关的代码和对话。

压缩阈值使用模型上下文窗口，而不是仅使用最大输出 Token：

```text
inputTokens + reservedOutputTokens >= contextWindowTokens * 75%
```

其中 `reservedOutputTokens` 不小于模型配置的最大输出预算。模型上下文窗口未知时，连接测试必须要求用户确认或使用提供方保守默认值。

达到阈值后：

- 发出 `context.compaction.started`，UI 显示“正在压缩上下文”。
- 使用同一模型生成结构化任务摘要，并由确定性校验器检查必填事实。
- 保留原始目标、用户约束、计划、修改、审批、验证和未解决问题。
- 丢弃重复日志、已过时代码片段和被新结果取代的讨论。
- 摘要写入 Session/Memory，完成后发出 `context.compaction.completed`。
- 任务继续执行，不因单次输出达到 Token 上限而宣布完成。

长期记忆只保存经过分类的稳定事实、用户选择和项目知识；不把密钥、完整图片 data URL、未经确认的模型推断或隐藏思维链写入长期记忆。

## 3.6 RAG、Hooks、Tracing 和 Evaluation

- RAG 用于项目文档、代码索引和用户选择的知识库；检索结果保留来源和版本。
- Hooks 把 reasoning、acting、observe、interrupt 和 print 生命周期映射为统一 Harness 事件。
- Middleware 用于权限、参数校验、速率限制、日志脱敏、重试和指标。
- OpenTelemetry 默认写入本地受限存储；只有用户显式配置后才外发 Trace。
- Evaluation 建立固定任务集，覆盖问答、代码修改、工具调用、上下文压缩、多模态和多 Agent。
- AgentScope Studio 仅作为开发诊断工具，不作为终端用户运行依赖。

## 3.7 错误处理和终止条件

错误必须结构化分类：

- `runtime-unavailable`：内置运行时缺失、启动失败或版本不匹配。
- `model-unavailable`：端点离线、认证失败或模型不存在。
- `capacity-exhausted`：本地 slot 或云端速率限制已满。
- `context-overflow`：压缩后仍无法满足模型上下文。
- `tool-rejected`：策略或用户拒绝。
- `tool-failed`：工具执行、超时或输出解析失败。
- `workspace-conflict`：用户修改、哈希变化或写锁冲突。
- `agent-stalled`：连续步骤无进展或超过迭代预算。
- `protocol-error`：API 或事件协议不兼容。

任务完成必须同时满足：

- 没有运行中的工具、Agent、审批或计划步骤。
- 需要的修改已经应用并记录。
- 风险匹配的验证已经完成，或明确说明无法验证的原因。
- 最终差异没有越过授权范围。
- Harness 发出唯一一次 `run.completed` 和独立最终回答。

# 第四部分：迁移顺序、测试、验收与回滚

## 4.1 阶段一：内置 AgentScope Runtime

交付：

- 在当前工程新增 Python AgentScope Service 子项目。
- 固定 Python、AgentScope 和依赖版本。
- Electron Supervisor、bootstrap、health、认证、日志和优雅关闭。
- 打包脚本把平台运行时放入应用资源目录。
- 开发模式允许使用工程内受管虚拟环境，但不得隐式使用任意系统环境。

退出条件：在一台未安装 Python、未安装 Docker 的干净环境中，安装包可以启动 AgentScope 并通过健康检查。

## 4.2 阶段二：模型和新会话切换

交付：

- AgentScope Model Registry 和 OpenAI-compatible Adapter。
- 模型配置、连接测试、视觉、工具调用和思考能力探测。
- 所有新会话的模型请求经过 AgentScope。
- AG-UI/SSE 到现有 Renderer 状态的兼容映射。
- 旧会话仍可查看，现有 TypeScript Agent 仅作为内部回退开关。

退出条件：云端、OpenAI-compatible 和 llama.cpp 的文本、流式、工具、思考和图片场景通过合同测试。

## 4.3 阶段三：Harness、会话、上下文、工具与权限

交付：

- Task Harness、Session、Memory、事件日志、取消、恢复和 75% 压缩。
- Workspace、Toolkit、审批 middleware、检查点和验证闭环。
- 现有数据非破坏性导入 AgentScope SQLite。
- 工具逐个从 `LegacyToolBridge` 迁移到 Python。

退出条件：只读、修改、审批、取消、恢复、压缩、脏工作树保护和验证失败后继续修复全部通过。

## 4.4 阶段四：AgentScope 完整生态

交付：

- Coordinator、Coding、Research、Review 和 Verification Agent。
- PlanNotebook、Routing、Handoff 和并发 Pipeline。
- Agent Skills、MCP、RAG、长期记忆、Tracing 和 Evaluation。
- 本地模型容量管理、只读并发和写入串行化。

退出条件：单 Agent、多 Agent、并发容量、计划恢复、MCP 权限、RAG 来源、Trace 和评测场景通过。

## 4.5 阶段五：最终切换和删除旧内核

交付：

- AgentScope 成为唯一运行后端。
- 删除 TypeScript 模型调用、AgentLoop、TurnScheduler 和 Node Agent Utility Process。
- 删除 `LegacyToolBridge`、文本工具协议执行路径和长期兼容开关。
- 保留 Vue、Preload、Electron Supervisor、安全存储和稳定 UI 协议。
- 更新架构文档、打包清单、许可证和恢复说明。

退出条件：完整回归和升级演练通过，安装包中不存在旧 Agent 执行入口。

## 4.6 测试分层

### Python 单元测试

- Model Adapter、formatter、事件转换、上下文预算和压缩校验。
- 权限 middleware、路径安全、工具参数、写锁和审批。
- Plan、路由、Handoff、容量、重试和终止条件。
- Session、Memory、迁移幂等、脱敏和错误分类。

### TypeScript 单元测试

- Electron Supervisor、bootstrap 解析、认证、重启和版本不匹配。
- IPC Schema、事件去重、恢复游标和 Renderer 状态归并。
- 凭据注入不落盘、不进事件和不进日志。

### 合同与集成测试

- 使用固定 Fake OpenAI-compatible 服务覆盖 SSE、Function Calling、reasoning、vision、超时和错误。
- 对 Python API 与 TypeScript 类型运行同一组 JSON 合同样例。
- 验证 AgentScope 事件能稳定呈现“思考 / 操作 / 最终回答”。
- 验证旧库导入、重复启动、崩溃恢复和事件补发。

### 打包与 E2E

- 清空 `PATH` 中的 Python，并确认没有 Docker 服务可用。
- 安装或解压正式包，验证内置 Runtime 启动和版本。
- 运行普通问答、代码工具、审批、取消、恢复、多 Agent 和图片任务。
- 退出客户端后确认外部 llama.cpp 仍然运行；重启客户端后确认可以重新连接。
- 扫描安装包，确认 Python/AgentScope/许可证齐全，密钥、缓存、测试数据和开发虚拟环境未被打包。

## 4.7 发布门槛

最终切换前必须同时满足：

1. Python、TypeScript、合同、集成和打包 E2E 全部通过。
2. 安装包在无 Python、无 Docker 的干净 Windows 环境通过验收；其他目标平台各自通过对应运行时验收。
3. 新旧会话数据迁移数量和关联关系一致，迁移可重复且不破坏旧库。
4. 所有模型调用的网络证据均来自 AgentScope 进程，TypeScript 不再直接请求模型。
5. 工作区外路径、未授权写入、危险命令和密钥泄漏测试均被阻止。
6. 长任务达到 75% 阈值时成功压缩并继续，最终状态不由单次输出长度决定。
7. 本地并发不超过探测到的 slot；无法探测时回退为 1。
8. 模型服务在客户端和 AgentScope 启停期间保持独立。

## 4.8 回滚策略

- 阶段一至四保留内部 `agentscope` / `legacy` 后端启动开关，但默认逐阶段切向 AgentScope，不向普通用户暴露。
- 每次数据库迁移前创建版本化备份；导入失败时继续使用旧库，不删除或覆盖原数据。
- 每个阶段只迁移一个明确事实来源，禁止长期双写。
- AgentScope Runtime 更新失败时回退到上一套完整 Runtime 目录，不混用两个版本的依赖。
- 阶段五删除旧内核前创建稳定发布标签；删除后若发生严重回归，通过发布上一完整版本回退，而不是在新版本中恢复双内核。

## 4.9 实施约束

- 当前工作树包含用户和 Qoder 的既有未提交改动，实施时必须逐文件检查并避免覆盖。
- 每个阶段使用独立实施计划、测试记录和验收报告。
- 未达到本阶段退出条件，不进入下一阶段。
- 不因模型声称成功而通过验收；测试、文件差异、事件和运行状态必须提供真实证据。

## 官方基线

- AgentScope v2.0.6 release：https://github.com/agentscope-ai/agentscope/releases/tag/v2.0.6
- AgentScope Python 与依赖声明：https://github.com/agentscope-ai/agentscope/blob/main/pyproject.toml
- ReActAgent：https://doc.agentscope.io/tutorial/quickstart_agent.html
- Model：https://doc.agentscope.io/tutorial/task_model.html
- State/Session：https://doc.agentscope.io/tutorial/task_state.html
- Hooks：https://doc.agentscope.io/tutorial/task_hook.html
- Middleware：https://doc.agentscope.io/tutorial/task_middleware.html
- Plan：https://doc.agentscope.io/tutorial/task_plan.html
- Pipeline：https://doc.agentscope.io/tutorial/task_pipeline.html
- MCP：https://doc.agentscope.io/tutorial/task_mcp.html
- Skills：https://doc.agentscope.io/tutorial/task_agent_skill.html
- Memory：https://doc.agentscope.io/tutorial/task_memory.html
- Tracing：https://doc.agentscope.io/tutorial/task_tracing.html
- Evaluation：https://doc.agentscope.io/tutorial/task_eval.html
