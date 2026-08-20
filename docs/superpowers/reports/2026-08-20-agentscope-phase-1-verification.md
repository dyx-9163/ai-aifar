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
environment that has no inherited `PATH`, `PYTHONHOME`, virtualenv, Conda, or host
`PYTHONPATH`. The exact child environment deliberately sets a packaged `PYTHONPATH` containing
only the manifest-owned application and site-packages directories. The package E2E starts no
Docker command or Docker process.

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

The review hardening adds two further ownership and disclosure contracts:

- a synthetic known secret and a 43-character bootstrap-token-shaped value are injected into
  captured output, health diagnostics, and error stacks; composed failure text contains only fixed
  redaction placeholders, while leak-scan failures expose counts rather than captured values;
- if Electron launch resolves only after the launch timeout, the late application is closed, or its
  owned process is killed if close cannot complete, so the timed-out launch cannot become an orphan.

## 4. Phase 1 routing boundary

Phase 1 still reports `agentBackend: legacy`. AgentScope is packaged, authenticated, supervised,
health-checked, and lifecycle-owned by the desktop application, but **no model request is routed
through AgentScope in Phase 1**. Existing model/provider requests continue through the legacy
TypeScript routing path. Moving all model traffic to AgentScope is a later phase and is not claimed
by this verification.

## 5. Verification matrix

The Task 9 source and focused lifecycle gates are green:

| Gate | Result |
| --- | --- |
| `pnpm agentscope:test` | PASS, 10 tests |
| `pnpm agentscope:verify` | PASS, 11,662-file verified runtime |
| AgentScope TypeScript contract suites | PASS, 6 files / 131 tests; 1 environment skip |
| `pnpm test` | PASS, 33 files / 676 tests |
| `pnpm typecheck` | PASS |
| fresh `pnpm package` | PASS, package inventory above |
| focused packaged AgentScope E2E | PASS, review-hardened test in 3.0 seconds |
| `git diff --check` | PASS |

The first complete packaged `tests/e2e/app.spec.ts` run finished 10/12. The AgentScope lifecycle
test passed; two pre-dispatch Qoder/provider tests remained red: a strict multi-row locator and an
obsolete failed-turn UI expectation. On the Qoder dirty baseline, both were repaired as minimal,
unstaged test-only changes. Their focused tests passed, and the complete packaged file then passed
12/12 in 16.4 seconds.

### Review-fix RED/GREEN evidence

The review contracts were exercised with repository-local Vitest:

| Stage | Command | Result |
| --- | --- | --- |
| Initial RED | `node node_modules/vitest/vitest.mjs run tests/agentScopeRuntimePackaging.test.ts` | FAIL: lifecycle harness module absent after tests were added |
| Mutation RED | `node node_modules/vitest/vitest.mjs run tests/agentScopeRuntimePackaging.test.ts -t "redacts lifecycle secrets\|closes an application"` | FAIL, 2/2: raw known secret/token appeared in the composed diagnostic; late application remained open |
| Focused GREEN | same targeted command | PASS, 2/2 |
| Contract GREEN | `node node_modules/vitest/vitest.mjs run tests/agentScopeRuntimePackaging.test.ts tests/packageContents.test.ts` | PASS, 2 files / 38 tests; 1 environment skip |
| Type GREEN | `pnpm typecheck` | PASS |

## 6. Rollback

Phase 1 introduced no database migration and performs no user-data conversion. Rollback therefore
does not delete or rewrite a user's data directory. Revert every Phase 1 commit in this exact
newest-to-oldest order:

```text
28c8a78 7612ff7 edb2d67 df07863 2db8321 06b299f 837187b 994bfcc 5748f6d 4bcbe6b 21b2856
5776095 90e982e 8a64ec8 b71c0e1 4981e59 83dd0fe e741f44 482ea0c a2d473e 244e117
b79db0b e216dae
```

Then rebuild the desktop artifact with the normal verified package command. No database down
migration, user-data export/import, or format conversion is required.

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
