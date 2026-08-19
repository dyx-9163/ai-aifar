---
kind: dependency_management
name: pnpm + Electron Forge 依赖管理与版本锁定
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-lock.yaml
    - pnpm-workspace.yaml
    - forge.config.ts
    - scripts/verify-package-contents.mjs
    - model-runtime/compose.yaml
---

## 1. 使用的系统/方案

本仓库采用 **pnpm** 作为 Node.js 依赖管理器，配合 **Electron Forge**（v7）进行构建与打包。依赖声明集中在根目录的 `package.json` 中，通过 `pnpm-lock.yaml` 进行精确版本锁定，确保跨环境可重复安装。

- 包管理器：pnpm（workspace 模式，但当前仅单包）
- 工作区配置：`pnpm-workspace.yaml` 启用 `nodeLinker: hoisted`，将依赖扁平化到根 `node_modules`
- 构建工具链：Vite（多入口：main、renderer、preload、agent），由 `@electron-forge/plugin-vite` 集成
- 打包分发：Electron Forge 7，使用 `@electron-forge/maker-zip` 生成 zip 产物
- 原生模块重建：通过 `@electron/rebuild` 处理 `better-sqlite3`、`electron` 等原生依赖

## 2. 关键文件

- `package.json`：唯一依赖清单，区分 `dependencies`（运行时 `vue`）与 `devDependencies`（构建/测试/打包工具链）
- `pnpm-lock.yaml`：锁定的依赖树，保证安装一致性
- `pnpm-workspace.yaml`：工作区行为配置，包含对 `@electron/rebuild` 的强制覆盖
- `forge.config.ts`：Electron Forge 构建配置（主进程、渲染进程、预加载脚本、worker 入口）
- `scripts/verify-package-contents.mjs`：打包后校验脚本，在 `package` 命令末尾执行，验证产物完整性
- `model-runtime/compose.yaml`：模型运行时的 Docker Compose 定义（独立于 Node 依赖管理）

## 3. 架构与约定

### 依赖分层
- 运行时依赖极少：仅 `vue` 一个生产依赖，其余均为开发期工具链
- 构建依赖集中：Vite、TypeScript、Vue 类型检查、Electron、Playwright、Vitest 全部在 `devDependencies`
- 原生模块通过 pnpm 的 `allowBuilds` 白名单显式允许 `better-sqlite3` 和 `electron` 的原生编译

### 版本策略
- 所有依赖使用 `^` 语义化版本前缀，允许小版本升级
- 通过 `pnpm-lock.yaml` 锁定实际解析出的精确版本
- 针对网络可达性问题，在 `pnpm-workspace.yaml` 中使用 `overrides` 将 `@electron/rebuild` 从 Git 依赖降级为固定版本 `4.0.4`，以绕过私有网络无法访问 Git 的问题

### 构建产物校验
- `package` 脚本顺序：先 `electron-forge package`，再执行 `scripts/verify-package-contents.mjs` 校验打包内容
- 该脚本作为依赖/资源完整性检查点，防止遗漏或错误打包

### 模型运行时隔离
- 本地 Qwen3.5-9B 模型运行时完全独立于 Node 依赖体系，通过 Docker Compose (`model-runtime/compose.yaml`) 启动 llama.cpp server，暴露 OpenAI 兼容接口
- 模型二进制文件（`.gguf`）位于 `models/` 目录，不纳入 npm/pnpm 依赖管理

## 4. 约定与约束

- **单一依赖源**：所有 Node.js 依赖通过 `package.json` 声明，无 `yarn.lock`、`package-lock.json`、`Gemfile` 等其他语言依赖清单
- **无 vendoring**：未使用 `vendor/` 或 `third_party/` 目录存放源码；所有第三方代码经 pnpm 安装至 `node_modules`
- **无私有 npm registry**：仓库中未发现 `.npmrc`、`NPM_TOKEN`、`PRIVATE_REGISTRY` 等私有注册表配置，默认使用公共 npm 源
- **原生模块白名单**：只有 `better-sqlite3` 和 `electron` 被显式允许在 pnpm 下构建原生扩展
- **版本锁定强制**：提交 `pnpm-lock.yaml` 是保证一致性的约束，CI/CD 应基于锁文件安装
- **构建脚本内联**：测试、打包、类型检查等命令直接写在 `package.json` 的 `scripts` 字段中，未拆分为独立 Makefile 或 shell 脚本（除 `verify-package-contents.mjs` 外）
- **Electron Forge 插件约束**：通过 `@electron-forge/plugin-auto-unpack-natives` 自动处理原生模块，避免手动配置 unpack 规则