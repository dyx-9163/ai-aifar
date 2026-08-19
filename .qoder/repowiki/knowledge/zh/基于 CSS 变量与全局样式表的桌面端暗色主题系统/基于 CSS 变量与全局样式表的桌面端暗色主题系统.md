---
kind: frontend_style
name: 基于 CSS 变量与全局样式表的桌面端暗色主题系统
category: frontend_style
scope:
    - '**'
source_files:
    - src/renderer/styles/theme.css
    - src/renderer/styles/app.css
    - src/renderer/main.ts
    - index.html
    - vite.renderer.config.ts
---

## 1. 采用的体系/方法
- 纯 CSS + CSS 自定义属性（CSS Variables）的轻量级设计令牌系统，未引入任何 UI 组件库、CSS-in-JS 或原子化框架（如 Tailwind）。
- 通过 `:root` 与 `[data-theme='light']` 实现明/暗双主题切换，默认使用 `color-scheme: dark`。
- 样式以**全局 CSS 文件**形式组织在 `src/renderer/styles/`，由渲染进程入口 `src/renderer/main.ts` 统一导入：先 `theme.css`（定义 token），再 `app.css`（应用 token 并定义布局/组件样式）。
- 没有发现 Vue `<style scoped>` 的使用——所有组件样式均通过 BEM 风格的全局类名（如 `.sidebar-pane`、`.message-row.role-user`、`.settings-card`）组织。

## 2. 关键文件
- `src/renderer/styles/theme.css`：设计令牌集中地，定义 `--bg` / `--panel` / `--panel-raised` / `--border` / `--text` / `--muted` / `--subtle` / `--accent` / `--accent-strong` / `--success` / `--danger` / `--warning` / `--shadow` 等语义化变量，并提供暗/亮两套值。
- `src/renderer/styles/app.css`：全局样式主文件（约 1500 行），包含 reset、三栏桌面布局（`.desktop-shell`）、侧边栏（`.sidebar-pane`）、对话时间线（`.timeline`、`.message-row`）、Composer 输入区（`.composer`）、Inspector（`.inspector-pane`）、Settings 视图（`.settings-view`）、Markdown 渲染样式（`.markdown-body`）、响应式断点（`@media (max-width: 1040px)`、`720px`）以及 `prefers-reduced-motion` 无障碍适配。
- `src/renderer/main.ts`：唯一样式入口，顺序导入 `theme.css` → `app.css`，确保变量先于使用。
- `index.html`：CSP 允许 `'unsafe-inline'` style-src，使内联样式和 Vite 开发模式下的热更新样式生效。

## 3. 架构与约定
- **设计令牌优先**：颜色、阴影、圆角等视觉属性全部走 CSS 变量；组件样式只引用变量，不硬编码色值。新增主题只需扩展 `theme.css` 中的 `:root[data-theme='...']` 块。
- **BEM 风格命名**：类名采用 `block__element--modifier` 的简化变体，如 `.thread-row.active`、`.runtime-menu-trigger`、`.capability-status[data-state="connected"]`，通过状态属性（`[open]`、`[data-copy-state="copied"]`、`[data-state=...]`）表达交互态。
- **布局策略**：主界面使用 CSS Grid 三栏（sidebar | conversation | inspector），通过 `.desktop-shell.settings-shell` 在设置页切换为两栏；移动端通过 `@media` 折叠右侧面板、隐藏文本标签。
- **色彩语义**：`--accent` / `--accent-strong` 用于主操作与活跃态；`--success` / `--warning` / `--danger` 用于状态反馈；大量使用 `color-mix(in srgb, ...)` 派生半透明叠加效果，避免额外变量膨胀。
- **字体与排版**：全局字体栈 `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacFont, "Segoe UI", sans-serif`；代码/日志区域使用 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`。
- **动画与可访问性**：统一的 `140ms ease` 过渡时长；`progress-pulse` 关键帧用于加载指示；`@media (prefers-reduced-motion: reduce)` 下禁用所有 transition。

## 4. 约定与约束
- **样式组织**：新增页面/组件样式必须添加到 `src/renderer/styles/app.css` 中对应区块，不得在 Vue SFC 内写 `<style scoped>`（当前仓库未发现 scoped 样式）。
- **主题扩展**：新增主题需复制 `:root[data-theme='light']` 结构并在根元素上设置对应 data 属性；不要直接修改默认 `:root` 的值。
- **颜色使用**：禁止在组件样式中硬编码十六进制颜色，应复用 `theme.css` 中已定义的语义变量；仅当需要临时调试时才例外。
- **响应式断点**：现有断点为 `1040px`（隐藏 Inspector、合并设置列）和 `720px`（窄屏折叠侧边栏文字），新增布局调整应沿用这两个断点而非新建任意宽度。
- **CSP 限制**：生产环境 CSP 仅允许 `'self'` 与 `'unsafe-inline'` 样式源，因此外部样式表需经 Vite 打包注入，不能依赖远程 CDN 的 `<link>` 样式。
- **无构建期样式转换**：Vite 配置 `vite.renderer.config.ts` 仅启用 `@vitejs/plugin-vue`，未配置 PostCSS、Sass/Less 预处理器，因此样式必须是标准 CSS。
- **状态驱动样式**：交互态通过 CSS 伪类（`:hover`、`:focus`）与 HTML 数据属性（`[data-copy-state]`、`[data-state]`、`[open]`）控制，JS 只负责切换属性，不负责写入样式。