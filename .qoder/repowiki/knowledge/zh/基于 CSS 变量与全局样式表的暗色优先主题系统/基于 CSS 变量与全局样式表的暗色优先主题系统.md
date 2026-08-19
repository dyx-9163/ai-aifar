---
kind: frontend_style
name: 基于 CSS 变量与全局样式表的暗色优先主题系统
category: frontend_style
scope:
    - '**'
source_files:
    - src/renderer/styles/theme.css
    - src/renderer/styles/app.css
    - src/renderer/App.vue
    - vite.renderer.config.ts
---

## 1. 采用的样式体系

该 Electron + Vue 渲染进程采用**纯 CSS + CSS 自定义属性（CSS Variables）**的样式方案，没有引入任何 UI 组件库、CSS-in-JS 或原子化 CSS（如 Tailwind）。样式通过 Vite 在渲染进程构建时以普通 CSS 文件形式加载，`vite.renderer.config.ts` 仅启用 `@vitejs/plugin-vue`，未配置额外的 CSS 预处理或 PostCSS 插件。

## 2. 核心文件与职责

- `src/renderer/styles/theme.css`：集中定义设计令牌（design tokens），通过 `:root` 和 `:root[data-theme='light']` 两套变量实现明/暗主题切换。包含背景、面板层级（`--bg`、`--panel`、`--panel-raised`、`--panel-soft`）、边框、文字色（`--text`、`--muted`、`--subtle`）、强调色（`--accent`、`--accent-strong`）以及语义色（`--success`、`--danger`、`--warning`）和阴影。
- `src/renderer/styles/app.css`：应用级全局样式，覆盖 `*`、`body`，并定义桌面端三栏布局（侧边栏 + 对话区 + 检查器）及所有组件样式（Sidebar、Conversation、Inspector、SettingsView 等），包括消息气泡、Markdown 渲染、代码块、附件、进度指示、Composer 输入框等。
- `src/renderer/App.vue`：运行时主题切换入口，通过 `document.documentElement.dataset.theme = 'light' | 'dark'` 切换 `data-theme` 属性，驱动 `theme.css` 中的主题变量。

## 3. 架构与设计约定

- **暗色优先**：默认 `color-scheme: dark`，浅色模式需显式设置 `data-theme='light'`。
- **设计令牌集中管理**：所有颜色、阴影均通过 CSS 变量引用，组件样式不直接写死颜色值，保证主题一致性。
- **全局样式组织**：所有样式集中在 `styles/` 目录下，按 `theme.css`（令牌）+ `app.css`（布局与组件）拆分；Vue SFC 内不使用 `<style scoped>`，全部依赖全局类名。
- **布局策略**：使用 CSS Grid 定义桌面端三栏布局（`desktop-shell`），列宽通过 `minmax()` 自适应；设置视图通过 `.settings-shell` 修改 grid-template-columns 为两栏。
- **响应式**：未使用媒体查询进行断点适配，而是通过 `minmax()` 和 `fit-content`、`min(880px, 100%)` 等弹性约束让内容在不同窗口宽度下自适应。
- **交互状态**：hover/focus/active 状态统一通过 CSS 伪类 + 变量组合表达，过渡动画统一使用 `140ms ease` 的 `background-color`、`border-color`、`color` 过渡。
- **动画**：使用 `@keyframes progress-pulse` 实现运行中状态的脉冲光点效果。
- **Markdown 渲染**：通过 `.markdown-body` 类对 Markdown 输出进行样式定制，包含标题、列表、代码块、行内代码的统一排版。

## 4. 约束与规范

- **主题切换必须通过 `data-theme` 属性**：由 `App.vue` 维护，禁止在其他位置直接操作 DOM 主题。
- **颜色值不得硬编码**：组件样式应引用 `var(--xxx)` 而非十六进制颜色字面量，以确保主题切换生效。
- **样式命名采用 BEM 风格但无严格前缀**：类名如 `.sidebar-pane`、`.conversation-pane`、`.message-row.role-user` 体现“区块 + 元素 + 修饰符”思想，但未强制使用双下划线或特定命名空间。
- **字体栈统一**：正文使用 `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacFont, "Segoe UI", sans-serif`，代码使用 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`。
- **圆角与间距一致**：按钮、卡片、输入框统一使用 `8px` 圆角，部分胶囊形控件使用 `999px`；间距以 `6/8/10/12/16/20/26` 等固定步长组织。
- **Vite 构建不处理 SCSS/Tailwind**：项目未安装 `sass`、`tailwindcss` 等依赖，所有样式均为原生 CSS。