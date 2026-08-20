# AgentScope Phase 1 verification

Date: 2026-08-21
Target: Windows `win32-x64` packaged desktop application

## 1. Embedded runtime artifact

The fresh package contains a verified, application-owned runtime outside ASAR. The runtime
manifest pins CPython 3.11.16, AgentScope 2.0.6, and the Private AI AgentScope runtime 1.0.0.

- Runtime inventory: 11,662 files.
- Manifest SHA-256:
  `fdbab0a4b1dfd64cadf0256ad6d9bad96a9602c8ac32623f22be16bcb87daa10`.
- Outer package inventory: 11,738 files.
- ASAR inventory: 12 entries, 405,346 bytes.
- The independent package scanner recalculated the packaged runtime inventory and rejected
  unlisted files, links/reparse traversal, forbidden secrets, developer trees, models, installers,
  and caches.

The end-user package does not require a separately installed Python or Docker. The Supervisor
selects the manifest-owned absolute interpreter and creates the AgentScope child with an exact
environment that has no `PATH`, `PYTHONHOME`, `PYTHONPATH`, virtualenv, or Conda inheritance.
The package E2E starts no Docker command or Docker process.

## 2. Desktop lifecycle and public contract

The packaged application reached this public health transition:

```text
AgentScope starting
AgentScope ready: runtime 1.0.0, AgentScope 2.0.6
agentBackend: legacy
```

The public health object contains only `ok`, `version`, `agentBackend`, and the redacted
AgentScope state/version projection. It contains no token, port, PID, Python/interpreter path,
user-data path, log path, or raw process error.

An explicit E2E-only Main-process hook publishes only the ready loopback port to an absolute,
test-owned temporary file, using exclusive file creation. It is inactive unless the dedicated
environment variable is present. It does not change the renderer or public health API and never
publishes the bootstrap token.

## 3. Ownership and security acceptance

The focused packaged lifecycle acceptance passed and proved all of the following in one run:

- the existing external fake model endpoint responds before Electron starts;
- the embedded AgentScope service reaches ready;
- unauthenticated access to its private `/v1/health` endpoint returns HTTP 401;
- Electron shutdown stops the owned AgentScope child and the loopback port refuses connections;
- the external fake model endpoint still responds after Electron exits;
- captured stdout/stderr and the complete scoped user-data tree contain neither the injected known
  secret nor a 32-byte bootstrap-token-shaped base64url value.

The lifecycle test removes inherited Python/virtual-environment variables from Electron. The
external model sentinel demonstrates that desktop shutdown is ownership-scoped and does not stop
an independently hosted model service.

## 4. Verification matrix

The Task 9 source and focused lifecycle gates are green:

| Gate | Result |
| --- | --- |
| `pnpm agentscope:test` | PASS, 10 tests |
| `pnpm agentscope:verify` | PASS, 11,662-file verified runtime |
| AgentScope TypeScript contract suites | PASS, 6 files / 129 tests; 1 environment skip |
| `pnpm test` | PASS, 33 files / 676 tests |
| `pnpm typecheck` | PASS |
| fresh `pnpm package` | PASS, package inventory above |
| focused packaged AgentScope E2E | PASS, 1 test in 2.7 seconds |
| `git diff --check` | PASS |

The first complete packaged `tests/e2e/app.spec.ts` run finished 10/12. The AgentScope lifecycle
test passed; two pre-dispatch Qoder/provider tests remained red: a strict multi-row locator and an
obsolete failed-turn UI expectation. Those unrelated regressions are being repaired separately
and must be green before Phase 1 receives final completion status.

## Host test boundary

Launching Electron inside Codex's default outer file sandbox creates a nested sandbox conflict:
the Chromium GPU child exits with `-1073741515`, the renderer reports `ERR_FAILED`, and Main exits
before AgentScope can publish readiness. The same package and arguments outside that outer sandbox
load the renderer and pass the lifecycle acceptance. The product retains Electron's sandbox; no
`--no-sandbox`, GPU-disable, PATH-repair, or similar production workaround was added.

Literal empty, System32-only, and developer-tool-sanitized host PATH experiments were also blocked
at Chromium startup on this host. Therefore the packaged Electron E2E inherits the host PATH so
Chromium can start. No-system-Python/Docker acceptance instead rests on the verified embedded
artifact, absolute interpreter selection, exact no-PATH child environment, absence of Docker
operations, and the external-model ownership sentinel. This report does not claim the literal
empty-host-PATH renderer sub-gate passed.
