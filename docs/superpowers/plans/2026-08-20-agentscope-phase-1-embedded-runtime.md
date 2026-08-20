# AgentScope Phase 1 Embedded Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an authenticated AgentScope 2.0.6 service and CPython 3.11.16 inside the Windows desktop package so the client can start, inspect, and stop AgentScope without requiring system Python or Docker, while the existing TypeScript Agent remains the active request backend during Phase 1.

**Architecture:** Electron Main owns a platform-specific `AgentScopeSupervisor`. The supervisor launches the bundled interpreter without a shell, sends a one-time bootstrap secret over stdin, waits for one bounded JSON readiness line, then validates an authenticated loopback health endpoint. The Python service binds only to `127.0.0.1` on an operating-system-selected port. Renderer receives a typed, redacted runtime status through the existing preload boundary. Phase 1 does not route model requests through AgentScope and does not start or stop llama.cpp or any other model service.

**Tech Stack:** Electron 43, Electron Forge 7, TypeScript, Vue 3, Vitest, Playwright, Node child processes, Python 3.11.16, AgentScope 2.0.6, FastAPI/Uvicorn, pytest, uv lock/build tooling.

**Spec:** `docs/superpowers/specs/2026-08-20-agentscope-native-desktop-runtime-design.md` sections 1-4, especially section 4.1 (Phase 1).

## Global Constraints

- [ ] End users must not need Python, pip, uv, a virtual environment, or Docker.
- [ ] The Phase 1 release target is `win32-x64`. Packaging on another platform must fail with a clear unsupported-runtime error until that platform has its own verified runtime artifact.
- [ ] Pin runtime versions to CPython `3.11.16`, AgentScope `2.0.6`, and bootstrap protocol `1`.
- [ ] Bind the Python service only to `127.0.0.1` and request port `0`; never expose it on LAN interfaces.
- [ ] Generate a cryptographically random bootstrap token in Electron Main, pass it only through stdin, require it on every HTTP request, and never include it in command-line arguments, events, logs, error messages, or persisted state.
- [ ] Keep the existing TypeScript Agent worker as the active request backend in this phase. Do not duplicate business writes or partially route turns through AgentScope.
- [ ] Keep llama.cpp and all other model-service lifecycle controls independent from Electron and AgentScope.
- [ ] Do not introduce shared SQLite writes. Phase 1 runtime state is process-local and read-only from the application health surface.
- [ ] Preserve every pre-existing dirty-worktree change. Each implementation commit may stage only the files named in its task.
- [ ] Use test-first changes for every behavior. Record the expected RED failure before minimal implementation and run the listed GREEN command afterward.
- [ ] Never commit generated runtime binaries under `resources/agentscope-runtime/`; build them deterministically during packaging and verify their manifest and hashes.

## Phase Boundary

This plan implements only the embedded runtime foundation. The following approved design work has separate sequential plans and must not be mixed into Phase 1 commits:

1. AgentScope model-provider routing and removal of direct TypeScript model calls.
2. AgentScope tool, approval, workspace, MCP, Skills, RAG, memory, and persistence migration.
3. Multi-Agent orchestration, recovery, tracing, and evaluation.
4. Removal of the legacy TypeScript Agent kernel and final rollback cleanup.

## File and Responsibility Map

| Path | Responsibility |
| --- | --- |
| `agentscope-runtime/pyproject.toml` | Python project metadata and exact runtime dependencies. |
| `agentscope-runtime/uv.lock` | Reproducible Python dependency lock. |
| `agentscope-runtime/src/private_ai_agentscope/protocol.py` | Bootstrap and health protocol models/constants. |
| `agentscope-runtime/src/private_ai_agentscope/service.py` | Authenticated loopback FastAPI application. |
| `agentscope-runtime/src/private_ai_agentscope/bootstrap.py` | stdin bootstrap, ephemeral socket binding, readiness output, graceful service process. |
| `agentscope-runtime/tests/` | Python protocol, HTTP, and subprocess tests. |
| `src/main/agentScopeProtocol.ts` | TypeScript validation of runtime manifest/readiness/status data. |
| `src/main/agentScopeRuntimePaths.ts` | Containment-safe development and packaged runtime path resolution. |
| `src/main/agentScopeSupervisor.ts` | Process lifecycle, bootstrap, readiness timeout, health probe, restart budget, redacted status. |
| `src/main/appHealth.ts` | Pure composition of desktop and AgentScope health data. |
| `src/main.ts` | Application lifecycle integration; legacy Agent remains active. |
| `src/preload.ts` | Typed health bridge only; no token or service URL exposure. |
| `src/renderer/types.d.ts` | Renderer-facing health contract. |
| `scripts/agentscope-runtime/build.mjs` | Deterministic Windows runtime assembly and manifest generation. |
| `scripts/agentscope-runtime/verify.mjs` | Runtime import, version, structure, hash, and forbidden-file verification. |
| `forge.config.ts` | Copies the verified runtime beside `app.asar` as an extra resource. |
| `scripts/verify-package-contents.mjs` | Extends packaged-content allowlist and required runtime checks. |
| `tests/agentScope*.test.ts` | TypeScript unit/contract tests. |
| `tests/packageContents.test.ts` | Packaged-content policy tests. |
| `tests/e2e/app.spec.ts` | Clean-machine packaged lifecycle acceptance. |
| `.gitignore` | Excludes generated runtime staging/output. |
| `package.json` | Runtime lock, test, bundle, verification, package, and E2E scripts. |

