---
kind: dependency_management
name: 基于 pnpm + Electron Forge 的依赖管理与模型运行时编排
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-lock.yaml
    - pnpm-workspace.yaml
    - model-runtime/compose.yaml
    - model-runtime/.env
    - scripts/verify-package-contents.mjs
---

## 1. 使用的系统/方法

本项目采用 **pnpm** 作为 Node.js 依赖管理器，配合 **Electron Forge**（v7）进行 Electron 应用的构建与打包。依赖声明集中在根目录 `package.json`，通过 `pnpm-lock.yaml` 锁定版本，使用 `pnpm-workspace.yaml` 配置工作区行为。

- 包管理器：pnpm（单仓库，非 monorepo workspace，仅启用 hoisted 节点链接器）
- 构建工具链：Vite + Vue 3（渲染进程）、TypeScript、Vue TSC
- 打包工具：@electron-forge/cli v7，配合 @electron-forge/plugin-vite、@electron-forge/maker-zip、@electron-forge/plugin-auto-unpack-natives
- 测试框架：vitest（单元测试）+ Playwright（E2E 测试）
- 模型运行时：Docker Compose 管理 llama.cpp 服务（CPU / Hybrid / GPU 三种 profile），镜像来自 ghcr.io/ggml-org/llama.cpp

## 2. 关键文件与位置

| 文件 | 作用 |
|---|---|
| `package.json` | 唯一依赖清单，声明 runtime 依赖（vue）与 devDependencies（Electron、Forge、Vite、TS、测试工具等） |
| `pnpm-lock.yaml` | pnpm 锁文件，冻结所有依赖树版本 |
| `pnpm-workspace.yaml` | 工作区配置：nodeLinker=hoisted，允许 better-sqlite3 和 electron 的原生构建，并通过 overrides 强制降级 @electron/rebuild 到 4.0.4 |
| `model-runtime/compose.yaml` | Docker Compose 定义三个模型服务 profile（cpu/hybrid/gpu），挂载本地 `.gguf` 模型文件 |
| `model-runtime/.env` | 模型运行时环境变量（并行数、上下文大小、预测长度、GPU layers） |
| `scripts/verify-package-contents.mjs` | 打包后产物校验脚本，确保发布包内容正确 |
| `.electron-cache/d4f166ee.../electron-v43.4.0-win32-x64.zip` | Electron 二进制缓存（由 Forge 自动下载并缓存） |

## 3. 架构与约定

### 依赖分层
- **运行时依赖**：仅 `vue ^3.5.41` 一个生产依赖，保持应用体积最小化。
- **开发依赖**：包含完整的 Electron 桌面栈（electron ^43.4.0、@electron-forge/*、vite、typescript、vue-tsc）、测试栈（vitest、playwright）以及打包辅助（@electron/asar）。
- **原生模块处理**：通过 `@electron-forge/plugin-auto-unpack-natives` 在打包时自动处理原生模块；`pnpm-workspace.yaml` 显式 `allowBuilds: [better-sqlite3, electron]` 允许这些需要编译的原生包在构建阶段重新编译。

### 版本策略
- 所有依赖使用 `^` 语义化版本范围，但通过 `pnpm-lock.yaml` 锁定实际安装版本。
- 通过 `overrides` 强制将 `@electron/rebuild` 固定为 `4.0.4`，注释说明原因是 Forge 7 允许 rebuild 3.x，但其 Git 依赖在私有网络不可达，降级到 4.x 可继续使用 registry 包。

### 模型运行时依赖
- 模型推理不通过 npm 管理，而是通过 Docker Compose 拉取官方 `ghcr.io/ggml-org/llama.cpp:server*` 镜像。
- 模型权重文件（`.gguf`）直接放在 `models/` 目录并通过 volume 只读挂载进容器。
- 通过 `profiles`（cpu/hybrid/gpu）切换不同硬件加速模式，端口统一映射到 `127.0.0.1:8080`。

### 构建与验证流程
- `pnpm package` → `electron-forge package` → `scripts/verify-package-contents.mjs` 校验产物。
- E2E 测试通过 `pnpm test:e2e` 先执行 `pnpm package` 再运行 Playwright。

## 4. 约定与约束

- **单一依赖入口**：所有 Node.js 依赖仅在根 `package.json` 中声明，无子包或子模块的独立 manifest。
- **锁文件必须提交**：`pnpm-lock.yaml` 存在于仓库根，保证依赖树可复现。
- **原生模块需显式授权**：`pnpm-workspace.yaml` 中的 `allowBuilds` 白名单机制要求新增需要编译的原生依赖时必须显式添加。
- **Electron 版本与 Forge 版本绑定**：electron ^43.4.0 与 @electron-forge/* ^7.11.2 配套使用，且通过 overrides 锁定 @electron/rebuild 版本以规避私有网络问题。
- **模型运行时与环境变量隔离**：模型相关配置通过 `model-runtime/.env` 管理，不混入应用代码；Compose profiles 用于区分部署环境。
- **私有网络兼容**：通过 pnpm overrides 降级 @electron/rebuild 解决私有网络下 Git 依赖不可达的问题，这是项目明确记录的约束处理方式。
- **无私有 npm registry 配置**：未发现 `.npmrc`、`.pnpmrc`、`NPM_CONFIG_REGISTRY` 等私有源配置，依赖全部来自公共 registry（npmjs.org）及 GitHub Container Registry（ghcr.io）。