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
    - pnpm-workspace.yaml
    - tsconfig.json
    - model-runtime/compose.yaml
    - model-runtime/start-model.ps1
    - model-runtime/runtime-common.ps1
---

## 1. 构建系统概览

本项目采用 **Electron + Vite + Electron Forge** 的三件套构建方案：Vite 负责各进程源码编译，Electron Forge 编排构建、打包与分发，最终产出跨平台安装包。版本管理集中在 `package.json`（`version: "0.1.0"`），通过 pnpm 工作区管理依赖。

## 2. 核心构建流程

### 2.1 多入口构建（Forge + Vite）
`forge.config.ts` 通过 `@electron-forge/plugin-vite` 声明四个独立构建产物：
- **主进程**：`src/main.ts` → `.vite/build/main.js`
- **预加载脚本**：`src/preload.ts` → `.vite/build/preload.js`
- **Agent 工作线程**：`src/agent/worker.ts` → `.vite/build/worker.js`
- **渲染进程**：`main_window` 页面 → `.vite/renderer/main_window/index.html`

每个入口对应独立的 Vite 配置文件（`vite.main.config.ts`、`vite.preload.config.ts`、`vite.agent.config.ts`、`vite.renderer.config.ts`），分别控制 Rollup external 模块（如 `electron`、`node:path`、`node:sqlite`）和 Vue 插件。

### 2.2 打包策略
`forge.config.ts` 中启用 `asar: true`，并通过 `ignore: [/^\/(?!\.vite(?:\/|$)|package\.json$)/]` 仅将 `.vite/build` 和根 `package.json` 打入 ASAR，其余源码被排除。下载源配置为国内镜像 `https://npmmirror.com/mirrors/electron/`，缓存目录位于 `os.tmpdir()/private-ai-desktop-electron-cache`。

### 2.3 目标平台
使用 `MakerZIP` 同时生成 `darwin`、`linux`、`win32` 三个平台的 ZIP 包，由 `pnpm package`（即 `electron-forge package && node scripts/verify-package-contents.mjs`）触发。

## 3. 产物校验（scripts/verify-package-contents.mjs）
该脚本是构建流水线中的强制质量门控，在 `pnpm package` 后自动执行，包含两类约束：

- **ASAR 内校验**：限制最大 2MB；仅允许 `package.json` 和 `.vite/*` 路径；必须包含 `main.js`、`preload.js`、`worker.js`、`renderer/main_window/index.html`。
- **外层目录校验**：禁止 `.electron-cache`、`.git`、`.github`、`.superpowers`、`app.asar.unpacked`、`coverage`、`docs`、`model-runtime`、`models`、`node_modules`、`playwright-report`、`src`、`test-results`、`tests` 等目录出现在输出包顶层；禁止 `.env*` 文件和 `.gguf` 模型文件被打包进应用；必须存在 `resources/app.asar`。

## 4. TypeScript 与类型检查
根 `tsconfig.json` 针对渲染端（`src/renderer/**`、`src/shared/**`）启用严格模式、ES2022 target、Bundler 模块解析；另有 `tsconfig.node.json` 和 `tsconfig.type-tests.json` 分别用于 Node 端与类型测试。`pnpm typecheck` 依次运行 `vue-tsc` 与两个 `tsc --noEmit` 任务。

## 5. 测试构建集成
- 单元测试：`pnpm test` 显式列出 22 个 Vitest 测试文件（覆盖 agent、protocol、database、modelRuntime 等），不依赖 glob 扫描。
- E2E 测试：`pnpm test:e2e` 先执行 `pnpm package` 打包完整应用，再运行 Playwright `tests/e2e/app.spec.ts`。
- 测试产物输出到 `test-results/`，由 `verify-package-contents.mjs` 明确禁止其进入发布包。

## 6. 本地模型运行时构建（Docker Compose）
`model-runtime/compose.yaml` 定义三个 profile（`cpu`、`hybrid`、`gpu`），均基于 `ghcr.io/ggml-org/llama.cpp:server` 镜像，挂载 `../models/*.gguf` 并以 OpenAI 兼容接口暴露于 `127.0.0.1:8080`。PowerShell 脚本 `start-model.ps1`、`status-model.ps1`、`stop-model.ps1`、`verify-model.ps1` 封装了 Docker Compose 调用、端口占用检测、GPU 失败回退（从 gpu 自动降级到 hybrid）、健康检查（`/health`、`/v1/models`、`/props`、`/slots`）及模型工件 SHA-256 校验。

## 7. 依赖与重建策略
`pnpm-workspace.yaml` 中 `nodeLinker: hoisted` 扁平化依赖；`allowBuilds` 放行 `better-sqlite3` 和 `electron` 的原生构建；通过 `overrides` 将 `@electron/rebuild` 固定到 4.0.4，以绕过 Forge 7 默认 rebuild 3.x 对 Git 依赖的不可达问题（适配私有网络环境）。

## 8. 关键约定与约束
- 所有进程源码必须经 Vite 构建，产物统一输出至 `.vite/build/`，由 Forge 读取。
- ASAR 体积上限 2MB，超出或包含 forbidden 条目会直接中断构建。
- 发布包不得包含任何开发辅助目录（`.git`、`docs`、`tests`、`model-runtime`、`models` 等）。
- 模型运行时必须通过 Docker Compose 启动，且只能有一个项目名为 `ai-aifar-model` 的容器独占 `127.0.0.1:8080`。
- Electron 二进制下载强制走 npmmirror 镜像，缓存落临时目录以避免污染仓库。
- 版本号仅在 `package.json` 维护，无 CI 自动 bump 逻辑可见。