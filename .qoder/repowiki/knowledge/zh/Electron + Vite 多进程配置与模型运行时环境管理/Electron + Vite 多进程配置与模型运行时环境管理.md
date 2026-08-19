---
kind: configuration_system
name: Electron + Vite 多进程配置与模型运行时环境管理
category: configuration_system
scope:
    - '**'
source_files:
    - forge.config.ts
    - vite.main.config.ts
    - vite.preload.config.ts
    - vite.agent.config.ts
    - vite.renderer.config.ts
    - src/main.ts
    - src/preload.ts
    - src/shared/domain.ts
    - src/shared/protocol.ts
    - src/shared/localQwenIdentity.ts
    - src/shared/reasoningConfiguration.ts
    - src/agent/localQwenProfile.ts
    - model-runtime/compose.yaml
    - model-runtime/.env.example
    - model-runtime/runtime-common.ps1
    - model-runtime/start-model.ps1
    - tests/e2e/live-model.spec.ts
---

## 1. 整体方案

本仓库是一个基于 Electron + Vite + Vue 的桌面应用，配置系统围绕三个层面组织：
- **构建期配置**：通过 `forge.config.ts` 统一编排 Electron Forge，使用 `@electron-forge/plugin-vite` 将主进程、预加载脚本、Agent 工作线程（worker）和渲染进程分别用独立的 Vite 配置文件打包。
- **运行期环境变量**：应用启动时读取 `process.env.PRIVATE_AI_DESKTOP_USER_DATA` 覆盖 Electron 的 `userData` 路径；测试套件通过 `PRIVATE_AI_LIVE_MODEL_BASE_URL` / `PRIVATE_AI_LIVE_MODEL_NAME` / `PRIVATE_AI_LIVE_MODEL_API_KEY` / `PRIVATE_AI_LIVE_MODEL_E2E` 等环境变量切换真实模型端点。
- **模型运行时配置**：独立位于 `model-runtime/`，使用 Docker Compose 的 profiles（`cpu` / `hybrid` / `gpu`）+ `.env` 文件驱动 llama.cpp server，PowerShell 脚本负责健康检查、端口占用检测、GPU 失败回退到 hybrid profile 等启动流程。

## 2. 关键文件与职责

| 文件 | 职责 |
|---|---|
| `forge.config.ts` | Electron Forge 打包入口，声明 ASAR、忽略规则、镜像源、Vite 多 entry 构建映射（main/preload/agent/renderer），并设置 `VITE_CONFIG_NATIVE_IGNORE_WARNING` |
| `vite.main.config.ts` | 主进程构建：外部化 `electron`、`node:path` |
| `vite.preload.config.ts` | 预加载脚本构建：外部化 `electron` |
| `vite.agent.config.ts` | Agent 工作线程构建：外部化 `electron`、`node:sqlite` |
| `vite.renderer.config.ts` | 渲染进程构建：启用 `@vitejs/plugin-vue` |
| `src/main.ts` | 主进程入口：读取 `PRIVATE_AI_DESKTOP_USER_DATA` 重写 userData 路径；通过 `utilityProcess.fork` 启动 `worker.js`，经 `MessageChannelMain` 通信；根据 `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` 决定开发/生产加载 URL |
| `src/preload.ts` | 安全桥接：通过 `contextBridge.exposeInMainWorld('desktop', ...)` 暴露 IPC 方法（snapshot、group、thread、turn、settings、modelProfile、language、theme 等） |
| `src/shared/domain.ts` | 共享类型定义：`AppSettings`、`ModelProfile`、`RuntimeSettingsInput`、`ModelCapabilities`、`TurnRecord`、`WorkspaceRecord` 等全部持久化/传输结构 |
| `src/shared/protocol.ts` | IPC 协议层：`DesktopRequest` 联合类型 + 严格的运行时校验函数（`isDesktopRequest`、`isAgentEvent`、`isModelProfileInput`、`isRuntimeSettingsInput` 等），所有跨进程消息必须通过此白名单 |
| `src/shared/localQwenIdentity.ts` | 内置本地 Qwen 身份常量：`LOCAL_QWEN_BASE_URL = 'http://127.0.0.1:8080/v1'`、`LOCAL_QWEN_MODEL = 'Qwen3.5-9B'`、`LOCAL_QWEN_PROFILE_ID = 'local-qwen35'` |
| `src/agent/localQwenProfile.ts` | 生成内置 Local Qwen Profile 的 `ModelProfileInput` |
| `src/shared/reasoningConfiguration.ts` | 推理配置合法性校验（禁止 `unsupported` inputMode 下开启 reasoning） |
| `model-runtime/compose.yaml` | Docker Compose 三 profile 服务（llama-cpu/hybrid/gpu），通过 `${LLAMA_PARALLEL}`、`${LLAMA_CTX_SIZE}`、`${LLAMA_N_PREDICT}`、`${LLAMA_GPU_LAYERS_HYBRID}` 注入参数 |
| `model-runtime/.env` / `.env.example` | 模型运行时环境变量模板 |
| `model-runtime/runtime-common.ps1` | PowerShell 公共库：断言模型工件 SHA-256、Docker daemon、端口 8080 可用性、Compose 调用、健康检查 `/health`、`/v1/models`、`/props`、`/slots` |
| `model-runtime/start-model.ps1` | 启动入口：按 gpu/hybrid/cpu profile 启动，GPU 失败时自动回退 hybrid，等待健康后输出 `http://127.0.0.1:8080` |
| `tests/e2e/live-model.spec.ts` | E2E 测试通过 `PRIVATE_AI_LIVE_*` 环境变量注入真实模型端点 |

