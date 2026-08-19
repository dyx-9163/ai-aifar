---
kind: external_dependency
name: Electron + Electron Forge 桌面应用框架
slug: electron
category: external_dependency
category_hints:
    - framework_behavior
scope:
    - '**'
source_files:
    - package.json
    - README.md
    - forge.config.ts
---

本项目使用 Electron 43 作为跨平台桌面运行时，通过 @electron-forge/cli（配合 vite、maker-zip、plugin-auto-unpack-natives）完成构建与打包。架构上 Renderer（Vue 3）、Main、Preload、Utility Process（Agent 运行时）四进程分离：Renderer 仅负责 UI，不直接访问文件系统/Shell/SQLite；Preload 暴露最小 window.desktop API；Main 管理窗口生命周期与安全策略；Utility Process 承载调度、模型调用、SQLite 持久化与 Agent 循环。E2E 测试通过 playwright 启动打包后的 Windows 可执行文件进行验收。Forge 缓存位于 OS 临时目录 private-ai-desktop-electron-cache，产物输出到 out/，ASAR 限制为 package.json 与生产 .vite/** 条目（2 MiB 上限），SDD/cache/source/tests/docs/model/runtime/local-env 等敏感内容被拒绝入包。