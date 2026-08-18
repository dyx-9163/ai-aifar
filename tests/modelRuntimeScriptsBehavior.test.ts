import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(source: string) {
  const command = `$ErrorActionPreference = 'Stop'\nImport-Module Microsoft.PowerShell.Utility\ntry {\n${source}\nexit 0\n} catch {\n[Console]::Error.WriteLine(($_ | Out-String))\nexit 1\n}`;
  return spawnSync(
    'powershell.exe',
    [
      '-ExecutionPolicy',
      'Bypass',
      '-NoProfile',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}

function expectPowerShellSuccess(result: ReturnType<typeof runPowerShell>) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ai-aifar-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime script behavior', () => {
  it('dot-sources mutating entry scripts without performing actions', () => {
    const result = runPowerShell(`
      $script:DockerCalls = 0
      function global:docker { $script:DockerCalls++; throw 'unexpected Docker call' }
      . './model-runtime/start-model.ps1'
      . './model-runtime/stop-model.ps1'
      . './model-runtime/verify-model.ps1'
      if ($script:DockerCalls -ne 0) { throw "Observed $script:DockerCalls Docker calls" }
    `);

    expectPowerShellSuccess(result);
  });

  it('fails closed on a missing artifact before Docker', () => {
    const directory = makeTempDirectory();
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      $script:ModelArtifactsRoot = ${psLiteral(directory)}
      function global:Get-ExpectedModelArtifacts {
        , [pscustomobject]@{ Name='fixture.gguf'; Length=3L; Sha256='BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD' }
      }
      $script:DockerCalls = 0
      function global:docker { $script:DockerCalls++; $global:LASTEXITCODE = 0 }
      try { Invoke-StartModel -Profile cpu; throw 'Expected failure was not raised' }
      catch {
        if ($_.Exception.Message -notmatch 'Required model artifact is missing') { throw }
        if ($script:DockerCalls -ne 0) { throw 'Docker was called before missing artifact failure' }
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('fails closed on a corrupt artifact before Docker', () => {
    const directory = makeTempDirectory();
    const fixture = join(directory, 'fixture.gguf');
    writeFileSync(fixture, 'abc');
    const wrongHash = createHash('sha256').update('abd').digest('hex').toUpperCase();
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      $script:ModelArtifactsRoot = ${psLiteral(directory)}
      function global:Get-ExpectedModelArtifacts {
        , [pscustomobject]@{ Name='fixture.gguf'; Length=3L; Sha256=${psLiteral(wrongHash)} }
      }
      $script:DockerCalls = 0
      function global:docker { $script:DockerCalls++; $global:LASTEXITCODE = 0 }
      try { Invoke-StartModel -Profile cpu; throw 'Expected corrupt artifact failure' }
      catch {
        if ($_.Exception.Message -notmatch 'SHA-256 mismatch') { throw }
        if ($script:DockerCalls -ne 0) { throw 'Docker was called before corrupt artifact failure' }
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('rejects an occupied port', () => {
    const result = runPowerShell(`
      . './model-runtime/runtime-common.ps1'
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
      $listener.Start()
      try {
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        try { Assert-ModelPortAvailable -Port $port; throw 'Expected occupied port failure' }
        catch { if ($_.Exception.Message -notmatch 'already in use') { throw } }
      } finally {
        $listener.Stop()
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('passes Docker an exact fixed-project argument array', () => {
    const result = runPowerShell(`
      . './model-runtime/runtime-common.ps1'
      $script:ActualArguments = @()
      function global:docker { $script:ActualArguments = @($args); $global:LASTEXITCODE = 0 }
      Invoke-ModelCompose -ComposeArguments @('ps')
      $expected = @('compose', '-f', $script:ModelComposeFile, '-p', 'ai-aifar-model', '--env-file', $script:ModelEnvironmentFile, 'ps')
      if (Compare-Object $expected $script:ActualArguments -SyncWindow 0) { throw 'Docker argument scoping mismatch' }
    `);

    expectPowerShellSuccess(result);
  });

  it('stops only all profiles in the fixed project without volumes', () => {
    const result = runPowerShell(`
      . './model-runtime/stop-model.ps1'
      function global:Assert-ModelDockerDaemon {}
      $script:ComposeCalls = @()
      function global:Invoke-ModelCompose { param([string[]]$ComposeArguments) $script:ComposeCalls += , @($ComposeArguments) }
      Invoke-StopModel
      $actual = @($script:ComposeCalls[0])
      $expected = @('--profile', '*', 'down')
      if (Compare-Object $expected $actual -SyncWindow 0) { throw 'Unexpected stop mutation' }
      if ($actual -contains '--volumes') { throw 'Stop requested volumes' }
    `);

    expectPowerShellSuccess(result);
  });

  it('keeps a successful GPU start on GPU without fallback', () => {
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      function global:Assert-ModelArtifacts {}
      function global:Assert-ModelDockerDaemon {}
      function global:Assert-ModelPortAvailable {}
      function global:Get-ModelRuntimeOwnership { return $null }
      $script:Profiles = [System.Collections.Generic.List[string]]::new()
      function global:Start-ModelProfile { param([string]$SelectedProfile) $script:Profiles.Add($SelectedProfile) }
      Invoke-StartModel -Profile gpu
      if (($script:Profiles -join ',') -ne 'gpu') { throw "Unexpected profiles: $($script:Profiles -join ',')" }
    `);

    expectPowerShellSuccess(result);
  });

  it('uses only current-attempt logs and unhealthy scoped state for one GPU fallback', () => {
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      function global:Assert-ModelArtifacts {}
      function global:Assert-ModelDockerDaemon {}
      function global:Assert-ModelPortAvailable {}
      function global:Get-ModelRuntimeOwnership { return $null }
      function global:Get-ModelUtcNow { [DateTimeOffset]::Parse('2026-08-18T01:02:03Z') }
      $script:Profiles = [System.Collections.Generic.List[string]]::new()
      function global:Start-ModelProfile {
        param([string]$SelectedProfile)
        $script:Profiles.Add($SelectedProfile)
        if ($SelectedProfile -eq 'gpu') { throw 'GPU health failed' }
      }
      $script:ComposeCalls = [System.Collections.Generic.List[string]]::new()
      function global:Invoke-ModelCompose {
        param([string[]]$ComposeArguments, [switch]$AllowFailure)
        $script:ComposeCalls.Add(($ComposeArguments -join '|'))
        if ($ComposeArguments -contains 'ps') {
          return '[{"Project":"ai-aifar-model","Service":"llama-gpu","State":"running","Health":"unhealthy","Publishers":[]}]'
        }
        if ($ComposeArguments -contains 'logs') { return 'CUDA error while loading current attempt' }
      }
      Invoke-StartModel -Profile gpu
      if (($script:Profiles -join ',') -ne 'gpu,hybrid') { throw "Unexpected profiles: $($script:Profiles -join ',')" }
      $logCall = @($script:ComposeCalls | Where-Object { $_ -match '\\|logs\\|' })
      if ($logCall.Count -ne 1 -or $logCall[0] -notmatch '\\|--since\\|2026-08-18T01:02:03') { throw "Logs were not bounded to the current attempt: $($script:ComposeCalls -join ',')" }
      $downCall = @($script:ComposeCalls | Where-Object { $_ -eq '--profile|*|down' })
      if ($downCall.Count -ne 1) { throw 'Fallback did not perform exactly one scoped down' }
    `);

    expectPowerShellSuccess(result);
  });

  it('does not fallback from a failed GPU attempt whose current scoped state is healthy', () => {
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      function global:Assert-ModelArtifacts {}
      function global:Assert-ModelDockerDaemon {}
      function global:Assert-ModelPortAvailable {}
      function global:Get-ModelRuntimeOwnership { return $null }
      function global:Get-ModelUtcNow { [DateTimeOffset]::Parse('2026-08-18T01:02:03Z') }
      $script:Profiles = [System.Collections.Generic.List[string]]::new()
      function global:Start-ModelProfile {
        param([string]$SelectedProfile)
        $script:Profiles.Add($SelectedProfile)
        throw 'synthetic health failure'
      }
      function global:Invoke-ModelCompose {
        param([string[]]$ComposeArguments, [switch]$AllowFailure)
        if ($ComposeArguments -contains 'ps') {
          return '[{"Project":"ai-aifar-model","Service":"llama-gpu","State":"running","Health":"healthy","Publishers":[]}]'
        }
        if ($ComposeArguments -contains 'logs') { return 'CUDA error from retained history' }
      }
      try { Invoke-StartModel -Profile gpu; throw 'Expected original GPU failure' }
      catch {
        if ($_.Exception.Message -notmatch 'synthetic health failure') { throw }
        if (($script:Profiles -join ',') -ne 'gpu') { throw 'Healthy state incorrectly authorized fallback' }
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('does not stop the project for GPU fallback when scoped profile state is ambiguous', () => {
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      function global:Assert-ModelArtifacts {}
      function global:Assert-ModelDockerDaemon {}
      function global:Assert-ModelPortAvailable {}
      function global:Get-ModelRuntimeOwnership { return $null }
      function global:Get-ModelUtcNow { [DateTimeOffset]::Parse('2026-08-18T01:02:03Z') }
      function global:Start-ModelProfile { throw 'synthetic GPU health failure' }
      $script:ComposeCalls = [System.Collections.Generic.List[string]]::new()
      function global:Invoke-ModelCompose {
        param([string[]]$ComposeArguments, [switch]$AllowFailure)
        $script:ComposeCalls.Add(($ComposeArguments -join '|'))
        if ($ComposeArguments -contains 'ps') {
          if ($ComposeArguments[-1] -eq 'llama-gpu') {
            return '[{"Project":"ai-aifar-model","Service":"llama-gpu","State":"running","Health":"unhealthy","Publishers":[{"URL":"127.0.0.1","PublishedPort":8080,"TargetPort":8080}]}]'
          }
          return '[{"Project":"ai-aifar-model","Service":"llama-gpu","State":"running","Health":"unhealthy","Publishers":[{"URL":"127.0.0.1","PublishedPort":8080,"TargetPort":8080}]},{"Project":"ai-aifar-model","Service":"llama-hybrid","State":"running","Health":"unhealthy","Publishers":[{"URL":"127.0.0.1","PublishedPort":8080,"TargetPort":8080}]}]'
        }
        if ($ComposeArguments -contains 'logs') { return 'CUDA error while loading current attempt' }
      }
      try { Invoke-StartModel -Profile gpu; throw 'Expected original GPU failure' }
      catch {
        if ($_.Exception.Message -notmatch 'synthetic GPU health failure') { throw }
        if (@($script:ComposeCalls | Where-Object { $_ -eq '--profile|*|down' }).Count -ne 0) { throw 'Ambiguous scoped state authorized a project stop' }
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('rejects absent and ambiguous fixed-project ownership', () => {
    const result = runPowerShell(`
      . './model-runtime/runtime-common.ps1'
      function global:Invoke-ModelCompose { return '[]' }
      try { Assert-ModelRuntimeOwnership; throw 'Expected absent ownership failure' }
      catch { if ($_.Exception.Message -notmatch 'exactly one') { throw } }
      function global:Invoke-ModelCompose {
        return '[{"Project":"ai-aifar-model","Service":"llama-gpu","State":"exited"}]'
      }
      try { Assert-ModelRuntimeOwnership; throw 'Expected non-owner failure' }
      catch { if ($_.Exception.Message -notmatch 'exactly one') { throw } }
      function global:Invoke-ModelCompose {
        return '[{"Project":"ai-aifar-model","Service":"llama-gpu","State":"running","Publishers":[{"URL":"127.0.0.1","PublishedPort":8080,"TargetPort":8080}]},{"Project":"ai-aifar-model","Service":"llama-cpu","State":"running","Publishers":[{"URL":"127.0.0.1","PublishedPort":8080,"TargetPort":8080}]}]'
      }
      try { Assert-ModelRuntimeOwnership; throw 'Expected ambiguous ownership failure' }
      catch { if ($_.Exception.Message -notmatch 'ambiguous') { throw } }
    `);

    expectPowerShellSuccess(result);
  });

  it('accepts exactly one fixed-project loopback owner', () => {
    const result = runPowerShell(`
      . './model-runtime/runtime-common.ps1'
      function global:Invoke-ModelCompose {
        return '[{"Project":"ai-aifar-model","Service":"llama-hybrid","State":"running","Publishers":[{"URL":"127.0.0.1","PublishedPort":8080,"TargetPort":8080}]}]'
      }
      Assert-ModelRuntimeOwnership
    `);

    expectPowerShellSuccess(result);
  });

  it('stops an exactly owned active profile before switching and rechecks the port', () => {
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      function global:Assert-ModelArtifacts {}
      function global:Assert-ModelDockerDaemon {}
      function global:Get-ModelRuntimeOwnership {
        [pscustomobject]@{ Project='ai-aifar-model'; Profile='gpu'; Service='llama-gpu'; State='running'; Host='127.0.0.1'; Port=8080 }
      }
      $script:Events = [System.Collections.Generic.List[string]]::new()
      function global:Assert-ModelPortAvailable { $script:Events.Add('port') }
      function global:Invoke-ModelCompose {
        param([string[]]$ComposeArguments)
        $script:Events.Add(('compose:' + ($ComposeArguments -join '|')))
      }
      function global:Start-ModelProfile {
        param([string]$SelectedProfile)
        $script:Events.Add("start:$SelectedProfile")
      }
      Invoke-StartModel -Profile hybrid
      $expected = @('compose:--profile|*|down', 'port', 'start:hybrid')
      if (Compare-Object $expected @($script:Events) -SyncWindow 0) { throw "Unexpected switch sequence: $($script:Events -join ',')" }
      if (@($script:Events | Where-Object { $_ -match 'volumes' }).Count -ne 0) { throw 'Switch requested volumes' }
    `);

    expectPowerShellSuccess(result);
  });

  it('rejects an unrelated occupied port without stopping any project', () => {
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      function global:Assert-ModelArtifacts {}
      function global:Assert-ModelDockerDaemon {}
      function global:Get-ModelRuntimeOwnership { return $null }
      function global:Assert-ModelPortAvailable { throw 'TCP port 127.0.0.1:8080 is already in use by an unrelated owner.' }
      $script:Mutations = 0
      function global:Invoke-ModelCompose { $script:Mutations++ }
      function global:Start-ModelProfile { $script:Mutations++ }
      try { Invoke-StartModel -Profile cpu; throw 'Expected unrelated-owner rejection' }
      catch {
        if ($_.Exception.Message -notmatch 'unrelated owner') { throw }
        if ($script:Mutations -ne 0) { throw 'Unrelated owner triggered a runtime mutation' }
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('rejects ambiguous fixed-project ownership before port checks or mutations', () => {
    const result = runPowerShell(`
      . './model-runtime/start-model.ps1'
      function global:Assert-ModelArtifacts {}
      function global:Assert-ModelDockerDaemon {}
      function global:Get-ModelRuntimeOwnership { throw 'Fixed-project ownership is ambiguous.' }
      $script:PortChecks = 0
      $script:Mutations = 0
      function global:Assert-ModelPortAvailable { $script:PortChecks++ }
      function global:Invoke-ModelCompose { $script:Mutations++ }
      function global:Start-ModelProfile { $script:Mutations++ }
      try { Invoke-StartModel -Profile cpu; throw 'Expected ambiguous-owner rejection' }
      catch {
        if ($_.Exception.Message -notmatch 'ambiguous') { throw }
        if ($script:PortChecks -ne 0 -or $script:Mutations -ne 0) { throw 'Ambiguous owner passed a safety boundary' }
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('rejects active fixed-project containers unless ownership is exact', () => {
    const result = runPowerShell(`
      . './model-runtime/runtime-common.ps1'
      function global:Invoke-ModelCompose {
        return '[{"Project":"ai-aifar-model","Service":"llama-gpu","State":"running","Publishers":[]}]'
      }
      try { Get-ModelRuntimeOwnership; throw 'Expected publisher rejection' }
      catch { if ($_.Exception.Message -notmatch 'ambiguous') { throw } }
      function global:Invoke-ModelCompose {
        return '[{"Project":"ai-aifar-model","Service":"unexpected","State":"running","Publishers":[{"URL":"127.0.0.1","PublishedPort":8080,"TargetPort":8080}]}]'
      }
      try { Get-ModelRuntimeOwnership; throw 'Expected service rejection' }
      catch { if ($_.Exception.Message -notmatch 'ambiguous') { throw } }
    `);

    expectPowerShellSuccess(result);
  });

  it('enforces the strict shared runtime endpoint contract', () => {
    const result = runPowerShell(`
      . './model-runtime/runtime-common.ps1'
      Assert-ModelHealthResponse -Health ([pscustomobject]@{ status='ok' })
      Assert-ModelDiscoveryResponse -Models ([pscustomobject]@{ data=@([pscustomobject]@{ id='Qwen3.5-9B' }) })
      $totalSlots = Assert-ModelPropsResponse -Props ([pscustomobject]@{ total_slots=2 })
      $slotCount = Assert-ModelSlotsResponse -Slots @([pscustomobject]@{ id=0 }, [pscustomobject]@{ id=1 })
      Assert-ModelSlotCount -Expected $totalSlots -Actual $slotCount
      Assert-ModelCompletionResponse -Completion ([pscustomobject]@{ choices=@([pscustomobject]@{ message=[pscustomobject]@{ content='verified' } }) })

      $invalidCases = @(
        { Assert-ModelHealthResponse -Health ([pscustomobject]@{ status='loading' }) },
        { Assert-ModelDiscoveryResponse -Models ([pscustomobject]@{ data=@([pscustomobject]@{ id='qwen3.5-9b' }) }) },
        { Assert-ModelPropsResponse -Props ([pscustomobject]@{}) },
        { Assert-ModelSlotsResponse -Slots @() },
        { Assert-ModelSlotsResponse -Slots @([pscustomobject]@{ id=0 }, [pscustomobject]@{ id=0 }) },
        { Assert-ModelSlotCount -Expected 2 -Actual 1 },
        { Assert-ModelCompletionResponse -Completion ([pscustomobject]@{ choices=@([pscustomobject]@{ message=[pscustomobject]@{ content='   ' } }) }) }
      )
      foreach ($case in $invalidCases) {
        $failed = $false
        try { & $case } catch { $failed = $true }
        if (-not $failed) { throw 'An invalid endpoint response was accepted.' }
      }
    `);

    expectPowerShellSuccess(result);
  });

  it('builds a sanitized snapshot from health, model, props, and slots', () => {
    const result = runPowerShell(`
      . './model-runtime/runtime-common.ps1'
      $ownership = [pscustomobject]@{ Project='ai-aifar-model'; Profile='hybrid'; Service='llama-hybrid'; State='running'; Host='127.0.0.1'; Port=8080 }
      $script:Paths = [System.Collections.Generic.List[string]]::new()
      function global:Invoke-ModelEndpoint {
        param([string]$Path)
        $script:Paths.Add($Path)
        switch ($Path) {
          '/health' { return [pscustomobject]@{ status='ok'; secret='do-not-report' } }
          '/v1/models' { return [pscustomobject]@{ data=@([pscustomobject]@{ id='Qwen3.5-9B'; body='do-not-report' }) } }
          '/props' { return [pscustomobject]@{ total_slots=2; prompt='do-not-report' } }
          '/slots' {
            Write-Output -NoEnumerate @([pscustomobject]@{ id=0; response='do-not-report' }, [pscustomobject]@{ id=1 })
            return
          }
        }
      }
      $snapshot = Get-ModelRuntimeSnapshot -Ownership $ownership
      if (($script:Paths -join ',') -ne '/health,/v1/models,/props,/slots') { throw 'Endpoint coverage mismatch' }
      if ($snapshot.Project -ne 'ai-aifar-model' -or $snapshot.Profile -ne 'hybrid' -or $snapshot.Port -ne 8080) { throw 'Ownership was not reported' }
      if ($snapshot.Health -ne 'ok' -or $snapshot.Model -ne 'Qwen3.5-9B' -or $snapshot.Slots -ne 2) { throw 'Validated endpoint summary mismatch' }
      $serialized = $snapshot | ConvertTo-Json -Compress
      if ($serialized -match 'do-not-report') { throw 'Raw endpoint content escaped the snapshot' }
    `);

    expectPowerShellSuccess(result);
  });

  it('blocks normal verification before endpoint access when ownership is absent', () => {
    const result = runPowerShell(`
      . './model-runtime/verify-model.ps1'
      function global:Assert-ModelArtifacts { , [pscustomobject]@{ Name='fixture'; Length=1; Sha256='hash' } }
      function global:Assert-ModelDockerDaemon {}
      function global:Assert-ModelRuntimeOwnership { throw 'No fixed-project owner' }
      $script:EndpointCalls = 0
      function global:Invoke-ModelEndpoint { $script:EndpointCalls++ }
      function global:Invoke-CompletionRequest { $script:EndpointCalls++ }
      try { Invoke-VerifyModel; throw 'Expected ownership failure' }
      catch {
        if ($_.Exception.Message -notmatch 'No fixed-project owner') { throw }
        if ($script:EndpointCalls -ne 0) { throw 'Endpoint accessed before ownership proof' }
      }
    `);

    expectPowerShellSuccess(result);
  });
});