## 3. 架构与设计约定

### 3.1 多进程隔离的配置边界
- 主进程、预加载脚本、Agent 工作线程、渲染进程各自拥有独立 Vite 构建配置，仅共享 `src/shared/*` 中的类型与常量。
- 主进程通过 `utilityProcess.fork` 启动 worker，并使用 `MessageChannelMain` 传递端口，而非共享内存或全局变量。
- 预加载脚本是唯一对渲染进程暴露的 IPC 通道，所有能力通过 `desktop.*` 命名空间暴露，严格遵循最小权限原则。

### 3.2 协议即配置契约
`src/shared/protocol.ts` 中集中定义了所有 IPC 请求/事件的结构，并通过运行时校验器强制约束字段取值范围（如 `contextMessageLimit` 必须在 1–200 之间、`reasoningDisplayMode` 必须是 `auto/raw/summary`、`ModelProviderType` 固定为 `openai-compatible`）。任何新增配置项都必须同时更新 `domain.ts` 类型与 `protocol.ts` 校验逻辑，否则 IPC 调用会被拒绝。

### 3.3 用户数据与持久化位置
- 默认由 Electron 管理 `userData` 目录。
- 可通过环境变量 `PRIVATE_AI_DESKTOP_USER_DATA` 在启动时覆盖，便于多实例/测试场景隔离。
- Agent 数据库路径固定为 `path.join(app.getPath('userData'), 'app.sqlite')`，随 userData 迁移。

### 3.4 模型运行时配置分层
- **静态常量**：`src/shared/localQwenIdentity.ts` 硬编码本地模型地址与标识。
- **环境变量**：`model-runtime/.env` 控制 llama.cpp 并发、上下文窗口、预测长度、GPU layers。
- **Compose Profiles**：`compose.yaml` 通过 `profiles: ["cpu"|"hybrid"|"gpu"]` 选择不同镜像与 GPU 层数（CPU 为 0，GPU 为 999，Hybrid 读自 `LLAMA_GPU_LAYERS_HYBRID`）。
- **PowerShell 启动脚本**：`start-model.ps1` 负责顺序校验（工件完整性 → Docker 可用 → 端口空闲 → 启动 → 健康检查），并在 GPU 启动失败时自动回退到 hybrid profile。

### 3.5 构建期常量注入
- 开发模式通过 Vite 注入 `MAIN_WINDOW_VITE_DEV_SERVER_URL` 指向 dev server。
- 生产模式通过 `MAIN_WINDOW_VITE_NAME` 定位打包后的 renderer 目录。
- `forge.config.ts` 中设置 `VITE_CONFIG_NATIVE_IGNORE_WARNING` 抑制原生模块警告。

## 4. 约定与约束

1. **IPC 白名单约束**：所有从渲染进程发起的配置变更必须通过 `desktop.*` 暴露的方法，最终落入 `src/shared/protocol.ts` 中定义的 `DesktopRequest` 联合类型；未声明的请求会被 `isDesktopRequest` 拒绝。
2. **配置值域约束**：`protocol.ts` 中的校验函数强制执行取值范围（如 `contextMessageLimit` 1–200、`reasoningDisplayMode` ∈ {auto, raw, summary}、`LanguagePreference` ∈ {zh-CN, en-US}、`ThemePreference` ∈ {system, light, dark}）。
3. **推理配置互斥约束**：`reasoningConfigurationIssue` 禁止 `inputMode === 'unsupported'` 且 `mode !== 'disabled'` 的组合。
4. **模型工件完整性约束**：`runtime-common.ps1` 要求 `models/` 下的两个 GGUF 文件长度与 SHA-256 完全匹配，否则抛出异常。
5. **端口独占约束**：启动前通过 TCP 监听 `127.0.0.1:8080` 检测端口占用，避免多个模型实例冲突。
6. **用户数据隔离约定**：通过 `PRIVATE_AI_DESKTOP_USER_DATA` 环境变量可覆盖默认 userData 路径，实现多实例/测试隔离。
7. **测试环境开关**：E2E 测试通过 `PRIVATE_AI_LIVE_MODEL_E2E=1` 启用真实模型测试，并通过 `PRIVATE_AI_LIVE_MODEL_BASE_URL` / `PRIVATE_AI_LIVE_MODEL_NAME` / `PRIVATE_AI_LIVE_MODEL_API_KEY` 注入目标端点。
8. **构建产物隔离**：Forge 配置中 `ignore: [/^\/(?!\.vite(?:\/|$)|package\.json$)/]` 排除源码目录，仅打包必要资源；ASAR 默认启用。

## 5. 适用性说明

该仓库存在完整的多层配置体系：Electron/Vite 构建配置、运行时环境变量、IPC 协议层强类型校验、Docker Compose + .env 的模型运行时配置、以及 PowerShell 启动脚本的环境装配与健康检查。因此本类别高度适用。