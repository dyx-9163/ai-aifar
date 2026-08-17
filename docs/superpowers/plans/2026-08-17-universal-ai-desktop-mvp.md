# Universal AI Desktop MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable Electron desktop client with a Codex-inspired three-pane UI, a TypeScript Utility Process agent, SQLite persistence, streamed task events, approval interaction, and light/dark themes.

**Architecture:** Electron owns the desktop lifecycle and starts a Node-enabled Utility Process. A sandboxed Vue renderer communicates only through a typed preload bridge; the Utility Process owns conversations, demo agent execution, and SQLite. The MVP uses a deterministic demo provider so it runs without an API key while preserving the event and provider boundaries needed for a later OpenAI-compatible endpoint.

**Tech Stack:** Electron, Electron Forge, Vue 3, TypeScript, Vite, Node `node:sqlite`, Vitest, Playwright, CSS Variables.

## Global Constraints

- Use TypeScript for Renderer, Main, Preload, and Agent Runtime.
- Do not add Go, Rust, Python, JSON-RPC, gRPC, Redis, PostgreSQL, NATS, Tailwind, or an ORM.
- Renderer must use `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- Renderer must not access filesystem, shell, SQLite, environment variables, or secrets directly.
- Use Electron IPC between Renderer and Main, and MessagePort between Main and Utility Process.
- Use one `app.sqlite` database in WAL mode.
- UI uses Codex-style information hierarchy with original color tokens, icons, copy, and branding.
- MVP executes no real destructive tools; approval interactions operate on deterministic demo tool events.
- Initialize Git because the current workspace is not a repository, then commit each independently working task.

---

## File Structure

```text
package.json                         scripts and dependencies
forge.config.ts                     Forge makers, Vite entries, native unpacking
vite.main.config.ts                 Main-process Vite config
vite.preload.config.ts              Preload Vite config
vite.agent.config.ts                Utility-process Vite config
vite.renderer.config.ts             Vue renderer Vite config
tsconfig.json                       shared TypeScript configuration
index.html                          renderer entry HTML
src/shared/protocol.ts              request/event types and type guards
src/shared/domain.ts                thread, item, approval, and settings types
src/main.ts                         Electron lifecycle and secure BrowserWindow
src/preload.ts                      narrow contextBridge API
src/agent/worker.ts                 Utility Process entry and message dispatch
src/agent/database.ts               SQLite schema and repositories
src/agent/demoAgent.ts              deterministic streamed demo behavior
src/renderer/main.ts                Vue entry
src/renderer/App.vue                application shell and orchestration
src/renderer/types.d.ts              preload API window typing
src/renderer/composables/useApp.ts  client state and IPC subscriptions
src/renderer/components/Sidebar.vue task/workspace navigation
src/renderer/components/Conversation.vue messages and activity timeline
src/renderer/components/Composer.vue prompt composer
src/renderer/components/Inspector.vue plan, changes, and approvals
src/renderer/styles/theme.css        light/dark tokens
src/renderer/styles/app.css          three-pane layout and responsive rules
tests/protocol.test.ts               protocol guard tests
tests/database.test.ts               SQLite repository tests
tests/demoAgent.test.ts              stream and approval tests
tests/renderer-state.test.ts         reducer/state transition tests
tests/e2e/app.spec.ts                packaged desktop smoke path
```

### Task 1: Secure Electron and Vue Skeleton

**Files:**
- Create: `package.json`
- Create: `forge.config.ts`
- Create: `vite.main.config.ts`
- Create: `vite.preload.config.ts`
- Create: `vite.agent.config.ts`
- Create: `vite.renderer.config.ts`
- Create: `tsconfig.json`
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/preload.ts`
- Create: `src/agent/worker.ts`
- Create: `src/renderer/main.ts`
- Create: `src/renderer/App.vue`
- Create: `src/renderer/types.d.ts`

**Interfaces:**
- Produces: a packaged Electron window and `window.desktop` preload surface.
- Produces: a Vite-built `worker.js` Utility Process entry.

- [ ] **Step 1: Initialize Git and install the minimal dependencies**

