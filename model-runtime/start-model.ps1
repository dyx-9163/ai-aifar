[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet('gpu','hybrid','cpu')]
    [string]$Profile = 'gpu'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

function Wait-ModelHealth {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('gpu','hybrid','cpu')]
        [string]$ExpectedProfile,
        [int]$TimeoutSec = 300
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    do {
        try {
            $ownership = Assert-ModelRuntimeOwnership -ExpectedProfile $ExpectedProfile
            return Get-ModelRuntimeSnapshot -Ownership $ownership
        } catch {
            Start-Sleep -Seconds 5
        }
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Model runtime did not become healthy within $TimeoutSec seconds."
}

function Start-ModelProfile {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('gpu','hybrid','cpu')]
        [string]$SelectedProfile
    )

    Invoke-ModelCompose -ComposeArguments @('--profile', $SelectedProfile, 'up', '-d', "llama-$SelectedProfile")
    $null = Wait-ModelHealth -ExpectedProfile $SelectedProfile -TimeoutSec 300
}

function Get-ModelUtcNow {
    [DateTimeOffset]::UtcNow
}

function Get-ModelGpuState {
    $raw = @(Invoke-ModelCompose -ComposeArguments @('--profile', '*', 'ps', '--all', '--format', 'json'))
    try {
        $containers = @((($raw -join [Environment]::NewLine) | ConvertFrom-Json) | Where-Object { $null -ne $_ })
    } catch {
        return $null
    }

    $projectContainers = @($containers | Where-Object {
        [string](Get-ModelPropertyValue -InputObject $_ -Name 'Project') -ceq $script:ModelComposeProject
    })
    if (
        $projectContainers.Count -ne 1 -or
        [string](Get-ModelPropertyValue -InputObject $projectContainers[0] -Name 'Service') -cne 'llama-gpu'
    ) {
        return $null
    }
    $projectContainers[0]
}

function Get-ModelGpuLogs {
    param([Parameter(Mandatory)][DateTimeOffset]$Since)

    $sinceText = $Since.ToUniversalTime().ToString('o')
    Invoke-ModelCompose -ComposeArguments @('--profile', 'gpu', 'logs', '--no-color', '--since', $sinceText, 'llama-gpu') -AllowFailure 2>&1 | Out-String
}

function Test-ModelGpuFallbackEvidence {
    param(
        [AllowNull()]$State,
        [AllowEmptyString()][string]$Logs
    )

    if ($null -eq $State) {
        return $false
    }
    $stateName = ([string]$State.State).ToLowerInvariant()
    $health = ([string]$State.Health).ToLowerInvariant()
    $failedState = @('exited', 'dead', 'restarting') -contains $stateName
    if (-not $failedState -and $health -ne 'unhealthy') {
        return $false
    }
    $Logs -match '(?i)(out of memory|cuda[^\r\n]*(error|fail)|failed to load|model[^\r\n]*load[^\r\n]*fail)'
}

function Invoke-StartModel {
    param(
        [ValidateSet('gpu','hybrid','cpu')]
        [string]$Profile = 'gpu'
    )

    Assert-ModelArtifacts | Format-Table -AutoSize
    Assert-ModelDockerDaemon
    $existingOwnership = Get-ModelRuntimeOwnership
    if ($null -eq $existingOwnership) {
        Assert-ModelPortAvailable
    } else {
        Write-Host "Stopping exactly owned '$($existingOwnership.Profile)' profile before switching."
        Invoke-ModelCompose -ComposeArguments @('--profile', '*', 'down')
        Assert-ModelPortAvailable
    }
    $attemptStartedAt = Get-ModelUtcNow

    try {
        Start-ModelProfile -SelectedProfile $Profile
    } catch {
        $startupFailure = $_
        if ($Profile -ne 'gpu') {
            throw
        }

        try {
            $gpuState = Get-ModelGpuState
            $gpuLogs = Get-ModelGpuLogs -Since $attemptStartedAt
        } catch {
            throw $startupFailure
        }
        if (-not (Test-ModelGpuFallbackEvidence -State $gpuState -Logs $gpuLogs)) {
            throw $startupFailure
        }

        Write-Warning 'GPU startup failed with current-attempt GPU/model-load evidence. Falling back once to the hybrid profile.'
        Invoke-ModelCompose -ComposeArguments @('--profile', '*', 'down')
        Assert-ModelPortAvailable
        Start-ModelProfile -SelectedProfile 'hybrid'
        $Profile = 'hybrid'
    }

    Write-Host "Model runtime is healthy using the '$Profile' profile at $script:ModelBaseUri."
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-StartModel -Profile $Profile
}
