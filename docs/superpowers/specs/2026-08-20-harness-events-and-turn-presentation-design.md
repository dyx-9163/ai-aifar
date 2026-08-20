# Harness 事件与轮次分层设计

## 目标

在保留现有 OpenAI-compatible 原生 `tool_calls` 链路的前提下，为提供方退化成文本工具协议时增加统一适配边界，并把每轮会话固定呈现为“原始思考 / 操作记录 / 最终回答”。

## 数据流

```text
模型提供方
  -> Provider Adapter
     -> 原生 function/tool_calls
     -> fenced JSON 兼容器
     -> invoke/parameter XML 兼容器
     -> tool_call/tool_input XML 兼容器
  -> HarnessEvent
     -> reasoning
     -> tool.started / tool.output
     -> answer.delta
     -> error / lifecycle
  -> Agent 状态机
  -> 持久化
  -> 轮次分区界面
```

## 协议边界

- 原生 `tool_calls` 仍是首选路径；文本协议只作为兼容层。
- 所有文本兼容器输出统一的 `NormalizedToolCall`，Agent 状态机不感知供应商 XML 细节。
- 截图中的 `<tool_call name="search_code"><tool_input name="query" string="true">...</tool_input></tool_call>` 必须被识别为工具调用。
- 已识别、残缺或疑似工具协议的文本都不得进入 `answer.delta`。完整调用执行；残缺调用进入既有纠偏；未知工具保留可诊断错误而不是静默吞掉。

## 持久化与顺序

- `tool.started` 创建持久化 `ToolItem`，`tool.output` 用同一 `toolId` 更新其状态和输出。
- 工具项记录事件序号，确保搜索、读取、命令和修改按真实执行顺序恢复。
- 模型端点本身的合成 “Call model” 行不属于用户操作记录，不进入操作面板。
- 已完成操作在重新打开应用后仍可查看。

## 页面行为

- 每轮按 turnId 聚合。
- 原始思考使用现有可折叠面板。
- 操作记录使用独立可折叠面板：运行中默认展开；终态默认折叠，摘要显示“已执行 N 项操作”。
- 最终回答始终作为独立回答卡显示，不放进折叠面板。
- 操作失败显示在操作记录内；轮次失败信息仍可见。

## 验收

- 用截图中的真实 `tool_call/tool_input` 方言验证解析、执行和正文隔离。
- 验证工具事件持久化、顺序、运行态展开与终态折叠元数据。
- 验证原始思考、操作记录、最终回答不会互相混排。
- 完整单元测试、类型检查和打包检查通过；E2E 若受既有 Electron 启动环境阻塞，单独如实报告。