Run:

```powershell
git init
pnpm add vue
pnpm add -D electron @electron-forge/cli @electron-forge/maker-zip @electron-forge/plugin-vite @electron-forge/plugin-auto-unpack-natives @vitejs/plugin-vue vite typescript vue-tsc vitest @types/node playwright
```

Expected: `package.json` and `pnpm-lock.yaml` resolve one Electron/Node toolchain.

- [ ] **Step 2: Write the initial typecheck smoke test**

Create `src/renderer/types.d.ts` with:

```ts
export {};

declare global {
  interface Window {
    desktop: {
      health(): Promise<{ ok: true; version: string }>;
    };
  }
}
```

Run: `pnpm typecheck`

Expected: FAIL because project configs and preload implementation do not exist.

- [ ] **Step 3: Implement Forge, Vite, Main, Preload, Agent, and Vue entries**

Configure three Forge Vite build entries:

```ts
build: [
  { entry: 'src/main.ts', config: 'vite.main.config.ts' },
  { entry: 'src/preload.ts', config: 'vite.preload.config.ts' },
  { entry: 'src/agent/worker.ts', config: 'vite.agent.config.ts' },
]
```

Create the BrowserWindow with:

```ts
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
}
```

Expose only:

```ts
contextBridge.exposeInMainWorld('desktop', {
  health: () => ipcRenderer.invoke('app:health'),
});
```

- [ ] **Step 4: Verify typecheck and production build**

Run:

```powershell
pnpm typecheck
pnpm build
```

Expected: both commands exit 0 and `.vite/build/worker.js` exists.

- [ ] **Step 5: Commit**

```powershell
git add package.json pnpm-lock.yaml forge.config.ts vite.*.config.ts tsconfig.json index.html src
git commit -m "feat: scaffold secure electron desktop"
```

### Task 2: Typed Desktop Protocol

**Files:**
- Create: `src/shared/domain.ts`
- Create: `src/shared/protocol.ts`
- Create: `tests/protocol.test.ts`
- Modify: `src/renderer/types.d.ts`

**Interfaces:**
- Produces: `DesktopRequest`, `AgentEvent`, `ThreadSummary`, `Item`, `Approval`, `AppSnapshot`.
- Produces: `isDesktopRequest(value: unknown): value is DesktopRequest`.
- Produces: `isAgentEvent(value: unknown): value is AgentEvent`.

- [ ] **Step 1: Write failing protocol tests**

```ts
it('rejects a turn request without text', () => {
  expect(isDesktopRequest({ type: 'turn.start', threadId: 't1' })).toBe(false);
});

it('accepts a streamed message event', () => {
  expect(isAgentEvent({
    type: 'message.delta', threadId: 't1', turnId: 'u1', sequence: 1, text: 'Hi',
  })).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `pnpm vitest run tests/protocol.test.ts`

Expected: FAIL because protocol exports are missing.

- [ ] **Step 3: Implement domain types and explicit type guards**

Define requests for snapshot, thread creation, turn start/cancel, approval response, and theme change. Define events for snapshot, turn start, message delta, tool start/output, approval required, completion, and failure. Every Agent event includes `threadId`, `turnId`, and `sequence` except the initial snapshot.

- [ ] **Step 4: Run protocol tests and typecheck**

Run:

```powershell
pnpm vitest run tests/protocol.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/shared src/renderer/types.d.ts tests/protocol.test.ts
git commit -m "feat: define typed desktop protocol"
```

### Task 3: SQLite Persistence

**Files:**
- Create: `src/agent/database.ts`
- Create: `tests/database.test.ts`
- Modify: `vite.agent.config.ts`

**Interfaces:**
- Produces: `openDatabase(path: string): AppDatabase`.
- Produces: `AppDatabase.getSnapshot(): AppSnapshot`.
- Produces: `AppDatabase.createThread(title: string): ThreadSummary`.
- Produces: `AppDatabase.appendItem(item: Item): void`.
- Produces: `AppDatabase.upsertApproval(approval: Approval): void`.
- Produces: `AppDatabase.close(): void`.

- [ ] **Step 1: Write failing repository tests**

```ts
it('persists a thread and items across reopen', () => {
  const first = openDatabase(dbPath);
  const thread = first.createThread('Deployment review');
  first.appendItem(userItem(thread.id, 'Inspect the release'));
  first.close();

  const second = openDatabase(dbPath);
  expect(second.getSnapshot().threads[0].title).toBe('Deployment review');
  expect(second.getSnapshot().items[thread.id]).toHaveLength(1);
});
```

- [ ] **Step 2: Verify the repository tests fail**

Run: `pnpm vitest run tests/database.test.ts`

Expected: FAIL because `openDatabase` is missing.

- [ ] **Step 3: Implement schema, WAL settings, migrations, and repository methods**

Execute on open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Create `threads`, `turns`, `items`, `approvals`, `settings`, and `schema_migrations`. Keep SQL in `database.ts` for the MVP and use explicit transactions for thread/item writes.

- [ ] **Step 4: Run database tests and build**

Run:

```powershell
pnpm vitest run tests/database.test.ts
pnpm build
```

Expected: PASS and SQLite access remains isolated inside the Utility Process.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/database.ts vite.agent.config.ts tests/database.test.ts
git commit -m "feat: persist desktop state in sqlite"
```

