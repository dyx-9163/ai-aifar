---
kind: build_system
name: Electron + Vite + Forge 构建与打包体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - forge.config.ts
    - vite.main.config.ts
    - vite.preload.config.ts
    - vite.agent.config.ts
    - vite.renderer.config.ts
    - scripts/verify-package-contents.mjs
    - model-runtime/compose.yaml
    - model-runtime/start-model.ps1
    - model-runtime/runtime-common.ps1
---

## 1. 构建系统概览

本项目采用 **Electron 43** + **Vite 8** + **@electron-forge 7** 的三件套作为统一的构建、打包与分发方案。应用由四个独立的 Vite 构建目标组成：主进程 (`src/main.ts`)、预加载脚本 (`src/preload.ts`)、Agent Worker (`src/agent/worker.ts`) 以及渲染进程 (Vue 单文件组件，入口 `index.html`)。Forge 通过 `VitePlugin` 将这四个目标编排进一次 `pnpm package` / `make` 流程中。

版本管理集中在根 `package.json`：`name: private-ai-desktop`、`productName: Private AI Desktop`、`version: 0.1.0`，所有产物目录遵循 `out/Private AI Desktop-{platform}-{arch}` 命名约定（见 `scripts/verify-package-contents.mjs` 第 90–94 行）。

## 2. 关键文件与角色

| 文件 | 作用 |
|---|---|
| `package.json` | 定义 `start` / `build` / `package` / `make` / `test` / `typecheck` 等 npm scripts；声明 Electron、Vite、Playwright、Vitest 等依赖 |
| `forge.config.ts` | Forge 配置：ASAR 打包、忽略规则、镜像源 (`npmmirror.com/mirrors/electron/`)、MakerZIP 多平台产出、VitePlugin 四目标编排 |
| `vite.main.config.ts` | 主进程构建：将 `electron`、`node:path` 标记为 external |
| `vite.preload.config.ts` | 预加载构建：将 `electron` 标记为 external |
| `vite.agent.config.ts` | Agent Worker 构建：将 `electron`、`node:sqlite` 标记为 external |
| `vite.renderer.config.ts` | 渲染进程构建：启用 `@vitejs/plugin-vue` |
| `scripts/verify-package-contents.mjs` | 打包后校验：限制 ASAR 大小 ≤ 2 MiB、白名单仅允许 `package.json` 和 `.vite/*`、强制包含 `main.js`/`preload.js`/`worker.js`/`renderer/main_window/index.html`、禁止外层目录泄露 `.git`/`docs`/`model-runtime`/`models`/`node_modules`/`.env`/`.gguf` 等 |
| `model-runtime/compose.yaml` | 模型运行时 Docker Compose：`cpu` / `hybrid` / `gpu` 三个 profile，均暴露 OpenAI 兼容接口于 `127.0.0.1:8080` |
| `model-runtime/start-model.ps1` / `runtime-common.ps1` | PowerShell 启动器：校验模型工件 SHA-256、端口占用、Docker 守护进程，支持 GPU 失败自动回退到 hybrid profile |

## 3. 架构与约定

### 3.1 多目标 Vite 构建
每个 Electron 子进程都有独立 Vite 配置，通过 `rollupOptions.external` 避免将 Node/Electron 原生模块打入 bundle，确保产物可直接被 Node 运行。

### 3.2 Forge 打包管线
`pnpm package` → `electron-forge package` → 调用 `scripts/verify-package-contents.mjs` 对 `out/` 下的产物做内容审计。`pnpm make` 直接生成可分发的 ZIP 包（`MakerZIP` 同时产出 `darwin`、`linux`、`win32` 三平台）。

### 3.3 ASAR 白名单策略
`verify-package-contents.mjs` 使用正则 `^(?:package\.json|\.vite(?:\/|$))` 严格限制 ASAR 内仅允许应用源码与 Vite 构建产物，任何额外文件都会导致构建失败。这保证了最终安装包体积可控且不含源码树。

### 3.4 模型运行时生命周期
- 通过 `docker compose --profile <cpu|hybrid|gpu>` 启动 llama.cpp 服务，挂载 `../models/*.gguf` 只读卷。
- `start-model.ps1` 在 Windows 上提供统一入口：先校验模型文件大小与 SHA-256，再尝试 GPU profile，若检测到 OOM/CUDA 错误则自动降级到 hybrid profile。
- 健康检查通过 `/health`、`/v1/models`、`/props`、`/slots` 多个端点验证槽位数量一致性。

### 3.5 测试与类型检查
- 单元测试：`vitest run tests/*.test.ts`（`package.json` 中硬编码了完整测试清单）。
- E2E：`pnpm test:e2e` 先执行 `pnpm package` 打包，再用 Playwright 跑 `tests/e2e/app.spec.ts`。
- 类型检查：`vue-tsc --noEmit && tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.type-tests.json`。

## 4. 约定与约束

- **构建命令约定**：开发用 `pnpm start`，生产打包用 `pnpm package`（等价于 `electron-forge package && node scripts/verify-package-contents.mjs`），跨平台分发用 `pnpm make`。
- **ASAR 大小上限**：`MAX_ASAR_BYTES = 2 * 1024 * 1024`（2 MiB），超出即抛错终止构建。
- **外层包禁止项**：`.electron-cache`、`.git`、`.github`、`.superpowers`、`app.asar.unpacked`、`coverage`、`docs`、`model-runtime`、`models`、`node_modules`、`playwright-report`、`src`、`test-results`、`.env*`、`*.gguf` 不得出现在 `resources/` 外层。
- **必须存在的 ASAR 条目**：`package.json`、`.vite/build/main.js`、`.vite/build/preload.js`、`.vite/build/worker.js`、`.vite/renderer/main_window/index.html`。
- **Electron 下载镜像**：默认使用 `https://npmmirror.com/mirrors/electron/` 以加速国内网络环境。
- **模型工件完整性**：`Qwen_Qwen3.5-9B-Q4_K_M.gguf` 与 `mmproj-Qwen_Qwen3.5-9B-bf16.gguf` 必须存在且长度、SHA-256 与 `runtime-common.ps1` 中硬编码值完全一致。
- **端口独占**：127.0.0.1:8080 同一时刻只能由一个 `ai-aifar-model` 项目容器持有，启动前会检测并清理已有所有权。
- **GPU 自动回退**：当 GPU profile 启动失败且日志中出现 `out of memory`、`cuda.*error/fail`、`failed to load`、`model.*load.*fail` 时，脚本会自动 down 掉 GPU 容器并以 hybrid profile 重试一次。

该体系将 Electron 桌面应用的编译、打包、校验与本地模型运行时启动整合在同一套 npm scripts 之下，通过 Forge 插件化扩展 Vite，并通过独立的 PowerShell 脚本管理 Docker Compose 驱动的推理服务。