---

## Task 1: Establish the pinned Python project and shared protocol contract

**Files:**

- Create: `agentscope-runtime/pyproject.toml`
- Create: `agentscope-runtime/src/private_ai_agentscope/__init__.py`
- Create: `agentscope-runtime/src/private_ai_agentscope/protocol.py`
- Create: `agentscope-runtime/tests/test_protocol.py`
- Create: `agentscope-runtime/uv.lock`

**Interfaces:**

- Consumes: approved versions CPython `3.11.16`, AgentScope `2.0.6`, protocol `1`.
- Produces: `BootstrapConfig`, `BootstrapReady`, `RuntimeHealth`, and immutable version constants used by Python and mirrored in TypeScript.

- [ ] **Step 1: Write the failing protocol contract test.**

```python
from private_ai_agentscope.protocol import (
    AGENTSCOPE_VERSION,
    PROTOCOL_VERSION,
    RUNTIME_VERSION,
    BootstrapConfig,
    BootstrapReady,
)


def test_bootstrap_contract_is_versioned_and_redacted() -> None:
    config = BootstrapConfig.model_validate({
        "token": "secret-token",
        "user_data_dir": "C:/tmp/private-ai",
        "log_dir": "C:/tmp/private-ai/logs",
    })
    ready = BootstrapReady(port=49152, pid=1234)

    assert PROTOCOL_VERSION == "1"
    assert RUNTIME_VERSION == "1.0.0"
    assert AGENTSCOPE_VERSION == "2.0.6"
    assert ready.model_dump() == {
        "type": "agentscope.ready",
        "protocol_version": "1",
        "runtime_version": "1.0.0",
        "agentscope_version": "2.0.6",
        "port": 49152,
        "pid": 1234,
    }
    assert "secret-token" not in repr(config)
```

- [ ] **Step 2: Run RED and confirm import failure.**

Run: `uv run --project agentscope-runtime pytest agentscope-runtime/tests/test_protocol.py -q`

Expected: FAIL because `private_ai_agentscope.protocol` does not exist.

- [ ] **Step 3: Add exact project metadata and protocol models.**

```toml
[project]
name = "private-ai-agentscope-runtime"
version = "1.0.0"
requires-python = ">=3.11,<3.12"
dependencies = [
  "agentscope[service]==2.0.6",
  "fastapi>=0.116,<0.117",
  "pydantic>=2.11,<3",
  "uvicorn[standard]>=0.35,<0.36",
]

[dependency-groups]
dev = [
  "httpx>=0.28,<0.29",
  "pytest>=8.4,<9",
  "pytest-asyncio>=1.1,<2",
]

[build-system]
requires = ["hatchling>=1.27,<2"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

```python
from pydantic import BaseModel, ConfigDict, Field, SecretStr

PROTOCOL_VERSION = "1"
RUNTIME_VERSION = "1.0.0"
AGENTSCOPE_VERSION = "2.0.6"


class BootstrapConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr = Field(min_length=32, max_length=256)
    user_data_dir: str = Field(min_length=1)
    log_dir: str = Field(min_length=1)


class BootstrapReady(BaseModel):
    type: str = "agentscope.ready"
    protocol_version: str = PROTOCOL_VERSION
    runtime_version: str = RUNTIME_VERSION
    agentscope_version: str = AGENTSCOPE_VERSION
    port: int = Field(ge=1, le=65535)
    pid: int = Field(gt=0)


class RuntimeHealth(BaseModel):
    ok: bool = True
    protocol_version: str = PROTOCOL_VERSION
    runtime_version: str = RUNTIME_VERSION
    agentscope_version: str = AGENTSCOPE_VERSION
```

- [ ] **Step 4: Lock dependencies and run GREEN.**

Run: `uv lock --project agentscope-runtime`

Run: `uv run --project agentscope-runtime pytest agentscope-runtime/tests/test_protocol.py -q`

Expected: PASS and `agentscope-runtime/uv.lock` records AgentScope `2.0.6`.

- [ ] **Step 5: Commit only Task 1 files.**

```powershell
git add agentscope-runtime/pyproject.toml agentscope-runtime/uv.lock agentscope-runtime/src/private_ai_agentscope/__init__.py agentscope-runtime/src/private_ai_agentscope/protocol.py agentscope-runtime/tests/test_protocol.py
git commit -m "feat: define embedded AgentScope runtime contract"
```

---

## Task 2: Implement the authenticated loopback health service

**Files:**

- Create: `agentscope-runtime/src/private_ai_agentscope/service.py`
- Create: `agentscope-runtime/tests/test_service.py`

**Interfaces:**

- Consumes: `BootstrapConfig`, `RuntimeHealth` from Task 1.
- Produces: `create_app(config) -> FastAPI` with authenticated `GET /v1/health` and `GET /v1/ready`.

- [ ] **Step 1: Write failing authentication and version tests.**

```python
from fastapi.testclient import TestClient

