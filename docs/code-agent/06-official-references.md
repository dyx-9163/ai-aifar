# 官方参考资料与本项目映射

## 1. 说明

本页只收录用于设计本代码 Agent 路线图的 OpenAI/Codex 一手资料。它们用于确认能力形态和设计原则，不表示当前私有模型原生支持同名工具，也不要求客户端使用 OpenAI API。

本项目的实现必须根据本地 llama.cpp/OpenAI-compatible 端点的实际能力选择原生工具调用或自定义 JSON 工具协议。

## 2. Codex 工作流

### 2.1 Codex CLI

- 文档：[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- 相关能力：检查本地仓库、修改文件、运行本地工具、权限控制、代码审查和会话内持续工作。
- 本项目映射：
  - [P0 工具执行和 Agent 循环](01-p0-code-agent-core.md)
  - [P1 Git 感知和任务恢复](02-p1-project-intelligence.md)
  - [P2 专项代码审查](03-p2-advanced-capabilities.md)

### 2.2 `AGENTS.md`

- 文档：[Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- 相关能力：全局和项目规则发现、从仓库根目录到当前目录的分层合并、近目录覆盖。
- 本项目映射：[P1 `AGENTS.md` 项目规则](02-p1-project-intelligence.md#3-agentsmd-项目规则)。

### 2.3 Skills

- 文档：[Build skills](https://learn.chatgpt.com/docs/build-skills)
- 相关能力：`SKILL.md`、脚本和参考资料的可复用工作流；根据名称和描述匹配后渐进加载完整内容。
- 本项目映射：[P1 `SKILL.md` 可复用工作流](02-p1-project-intelligence.md#4-skillmd-可复用工作流)。

## 3. 工具和 Agent 编排

### 3.1 模型与工具编排指导

- 文档：[Model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- 相关原则：
  - 工具描述应明确输入、输出和错误行为。
  - 只暴露当前任务需要的工具。
  - 定义并发、重试、停止和审批边界。
  - 在代表性任务上比较质量、延迟、Token、调用数和重试数。
- 本项目映射：
  - [P0 工具协议](01-p0-code-agent-core.md#5-工具协议)
  - [P0 Agent 编排循环](01-p0-code-agent-core.md#7-agent-编排循环)
  - [P3 评测体系](04-p3-platform-governance.md#2-评测体系)

### 3.2 Responses 工具 Schema

- 文档：[Responses API reference](https://developers.openai.com/api/reference/resources/responses)
- 相关能力：结构化函数工具、Shell、Apply Patch、工具选择、工具输出和响应压缩等概念。
- 本项目映射：
  - [P0 统一工具请求和结果](01-p0-code-agent-core.md#5-工具协议)
  - [P0 `apply_patch`](01-p0-code-agent-core.md#64-apply_patch)
  - [P0 `run_command`](01-p0-code-agent-core.md#65-run_command)

本项目不会照搬托管工具实现，而是在本地 Utility Process 内实现同等边界的受控工具运行时。

## 4. 上下文与长任务

### 4.1 Compaction

- 文档：[Compaction](https://developers.openai.com/api/docs/guides/compaction)
- 相关原则：长任务在接近上下文限制前压缩，保留继续任务所需状态；压缩可在长工作流中重复执行。
- 本项目映射：
  - [P0 代码任务台账和 75% 压缩策略](01-p0-code-agent-core.md#8-上下文工程)
  - [P1 长任务恢复](02-p1-project-intelligence.md#7-长任务恢复)

当前私有端点没有 OpenAI Responses compaction 的前提下，应继续使用客户端本地摘要和确定性任务台账，不能声称等价保留模型内部状态。

### 4.2 Conversation state

- 文档：[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- 相关能力：多轮状态、响应关联和长会话管理。
- 本项目映射：现有 SQLite turn/message 持久化以及 P1 的 `coding_tasks`、`tool_calls`、`workspace_changes` 和 `verification_runs`。

## 5. Shell 和补丁

### 5.1 Shell

- 文档：[Shell](https://developers.openai.com/api/docs/guides/tools-shell)
- 相关能力：受控命令执行、环境边界和工具结果回传。
- 本项目映射：[P0 命令访问规则和 `run_command`](01-p0-code-agent-core.md#43-命令访问规则)。

### 5.2 Apply Patch

- 文档：[Apply Patch](https://developers.openai.com/api/docs/guides/tools-apply-patch)
- 相关能力：使用结构化差异创建、更新或删除文件，并将应用结果返回模型继续迭代。
- 本项目映射：[P0 补丁工具、预览、冲突和撤销](01-p0-code-agent-core.md#64-apply_patch)。

## 6. MCP、检索和浏览器

### 6.1 MCP 和 Connectors

- 文档：[MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- 本项目映射：[P2 MCP 和连接器](03-p2-advanced-capabilities.md#4-mcp-和连接器)。

### 6.2 Web search

- 文档：[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- 本项目映射：[P2 公网检索和官方文档](03-p2-advanced-capabilities.md#3-公网检索和官方文档)。

### 6.3 Computer use

- 文档：[Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)
- 本项目映射：[P2 浏览器和 UI 验证](03-p2-advanced-capabilities.md#2-浏览器和-ui-验证)。

私有客户端应优先实现范围更小的本地浏览器测试工具，而不是直接开放通用桌面控制。

## 7. 评测

### 7.1 Evals 入门

- 文档：[Getting started with evals](https://developers.openai.com/api/docs/guides/evals)
- 本项目映射：[P3 评测体系](04-p3-platform-governance.md#2-评测体系)。

### 7.2 工作流分层评分

- 基于上述 Evals 指导，本项目将对模型消息、工具调用、补丁、验证和最终答案分别记录评分，不只评价最后一段自然语言。

## 8. 安全参考

### 8.1 Agent safety

- 文档：[Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- 本项目映射：
  - 工作区和工具最小权限。
  - 外部内容提示注入隔离。
  - 高风险操作审批。
  - MCP 和插件凭据保护。

### 8.2 Permissions

- 文档：[Codex permissions](https://learn.chatgpt.com/docs/permissions)
- 本项目映射：[P0 工作区与权限](01-p0-code-agent-core.md#4-工作区与权限) 和 [P3 策略中心](04-p3-platform-governance.md#4-策略中心)。

## 9. 使用边界

- 官方文档随产品更新可能变化，实施前应重新核对对应页面。
- 本路线图采用其中的能力和安全原则，不依赖特定 OpenAI 模型或托管执行环境。
- 当前私有模型是否支持 Function Calling、图像、上下文长度和并发，以客户端连接检测和实际验证为准。
- 模型能力不足时必须安全降级，不能通过解析普通回答偷偷执行命令。