### Task 4: Demo Agent Runtime and Approval Flow

**Files:**
- Create: `src/agent/demoAgent.ts`
- Create: `tests/demoAgent.test.ts`
- Modify: `src/agent/worker.ts`

**Interfaces:**
- Consumes: `DesktopRequest`, `AgentEvent`, and `AppDatabase`.
- Produces: `runDemoTurn(input, emit, signal): Promise<void>`.
- Produces: MessagePort request dispatch in `worker.ts`.

- [ ] **Step 1: Write failing stream and approval tests**

```ts
it('streams a visible response in sequence order', async () => {
  const events: AgentEvent[] = [];
  await runDemoTurn(input('Summarize this workspace'), event => events.push(event), signal);
  expect(events.map(event => event.sequence)).toEqual([...events.map(event => event.sequence)].sort((a, b) => a - b));
  expect(events.at(-1)?.type).toBe('turn.completed');
});

it('requests approval for a simulated write request', async () => {
  const events: AgentEvent[] = [];
  await runDemoTurn(input('修改配置文件'), event => events.push(event), signal);
  expect(events.some(event => event.type === 'approval.required')).toBe(true);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run tests/demoAgent.test.ts`

Expected: FAIL because `runDemoTurn` is missing.

- [ ] **Step 3: Implement deterministic demo behavior**

The demo provider emits a plan item, several message deltas, and a completed event. Inputs containing `修改`, `删除`, `write`, or `delete` emit an approval event and pause until `approval.respond`. It performs no real filesystem mutation.

- [ ] **Step 4: Run runtime tests**

Run: `pnpm vitest run tests/demoAgent.test.ts`

Expected: PASS without network or model credentials.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/worker.ts src/agent/demoAgent.ts tests/demoAgent.test.ts
git commit -m "feat: add streamed demo agent runtime"
```

### Task 5: Main, Preload, and Utility Process Bridge

**Files:**
- Modify: `src/main.ts`
- Modify: `src/preload.ts`
- Modify: `src/renderer/types.d.ts`
- Create: `tests/renderer-state.test.ts`
- Create: `src/renderer/composables/useApp.ts`

**Interfaces:**
- Produces: `window.desktop.getSnapshot()`.
- Produces: `window.desktop.createThread(title)`.
- Produces: `window.desktop.startTurn(threadId, text)`.
- Produces: `window.desktop.respondApproval(approvalId, approved)`.
- Produces: `window.desktop.subscribe(listener): unsubscribe`.

- [ ] **Step 1: Write failing renderer state tests**

```ts
it('deduplicates events by thread and sequence', () => {
  const state = reduceEvent(emptyState(), deltaEvent(1));
  expect(reduceEvent(state, deltaEvent(1))).toEqual(state);
});