from private_ai_agentscope.protocol import BootstrapConfig
from private_ai_agentscope.service import create_app


def test_health_requires_exact_bearer_token() -> None:
    app = create_app(BootstrapConfig(
        token="x" * 32,
        user_data_dir="C:/tmp/private-ai",
        log_dir="C:/tmp/private-ai/logs",
    ))
    client = TestClient(app)

    assert client.get("/v1/health").status_code == 401
    assert client.get("/v1/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    response = client.get(
        "/v1/health",
        headers={"Authorization": f"Bearer {'x' * 32}"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "protocol_version": "1",
        "runtime_version": "1.0.0",
        "agentscope_version": "2.0.6",
    }
```

- [ ] **Step 2: Run RED.**

Run: `uv run --project agentscope-runtime pytest agentscope-runtime/tests/test_service.py -q`

Expected: FAIL because `service.py` does not exist.

- [ ] **Step 3: Add constant-time bearer authentication and health routes.**

```python
import hmac

from fastapi import FastAPI, Header, HTTPException

from .protocol import BootstrapConfig, RuntimeHealth


def create_app(config: BootstrapConfig) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    expected = f"Bearer {config.token.get_secret_value()}"

    def authorize(authorization: str | None = Header(default=None)) -> None:
        if authorization is None or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/v1/health", response_model=RuntimeHealth, dependencies=[])
    def health(authorization: str | None = Header(default=None)) -> RuntimeHealth:
        authorize(authorization)
        return RuntimeHealth()

    @app.get("/v1/ready", response_model=RuntimeHealth, dependencies=[])
    def ready(authorization: str | None = Header(default=None)) -> RuntimeHealth:
        authorize(authorization)
        return RuntimeHealth()

    return app
```

- [ ] **Step 4: Run GREEN and the Python suite.**

Run: `uv run --project agentscope-runtime pytest agentscope-runtime/tests/test_service.py -q`

Run: `uv run --project agentscope-runtime pytest -q`

Expected: all Python tests PASS; unauthenticated access remains `401`.

- [ ] **Step 5: Commit Task 2 files.**

```powershell
git add agentscope-runtime/src/private_ai_agentscope/service.py agentscope-runtime/tests/test_service.py
git commit -m "feat: add authenticated AgentScope health service"
```

---

## Task 3: Add the bounded stdin/stdout bootstrap process

**Files:**

- Create: `agentscope-runtime/src/private_ai_agentscope/bootstrap.py`
- Create: `agentscope-runtime/tests/test_bootstrap.py`
- Modify: `agentscope-runtime/pyproject.toml`
- Modify: `agentscope-runtime/uv.lock`

**Interfaces:**

- Consumes: one UTF-8 JSON line on stdin, maximum 16 KiB.
- Produces: one UTF-8 `BootstrapReady` JSON line on stdout, then serves authenticated HTTP until SIGTERM/CTRL_BREAK.

- [ ] **Step 1: Write a failing subprocess acceptance test.**

```python
import json
import os
import subprocess
import sys
import urllib.request


def test_bootstrap_emits_one_redacted_ready_line_and_stops(tmp_path) -> None:
    token = "t" * 48
    process = subprocess.Popen(
        [sys.executable, "-m", "private_ai_agentscope.bootstrap"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(json.dumps({
        "token": token,
        "user_data_dir": str(tmp_path),
        "log_dir": str(tmp_path / "logs"),
    }) + "\n")
    process.stdin.flush()

    line = process.stdout.readline()
    ready = json.loads(line)
    assert ready["type"] == "agentscope.ready"
    assert ready["protocol_version"] == "1"
    assert token not in line

    request = urllib.request.Request(
        f"http://127.0.0.1:{ready['port']}/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert json.loads(urllib.request.urlopen(request, timeout=5).read())["ok"] is True

    process.terminate()
    assert process.wait(timeout=5) == 0
```

- [ ] **Step 2: Run RED.**

Run: `uv run --project agentscope-runtime pytest agentscope-runtime/tests/test_bootstrap.py -q`

Expected: FAIL because the bootstrap module does not exist.

- [ ] **Step 3: Implement bounded input, ephemeral loopback socket, ready output, and graceful shutdown.**

```python
import asyncio
import json
import os
import socket
import sys

import uvicorn

from .protocol import BootstrapConfig, BootstrapReady
from .service import create_app

MAX_BOOTSTRAP_BYTES = 16 * 1024


async def main() -> int:
    raw = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_BOOTSTRAP_BYTES + 1)
    if not raw or len(raw) > MAX_BOOTSTRAP_BYTES or not raw.endswith(b"\n"):
        raise ValueError("invalid bootstrap input")
    config = BootstrapConfig.model_validate_json(raw)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = int(sock.getsockname()[1])

    ready = BootstrapReady(port=port, pid=os.getpid())
    sys.stdout.write(ready.model_dump_json() + "\n")
    sys.stdout.flush()

    server = uvicorn.Server(uvicorn.Config(
        create_app(config),
        host=None,
        port=None,
        log_config=None,
        access_log=False,
    ))
    await server.serve(sockets=[sock])
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
```

- [ ] **Step 4: Make termination deterministic on Windows and Linux test runners.**

Add a platform-aware shutdown handler that sets `server.should_exit = True`, closes the listening socket once, and returns exit code `0`. Add a second test that sends malformed/oversized bootstrap input and asserts non-zero exit without echoing the input.

- [ ] **Step 5: Run GREEN.**

Run: `uv run --project agentscope-runtime pytest agentscope-runtime/tests/test_bootstrap.py -q`

Run: `uv run --project agentscope-runtime pytest -q`

Expected: all Python tests PASS; service is reachable only at the emitted loopback port; token never appears in stdout/stderr.

- [ ] **Step 6: Commit Task 3 files.**

```powershell
git add agentscope-runtime/pyproject.toml agentscope-runtime/uv.lock agentscope-runtime/src/private_ai_agentscope/bootstrap.py agentscope-runtime/tests/test_bootstrap.py
git commit -m "feat: add AgentScope bootstrap process"
```

---

## Task 4: Validate the runtime protocol and resolve contained paths in Electron Main

**Files:**

- Create: `src/main/agentScopeProtocol.ts`
- Create: `src/main/agentScopeRuntimePaths.ts`
- Create: `tests/agentScopeProtocol.test.ts`
- Create: `tests/agentScopeRuntimePaths.test.ts`

**Interfaces:**

- Consumes: packaged `runtime-manifest.json`, bootstrap stdout, Electron `resourcesPath`/`appPath`.
- Produces: validated `AgentScopeRuntimeManifest`, `AgentScopeBootstrapReady`, `AgentScopeRuntimePaths`, and a containment-safe resolver.

- [ ] **Step 1: Write failing manifest/readiness parser tests.**

```ts
import { describe, expect, it } from 'vitest';
import { parseAgentScopeReady, parseRuntimeManifest } from '../src/main/agentScopeProtocol';

describe('AgentScope protocol', () => {
  it('accepts only the pinned protocol and runtime versions', () => {
    expect(parseAgentScopeReady(JSON.stringify({
      type: 'agentscope.ready',
      protocol_version: '1',
      runtime_version: '1.0.0',
      agentscope_version: '2.0.6',
      port: 49152,
      pid: 1234,
    }))).toMatchObject({ port: 49152, pid: 1234 });

    expect(() => parseAgentScopeReady(JSON.stringify({
      type: 'agentscope.ready',
      protocol_version: '2',
      runtime_version: '1.0.0',
      agentscope_version: '2.0.6',
      port: 49152,
      pid: 1234,
    }))).toThrow(/protocol/i);
  });

  it('rejects absolute and escaping manifest paths', () => {
    expect(() => parseRuntimeManifest({
      schemaVersion: 1,
      platform: 'win32',
      arch: 'x64',
      pythonVersion: '3.11.16',
      agentScopeVersion: '2.0.6',
      protocolVersion: '1',
      pythonRelativePath: '../python.exe',
      appRelativePath: 'app',
      sitePackagesRelativePath: 'site-packages',
      files: [],
    })).toThrow(/relative path/i);
  });
});
```

- [ ] **Step 2: Run RED.**

Run: `pnpm exec vitest run tests/agentScopeProtocol.test.ts tests/agentScopeRuntimePaths.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement strict parsers and status types.**

```ts
export type AgentScopeRuntimeState =
  | { state: 'stopped' }
  | { state: 'starting'; attempt: number }
  | { state: 'ready'; pid: number; port: number; runtimeVersion: '1.0.0'; agentScopeVersion: '2.0.6' }
  | { state: 'degraded'; reason: 'missing-runtime' | 'invalid-manifest' | 'protocol-mismatch' | 'health-failed' | 'start-timeout' | 'exited'; detail: string };

export interface AgentScopeRuntimeManifest {
  schemaVersion: 1;
  platform: 'win32';
  arch: 'x64';
  pythonVersion: '3.11.16';
  agentScopeVersion: '2.0.6';
  protocolVersion: '1';
  pythonRelativePath: string;
  appRelativePath: string;
  sitePackagesRelativePath: string;
  files: Array<{ path: string; sha256: string; size: number }>;
}
```

Use type guards for every property, reject unknown top-level keys, reject non-relative paths, normalize separators, and require ports `1..65535` and positive integer PIDs.

- [ ] **Step 4: Implement path resolution with post-resolution containment checks.**

```ts
export interface ResolveRuntimeInput {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export interface AgentScopeRuntimePaths {
  root: string;
  manifest: string;
}

export function resolveAgentScopeRuntimeRoot(input: ResolveRuntimeInput): string {
  return input.isPackaged
    ? path.resolve(input.resourcesPath, 'agentscope-runtime')
    : path.resolve(input.appPath, 'resources', 'agentscope-runtime');
}
```

The manifest-derived interpreter/app/site-packages paths must remain descendants of `root` after `path.resolve`; equality with `root` is not valid for a file path.

- [ ] **Step 5: Run GREEN and typecheck.**

Run: `pnpm exec vitest run tests/agentScopeProtocol.test.ts tests/agentScopeRuntimePaths.test.ts`

Run: `pnpm typecheck`

Expected: focused tests and typecheck PASS.

- [ ] **Step 6: Commit Task 4 files.**

```powershell
git add src/main/agentScopeProtocol.ts src/main/agentScopeRuntimePaths.ts tests/agentScopeProtocol.test.ts tests/agentScopeRuntimePaths.test.ts
git commit -m "feat: validate AgentScope runtime protocol"
```

---

## Task 5: Supervise the embedded process with a bounded restart policy

**Files:**

- Create: `src/main/agentScopeSupervisor.ts`
- Create: `tests/agentScopeSupervisor.test.ts`

**Interfaces:**

- Consumes: validated runtime paths/manifest and injected process, clock, random-token, fetch, and logger adapters.
- Produces: `start()`, `stop()`, `status()`, and status subscription; never exposes the bootstrap token.

- [ ] **Step 1: Write failing lifecycle tests with fake dependencies.**

Cover these exact cases:

1. Generates 32 random bytes encoded as base64url and writes one JSON line to stdin.
2. Spawns the bundled interpreter with `shell: false`, bootstrap module arguments, a minimal environment, and no token argument.
3. Accepts exactly one valid readiness line and then validates authenticated `/v1/health`.
4. Rejects readiness output above 16 KiB, invalid JSON, wrong protocol/version, wrong PID, and non-loopback URLs.
5. Times out startup after 15 seconds, terminates the child, and reports `start-timeout`.
6. Restarts an unexpected exit at delays `1s`, `3s`, and `10s`, then reports `exited` without a fourth restart.
7. `stop()` cancels timers, sends graceful termination, waits 5 seconds, then force-kills only that child if still alive.
8. Logger/status/error serialization never contains the token.

```ts
it('passes the secret through stdin and not argv or status', async () => {
  const harness = createSupervisorHarness();
  const start = harness.supervisor.start();
  harness.child.emitStdout(validReadyLine({ pid: harness.child.pid }));
  harness.fetch.resolve(okHealth());
  await start;

  expect(harness.spawn.args.join(' ')).not.toContain(harness.token);
  expect(harness.child.stdinText).toContain(harness.token);
  expect(JSON.stringify(harness.supervisor.status())).not.toContain(harness.token);
});
```

- [ ] **Step 2: Run RED.**

Run: `pnpm exec vitest run tests/agentScopeSupervisor.test.ts`

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Implement an injection-friendly supervisor.**

```ts
export interface AgentScopeSupervisorDeps {
  spawn: typeof import('node:child_process').spawn;
  fetch: typeof globalThis.fetch;
  randomBytes: typeof import('node:crypto').randomBytes;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

export class AgentScopeSupervisor {
  async start(): Promise<AgentScopeRuntimeState>;
  async stop(): Promise<void>;
  status(): AgentScopeRuntimeState;
  subscribe(listener: (state: AgentScopeRuntimeState) => void): () => void;
}
```

Use `spawn(pythonPath, ['-m', 'private_ai_agentscope.bootstrap'], { shell: false, windowsHide: true, env })`. Build `PYTHONPATH` from the contained app and site-packages directories and set `PYTHONNOUSERSITE=1`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUTF8=1`, and `PYTHONUNBUFFERED=1`. Do not inherit `PYTHONHOME` or caller `PYTHONPATH`.

- [ ] **Step 4: Implement authenticated readiness and restart controls.**

After parsing readiness, require `ready.pid === child.pid`, call `http://127.0.0.1:${ready.port}/v1/health` with `Authorization: Bearer <token>`, and require exact pinned versions in the response. Redact all thrown/provider messages before storing them. Reset the restart budget only after 60 seconds of continuous health.

- [ ] **Step 5: Run GREEN and typecheck.**

Run: `pnpm exec vitest run tests/agentScopeSupervisor.test.ts`

Run: `pnpm typecheck`

Expected: lifecycle tests and typecheck PASS with fake timers and no live Python dependency.

- [ ] **Step 6: Commit Task 5 files.**

```powershell
git add src/main/agentScopeSupervisor.ts tests/agentScopeSupervisor.test.ts
git commit -m "feat: supervise embedded AgentScope runtime"
```

---

## Task 6: Integrate runtime health without changing the active Agent backend

**Files:**

- Create: `src/main/appHealth.ts`
- Create: `tests/agentScopeAppHealth.test.ts`
- Modify: `src/main.ts`
- Modify: `src/preload.ts`
- Modify: `src/renderer/types.d.ts`

**Interfaces:**

- Consumes: `AgentScopeSupervisor.status()` and existing app version/legacy worker lifecycle.
- Produces: renderer-safe `desktop.health()` response with `agentBackend: 'legacy'` and redacted `agentScope` state.

- [ ] **Step 1: Write failing app-health contract tests.**

```ts
import { describe, expect, it } from 'vitest';
import { buildAppHealth } from '../src/main/appHealth';

describe('buildAppHealth', () => {
  it('reports AgentScope separately while legacy remains active', () => {
    expect(buildAppHealth('1.2.3', {
      state: 'ready',
      pid: 1234,
      port: 49152,
      runtimeVersion: '1.0.0',
      agentScopeVersion: '2.0.6',
    })).toEqual({
      ok: true,
      version: '1.2.3',
      agentBackend: 'legacy',
      agentScope: {
        state: 'ready',
        runtimeVersion: '1.0.0',
        agentScopeVersion: '2.0.6',
      },
    });
  });
});
```

The public health object must omit PID, port, token, runtime filesystem paths, and raw stderr.

- [ ] **Step 2: Run RED.**

Run: `pnpm exec vitest run tests/agentScopeAppHealth.test.ts`

Expected: FAIL because `appHealth.ts` does not exist.

- [ ] **Step 3: Implement pure health projection and shared renderer type.**

```ts
export interface DesktopHealth {
  ok: true;
  version: string;
  agentBackend: 'legacy';
  agentScope:
    | { state: 'stopped' | 'starting' }
    | { state: 'ready'; runtimeVersion: '1.0.0'; agentScopeVersion: '2.0.6' }
    | { state: 'degraded'; reason: string; detail: string };
}
```

- [ ] **Step 4: Start AgentScope after Electron readiness and stop it on app shutdown.**

In `src/main.ts`, construct one supervisor in Main. Start it after `app.whenReady()` without blocking window creation. Keep the existing utility-process Agent worker and request broker unchanged. If embedded runtime startup fails, record degraded health and keep the legacy app usable. On final app quit, call `stop()` once; do not invoke model-runtime scripts or Docker commands.

- [ ] **Step 5: Expose only the redacted health projection through preload.**

Update `desktop.health()` and `src/renderer/types.d.ts` to return `DesktopHealth`. Do not expose a generic AgentScope HTTP client, token, port, PID, or filesystem path to Renderer.

- [ ] **Step 6: Run GREEN and regression tests.**

Run: `pnpm exec vitest run tests/agentScopeAppHealth.test.ts tests/protocol.test.ts tests/renderer-state.test.ts`

Run: `pnpm typecheck`

Expected: focused tests and typecheck PASS; `agentBackend` remains `legacy`.

- [ ] **Step 7: Commit Task 6 files only.**

```powershell
git add src/main/appHealth.ts src/main.ts src/preload.ts src/renderer/types.d.ts tests/agentScopeAppHealth.test.ts
git commit -m "feat: expose embedded AgentScope health"
```

---

## Task 7: Build a deterministic Windows runtime artifact

**Files:**

- Create: `scripts/agentscope-runtime/build.mjs`
- Create: `scripts/agentscope-runtime/verify.mjs`
- Create: `tests/agentScopeRuntimeBuild.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**

- Consumes: `agentscope-runtime/uv.lock`, uv on the developer/CI machine, source under `agentscope-runtime/src`.
- Produces: generated `resources/agentscope-runtime/` containing CPython, application modules, locked site-packages, and `runtime-manifest.json` with SHA-256/size entries.

- [ ] **Step 1: Write failing pure tests for target selection, safe cleanup, and manifest validation.**

```ts
it('supports only the verified win32-x64 artifact', () => {
  expect(resolveRuntimeTarget('win32', 'x64')).toEqual({ platform: 'win32', arch: 'x64' });
  expect(() => resolveRuntimeTarget('linux', 'x64')).toThrow(/unsupported embedded runtime/i);
});

it('refuses to clean a path outside resources/agentscope-runtime', () => {
  expect(() => assertSafeRuntimeOutput('D:/workspace/AI/2026-08-14/ai-aifar/resources'))
    .toThrow(/unsafe runtime output/i);
});
```

- [ ] **Step 2: Run RED.**

Run: `pnpm exec vitest run tests/agentScopeRuntimeBuild.test.ts`

Expected: FAIL because the build module does not exist.

- [ ] **Step 3: Implement a staging-only build pipeline.**

The script must:

1. Resolve the repository root from `import.meta.url`, not the caller working directory.
2. Accept only `win32-x64`.
3. Create `resources/.agentscope-runtime-staging-<pid>` after verifying its resolved parent is the repository `resources` directory.
4. Run `uv python install 3.11.16 --install-dir <staging>/python-install`.
5. Resolve that exact interpreter using an isolated `UV_PYTHON_INSTALL_DIR`.
6. Run `uv export --project agentscope-runtime --locked --no-dev --format requirements-txt --output-file <staging>/requirements.lock`.
7. Run `uv pip install --python <bundled-python> --target <staging>/site-packages --requirements <staging>/requirements.lock --strict`.
8. Copy `agentscope-runtime/src/private_ai_agentscope` to `<staging>/app/private_ai_agentscope`.
9. Remove `__pycache__`, `*.pyc`, tests, package-manager caches, installers, and the exported requirements file.
10. Write `runtime-manifest.json` with the exact versions, relative paths, and sorted SHA-256/size records for every shipped file except the manifest itself.
11. Verify the artifact, then atomically replace only `resources/agentscope-runtime`.

- [ ] **Step 4: Implement independent artifact verification.**

`verify.mjs` must:

- parse the manifest with the same exact version rules as TypeScript;
- recalculate every file hash and size;
- reject missing, extra, symlink/reparse-point, absolute, or escaping paths;
- reject filenames matching `.env`, `*.pem`, `*.key`, `__pycache__`, `*.pyc`, `tests`, `.git`, `uv`, `pip`, or wheel/cache directories;
- run the bundled interpreter with an isolated environment and execute:

```python
import agentscope
from private_ai_agentscope.protocol import AGENTSCOPE_VERSION
assert agentscope.__version__ == "2.0.6"
assert AGENTSCOPE_VERSION == "2.0.6"
```

- [ ] **Step 5: Add package scripts and ignore generated output.**

```json
{
  "scripts": {
    "agentscope:lock": "uv lock --project agentscope-runtime",
    "agentscope:test": "uv run --project agentscope-runtime pytest -q",
    "agentscope:bundle": "node scripts/agentscope-runtime/build.mjs",
    "agentscope:verify": "node scripts/agentscope-runtime/verify.mjs"
  }
}
```

Add only `/resources/agentscope-runtime/` and `/resources/.agentscope-runtime-staging-*/` to `.gitignore`.

- [ ] **Step 6: Run GREEN without downloading the runtime in the unit-test step.**

Run: `pnpm exec vitest run tests/agentScopeRuntimeBuild.test.ts`

Run: `pnpm typecheck`

Expected: pure build-policy tests and typecheck PASS.

- [ ] **Step 7: Build and verify the real runtime artifact.**

Run: `pnpm agentscope:bundle`

Run: `pnpm agentscope:verify`

Expected: both commands exit `0`; bundled Python reports `3.11.16`; AgentScope reports `2.0.6`; no system Python is used for verification.

- [ ] **Step 8: Commit source and lock changes, not generated binaries.**

```powershell
git add .gitignore package.json scripts/agentscope-runtime/build.mjs scripts/agentscope-runtime/verify.mjs tests/agentScopeRuntimeBuild.test.ts
git commit -m "build: assemble embedded AgentScope runtime"
```

---

## Task 8: Package the runtime beside ASAR and enforce the package allowlist

**Files:**

- Modify: `forge.config.ts`
- Modify: `scripts/verify-package-contents.mjs`
- Modify: `tests/packageContents.test.ts`
- Create: `tests/agentScopeRuntimePackaging.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: verified `resources/agentscope-runtime/` artifact.
- Produces: packaged `resources/agentscope-runtime/` beside `resources/app.asar`; package scanner proves required/forbidden contents and hashes.

- [ ] **Step 1: Write failing Forge and scanner contract tests.**

Assert that:

1. `packagerConfig.extraResource` includes exactly `resources/agentscope-runtime` for the new runtime.
2. `package` runs `agentscope:bundle` before `electron-forge package`.
3. packaged verification requires `runtime-manifest.json`, the manifest-selected interpreter, `app/private_ai_agentscope/bootstrap.py`, and `site-packages/agentscope`.
4. the scanner fails on unexpected files, mismatched hashes, `.env`, private keys, caches, tests, package managers, or source outside the manifest.

- [ ] **Step 2: Run RED.**

Run: `pnpm exec vitest run tests/packageContents.test.ts tests/agentScopeRuntimePackaging.test.ts`

Expected: FAIL because Forge and scanner do not yet include the runtime.

- [ ] **Step 3: Add the runtime as an Electron extra resource.**

```ts
packagerConfig: {
  asar: true,
  extraResource: ['resources/agentscope-runtime'],
}
```

Do not place Python inside ASAR because the interpreter and native extension modules must execute/load from real filesystem paths.

- [ ] **Step 4: Extend the package scanner with manifest-backed checks.**

Keep the current ASAR allowlist intact. Add a separate outer-resource policy that permits `app.asar` plus the exact manifest-listed AgentScope files. Reject all extra runtime files and verify hashes from the packaged copy, not the source artifact.

- [ ] **Step 5: Make packaging self-contained.**

Set the existing package script to:

```json
"package": "pnpm agentscope:bundle && electron-forge package && node scripts/verify-package-contents.mjs"
```

Preserve the current `make`/E2E behavior by making those paths invoke the same verified package pipeline rather than bypassing it.

- [ ] **Step 6: Run GREEN and package verification.**

Run: `pnpm exec vitest run tests/packageContents.test.ts tests/agentScopeRuntimePackaging.test.ts`

Run: `pnpm package`

Expected: tests PASS; packaged scanner exits `0`; runtime is outside ASAR; no forbidden files are present.

- [ ] **Step 7: Commit Task 8 files.**

```powershell
git add forge.config.ts package.json scripts/verify-package-contents.mjs tests/packageContents.test.ts tests/agentScopeRuntimePackaging.test.ts
git commit -m "build: package embedded AgentScope runtime"
```

---

## Task 9: Prove clean-machine lifecycle behavior and record acceptance evidence

**Files:**

- Modify: `tests/e2e/app.spec.ts`
- Create: `docs/superpowers/reports/2026-08-20-agentscope-phase-1-verification.md`

**Interfaces:**

- Consumes: fresh packaged application and embedded runtime.
- Produces: automated evidence that the package runs without system Python/Docker, reports authenticated AgentScope readiness, shuts down only its child, and leaves external model services untouched.

- [ ] **Step 1: Add a failing packaged E2E health test.**

Launch the packaged executable directly with:

- a fresh temporary `PRIVATE_AI_DESKTOP_USER_DATA` directory;
- `PATH` set to an empty temporary directory;
- `PYTHONHOME`, `PYTHONPATH`, `VIRTUAL_ENV`, and `CONDA_PREFIX` removed;
- no Docker daemon setup.

Assert `window.desktop.health()` returns:

```ts
{
  ok: true,
  agentBackend: 'legacy',
  agentScope: {
    state: 'ready',
    runtimeVersion: '1.0.0',
    agentScopeVersion: '2.0.6',
  },
}
```

Also assert the public object has no token, port, PID, interpreter path, or user-data path.

- [ ] **Step 2: Run RED against a fresh package.**

Run: `pnpm package`

Run: `pnpm exec playwright test tests/e2e/app.spec.ts --grep "embedded AgentScope runtime"`

Expected: FAIL until packaged lifecycle integration is correct.

- [ ] **Step 3: Add shutdown and model-lifecycle independence assertions.**

Use the test-owned fake model endpoint as an external sentinel. After closing Electron:

1. Poll the emitted AgentScope health endpoint from the test process until connection refusal proves the child stopped.
2. Call the fake model endpoint again and require success, proving Electron did not stop the model service.
3. Check the temporary user-data logs and application output for the bootstrap token and require zero matches.

Keep the AgentScope port private to the test-only Main-process diagnostic hook; do not add it to the production renderer contract.

- [ ] **Step 4: Run the complete verification matrix.**

Run in this order and record exact command, exit code, and result counts:

```powershell
pnpm agentscope:test
pnpm agentscope:verify
pnpm test
pnpm typecheck
pnpm package
pnpm exec playwright test tests/e2e/app.spec.ts
git diff --check
```

Expected:

- Python suite PASS.
- Runtime artifact verification PASS.
- Full Vitest suite PASS.
- TypeScript typecheck PASS.
- Fresh package and package scanner PASS.
- Packaged Playwright suite PASS with no system Python/Docker.
- `git diff --check` produces no output.

- [ ] **Step 5: Write the verification report.**

The report must include:

- pinned versions and runtime manifest SHA-256;
- packaged file counts and forbidden-file scan result;
- RED and GREEN evidence for the Phase 1 E2E;
- process lifecycle proof;
- model-service independence proof;
- token/log leak search result;
- known Phase 1 boundary: `agentBackend` remains `legacy` and no model request is routed through AgentScope yet;
- exact rollback: revert Phase 1 commits and rebuild; no database migration or user-data conversion is required.

- [ ] **Step 6: Commit E2E and report only after all gates pass.**

```powershell
git add tests/e2e/app.spec.ts docs/superpowers/reports/2026-08-20-agentscope-phase-1-verification.md
git commit -m "test: verify embedded AgentScope runtime"
```

---

## Final Phase 1 Review Gate

- [ ] Confirm `git status --short` still shows all pre-existing Qoder/user changes and none were accidentally staged or overwritten.
- [ ] Inspect `git diff <phase-1-base>..HEAD --stat` and verify every changed file is named in this plan.
- [ ] Search implementation and report files for `TODO`, `TBD`, placeholder secrets, hard-coded ports, `0.0.0.0`, `localhost` ambiguity, `python` from PATH, `docker`, and token logging; each match must be either removed or explicitly justified in the verification report.
- [ ] Confirm TypeScript and Python version constants are identical and all status unions are exhaustive.
- [ ] Confirm Renderer cannot access the token, AgentScope port/PID, runtime paths, arbitrary HTTP calls, child-process controls, or model lifecycle controls.
- [ ] Confirm app startup remains usable when AgentScope is missing or invalid and clearly reports degraded runtime health while preserving the legacy backend.
- [ ] Request code review with `superpowers:requesting-code-review` before declaring Phase 1 complete.
- [ ] Use `superpowers:verification-before-completion` and quote fresh verification output before any completion claim.

## Phase 1 Completion Criteria

Phase 1 is complete only when a fresh Windows package starts on a machine/process environment with no usable system Python or Docker, starts the bundled AgentScope 2.0.6 service through CPython 3.11.16, proves authenticated loopback health, exposes only redacted status, shuts down its own AgentScope child, leaves the separately running model service untouched, and passes every verification command above. The desktop must still identify the active request backend as `legacy`; changing it belongs to Phase 2.