it('marks a required approval as pending', () => {
  const state = reduceEvent(emptyState(), approvalEvent());
  expect(state.pendingApproval?.status).toBe('pending');
});
```

- [ ] **Step 2: Verify state tests fail**

Run: `pnpm vitest run tests/renderer-state.test.ts`

Expected: FAIL because `useApp` exports are missing.

- [ ] **Step 3: Implement the MessageChannel bridge and state reducer**

Main creates one `MessageChannelMain`, sends one port to the Utility Process, and forwards validated requests and events. Preload exposes named methods only. `useApp` owns the snapshot, active thread, event sequence map, composer busy state, and approval response actions.

- [ ] **Step 4: Run state, protocol, and type checks**

Run:

```powershell
pnpm vitest run tests/renderer-state.test.ts tests/protocol.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main.ts src/preload.ts src/renderer/types.d.ts src/renderer/composables tests/renderer-state.test.ts
git commit -m "feat: connect renderer to agent process"
```

### Task 6: Codex-Inspired Three-Pane UI

**Files:**
- Modify: `src/renderer/App.vue`
- Create: `src/renderer/components/Sidebar.vue`
- Create: `src/renderer/components/Conversation.vue`
- Create: `src/renderer/components/Composer.vue`
- Create: `src/renderer/components/Inspector.vue`
- Create: `src/renderer/styles/theme.css`
- Create: `src/renderer/styles/app.css`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `useApp()` state/actions.
- Produces: responsive sidebar, conversation timeline, composer, inspector, approval interaction, and theme toggle.

- [ ] **Step 1: Write the visual-state acceptance fixture**

Use a deterministic seeded snapshot with three threads, one completed tool call, one pending approval, and one two-file change summary. The UI must render the fixture without a model or network.

- [ ] **Step 2: Implement the layout and semantic tokens**

Implement:

```text
240–280 px sidebar | flexible conversation | 320–380 px inspector
```

Use the exact light/dark tokens from the design specification, 6/8/12px radii, system sans/mono fonts, 120–180ms transitions, and reduced-motion support. Use text or open-source line icons only; do not copy Codex brand assets.

- [ ] **Step 3: Implement interaction states**

Cover empty, loading, streaming, tool-running, approval-required, completed, failed, sidebar-collapsed, and inspector-drawer states. Enter submits; Shift+Enter inserts a newline. Approval buttons must name the action and must disable while a response is in flight.

- [ ] **Step 4: Run renderer tests and launch smoke test**

Run:

```powershell
pnpm vitest run
pnpm start
```

Expected: the desktop opens with the three-pane UI; a demo prompt streams visible events; a write-like prompt opens an approval card.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer
git commit -m "feat: build codex-inspired desktop workspace"
```

### Task 7: Packaging, E2E, and Final Verification

**Files:**
- Modify: `package.json`
- Modify: `forge.config.ts`
- Create: `tests/e2e/app.spec.ts`
- Create: `README.md`

**Interfaces:**
- Produces: reproducible `pnpm test`, `pnpm build`, `pnpm package`, and `pnpm make` commands.
- Produces: README run and architecture instructions.

- [ ] **Step 1: Write the Electron smoke test**

The smoke test launches Electron, asserts the window title, sends a demo prompt, waits for a streamed agent message, and verifies the inspector shows a completed task.

- [ ] **Step 2: Run the smoke test and observe failure**

Run: `pnpm test:e2e`

Expected: FAIL until scripts, selectors, and packaged launch configuration are complete.

- [ ] **Step 3: Add stable selectors, packaging scripts, and README**

README documents supported targets, development start, test/build/package commands, SQLite location, demo-mode boundary, and the fact that destructive tools are not implemented in the MVP.

- [ ] **Step 4: Run final verification**

Run:

```powershell
pnpm typecheck
pnpm vitest run
pnpm build
pnpm package
pnpm test:e2e
```

Expected: every command exits 0 and a platform package exists under `out/`.

- [ ] **Step 5: Commit**

```powershell
git add package.json forge.config.ts tests/e2e README.md
git commit -m "test: verify packaged desktop client"
```
