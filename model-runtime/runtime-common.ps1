Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ModelComposeProject = 'ai-aifar-model'
$script:ModelRuntimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:ModelComposeFile = (Resolve-Path -LiteralPath (Join-Path $script:ModelRuntimeRoot 'compose.yaml')).Path
$script:ModelEnvironmentFile = if (Test-Path -LiteralPath (Join-Path $script:ModelRuntimeRoot '.env')) {
    (Resolve-Path -LiteralPath (Join-Path $script:ModelRuntimeRoot '.env')).Path
} else {
    (Resolve-Path -LiteralPath (Join-Path $script:ModelRuntimeRoot '.env.example')).Path
}
$script:ModelArtifactsRoot = Join-Path (Split-Path -Parent $script:ModelRuntimeRoot) 'models'
$script:ModelBaseUri = 'http://127.0.0.1:8080'
$script:ModelName = 'Qwen3.5-9B'

function Get-ExpectedModelArtifacts {
    @(
        [pscustomobject]@{ Name='Qwen_Qwen3.5-9B-Q4_K_M.gguf'; Length=6169341984L; Sha256='D784CE9EDA1A5A7B51E8F705A9E6310844BF4F173654D115823C775FDEA56D43' },
        [pscustomobject]@{ Name='mmproj-Qwen_Qwen3.5-9B-bf16.gguf'; Length=921704896L; Sha256='D89C4BC142D02ED64AEED5C0A358BDEAD9109F21F4ADA03A6B2DF17A1AA94D9E' }
    )
}

function Assert-ModelArtifacts {
    foreach ($artifact in Get-ExpectedModelArtifacts) {
        $path = Join-Path $script:ModelArtifactsRoot $artifact.Name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required model artifact is missing: $path"
        }

        $file = Get-Item -LiteralPath $path
        if ($file.Length -ne $artifact.Length) {
            throw "Model artifact length mismatch for $($artifact.Name): expected $($artifact.Length), got $($file.Length)"
        }

        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
        if ($actualHash -ne $artifact.Sha256) {
            throw "Model artifact SHA-256 mismatch for $($artifact.Name): expected $($artifact.Sha256), got $actualHash"
        }

        [pscustomobject]@{ Name=$artifact.Name; Path=$path; Length=$file.Length; Sha256=$actualHash }
    }
}

function Assert-ModelDockerDaemon {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLI is not available on PATH.'
    }

    & docker version --format '{{.Server.Version}}' *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker daemon is not available.'
    }
}

function Assert-ModelPortAvailable {
    param([int]$Port = 8080)

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
    } catch {
        throw "TCP port 127.0.0.1:$Port is already in use. Stop the owning service before starting the model runtime."
    } finally {
        $listener.Stop()
    }
}

function Invoke-ModelCompose {
    param(
        [Parameter(Mandatory, Position=0)]
        [string[]]$ComposeArguments,
        [switch]$AllowFailure
    )

    $dockerArguments = @(
        'compose',
        '-f', $script:ModelComposeFile,
        '-p', $script:ModelComposeProject,
        '--env-file', $script:ModelEnvironmentFile
    ) + $ComposeArguments

    & docker @dockerArguments
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "Docker Compose exited with code $exitCode."
    }
}

function Invoke-ModelDocker {
    param(
        [Parameter(Mandatory, Position=0)]
        [string[]]$DockerArguments
    )

    # Docker CLI emits UTF-8; capture bytes ourselves because the console
    # output code page on Windows defaults to the system ANSI code page and
    # corrupts non-ASCII payload into invalid JSON.
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo.FileName = 'docker'
    $quoted = @($DockerArguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    })
    $process.StartInfo.Arguments = ($quoted -join ' ')
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $process.StartInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $null = $process.Start()
    $output = $process.StandardOutput.ReadToEnd()
    $errors = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "Docker CLI failed with exit code $($process.ExitCode): $($errors.Trim())"
    }
    $output
}

function Get-ModelPropertyValue {
    param(
        [AllowNull()]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $InputObject) {
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    $property.Value
}

function Get-ModelProjectContainerStates {
    # Uses docker ps/inspect instead of 'compose ps --format json' because the
    # compose JSON renderer truncates long fields into syntactically invalid JSON.
    $raw = Invoke-ModelDocker -DockerArguments @(
        'ps', '--all', '--quiet',
        '--filter', "label=com.docker.compose.project=$script:ModelComposeProject"
    )
    $containerIds = @($raw -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($containerIds.Count -eq 0) {
        return @()
    }

    $inspectRaw = Invoke-ModelDocker -DockerArguments (@('inspect') + $containerIds)
    # Windows PowerShell 5.1 emits a top-level JSON array from ConvertFrom-Json
    # as a single pipeline item, so unwrap one nested array layer explicitly.
    $containers = @($inspectRaw | ConvertFrom-Json)
    if ($containers.Count -eq 1 -and $containers[0] -is [System.Array]) {
        $containers = @($containers[0])
    }
    $records = @()
    foreach ($container in $containers) {
        $labels = Get-ModelPropertyValue -InputObject $container -Name 'Config' |
            ForEach-Object { Get-ModelPropertyValue -InputObject $_ -Name 'Labels' }
        $state = Get-ModelPropertyValue -InputObject $container -Name 'State'
        $health = Get-ModelPropertyValue -InputObject $state -Name 'Health' |
            ForEach-Object { Get-ModelPropertyValue -InputObject $_ -Name 'Status' }
        $publishers = @()
        $ports = Get-ModelPropertyValue -InputObject (Get-ModelPropertyValue -InputObject $container -Name 'NetworkSettings') -Name 'Ports'
        if ($null -ne $ports) {
            foreach ($property in $ports.PSObject.Properties) {
                $parts = @([string]$property.Name -split '/')
                foreach ($binding in @($property.Value)) {
                    if ($null -eq $binding) { continue }
                    $publishers += [pscustomobject]@{
                        URL = [string](Get-ModelPropertyValue -InputObject $binding -Name 'HostIp')
                        PublishedPort = [int][string](Get-ModelPropertyValue -InputObject $binding -Name 'HostPort')
                        TargetPort = [int]$parts[0]
                        Protocol = [string]$parts[1]
                    }
                }
            }
        }
        $records += [pscustomobject]@{
            Project = [string](Get-ModelPropertyValue -InputObject $labels -Name 'com.docker.compose.project')
            Service = [string](Get-ModelPropertyValue -InputObject $labels -Name 'com.docker.compose.service')
            State = [string](Get-ModelPropertyValue -InputObject $state -Name 'Status')
            Health = [string]$health
            Publishers = $publishers
        }
    }
    $records
}

function Get-ModelRuntimeOwnership {
    $containers = @(Get-ModelProjectContainerStates)
    $allowedServices = @('llama-gpu', 'llama-hybrid', 'llama-cpu')
    $activeContainers = @($containers | Where-Object {
        $project = [string](Get-ModelPropertyValue -InputObject $_ -Name 'Project')
        $state = ([string](Get-ModelPropertyValue -InputObject $_ -Name 'State')).ToLowerInvariant()
        $project -ceq $script:ModelComposeProject -and @('running', 'restarting', 'paused') -contains $state
    })

    if ($activeContainers.Count -eq 0) {
        return $null
    }
    if ($activeContainers.Count -ne 1) {
        throw "Fixed-project runtime ownership is ambiguous; found $($activeContainers.Count) active containers."
    }

    $container = $activeContainers[0]
    $service = [string](Get-ModelPropertyValue -InputObject $container -Name 'Service')
    $state = ([string](Get-ModelPropertyValue -InputObject $container -Name 'State')).ToLowerInvariant()
    $publishers = @(Get-ModelPropertyValue -InputObject $container -Name 'Publishers')
    $matchingPublishers = @($publishers | Where-Object {
        $url = [string](Get-ModelPropertyValue -InputObject $_ -Name 'URL')
        $publishedPort = Get-ModelPropertyValue -InputObject $_ -Name 'PublishedPort'
        $targetPort = Get-ModelPropertyValue -InputObject $_ -Name 'TargetPort'
        $url -ceq '127.0.0.1' -and $publishedPort -eq 8080 -and $targetPort -eq 8080
    })
    if (-not ($allowedServices -ccontains $service) -or $publishers.Count -ne 1 -or $matchingPublishers.Count -ne 1) {
        throw 'Fixed-project runtime ownership is ambiguous; the active service or loopback publisher is not exact.'
    }

    [pscustomobject]@{
        Project = $script:ModelComposeProject
        Profile = $service.Substring('llama-'.Length)
        Service = $service
        State = $state
        Host = '127.0.0.1'
        Port = 8080
    }
}

function Assert-ModelRuntimeOwnership {
    param(
        [ValidateSet('gpu','hybrid','cpu')]
        [string]$ExpectedProfile
    )

    $ownership = Get-ModelRuntimeOwnership
    if ($null -eq $ownership) {
        throw "Expected exactly one running '$script:ModelComposeProject' container to own 127.0.0.1:8080; found 0."
    }
    if ($PSBoundParameters.ContainsKey('ExpectedProfile') -and $ownership.Profile -cne $ExpectedProfile) {
        throw "Expected the '$ExpectedProfile' runtime profile, but '$($ownership.Profile)' is active."
    }
    $ownership
}

function Invoke-ModelEndpoint {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [int]$TimeoutSec = 5
    )

    Invoke-RestMethod -Method Get -Uri "$script:ModelBaseUri$Path" -TimeoutSec $TimeoutSec
}

function Assert-ModelHealthResponse {
    param([Parameter(Mandatory)]$Health)

    $status = Get-ModelPropertyValue -InputObject $Health -Name 'status'
    if ($status -isnot [string] -or $status -cne 'ok') {
        throw "Model health did not report the exact expected status 'ok'."
    }
}

function Assert-ModelDiscoveryResponse {
    param([Parameter(Mandatory)]$Models)

    $data = Get-ModelPropertyValue -InputObject $Models -Name 'data'
    if ($null -eq $data) {
        throw 'Model discovery did not contain a data array.'
    }
    $ids = @(@($data) | ForEach-Object { Get-ModelPropertyValue -InputObject $_ -Name 'id' })
    if (@($ids | Where-Object { $_ -is [string] -and $_ -ceq $script:ModelName }).Count -ne 1) {
        throw "Model discovery did not contain the exact expected model '$script:ModelName'."
    }
}

function Test-ModelInteger {
    param([AllowNull()]$Value)

    $Value -is [byte] -or $Value -is [sbyte] -or
        $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64]
}

function Assert-ModelPropsResponse {
    param([Parameter(Mandatory)]$Props)

    $totalSlots = Get-ModelPropertyValue -InputObject $Props -Name 'total_slots'
    if (-not (Test-ModelInteger -Value $totalSlots) -or $totalSlots -lt 1 -or $totalSlots -gt [int]::MaxValue) {
        throw 'Model props did not contain a positive integer total_slots value.'
    }
    [int]$totalSlots
}

function Assert-ModelSlotsResponse {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Slots
    )

    if ($Slots.Count -lt 1) {
        throw 'Model slots did not contain a non-empty array.'
    }
    $identities = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($slot in $Slots) {
        $id = Get-ModelPropertyValue -InputObject $slot -Name 'id'
        if ($null -eq $id -or ($id -isnot [string] -and -not (Test-ModelInteger -Value $id))) {
            throw 'Every model slot must contain a string or integer id.'
        }
        if (-not $identities.Add("$($id.GetType().FullName):$id")) {
            throw 'Model slots contained a duplicate id.'
        }
    }
    $Slots.Count
}

function Assert-ModelSlotCount {
    param(
        [Parameter(Mandatory)][int]$Expected,
        [Parameter(Mandatory)][int]$Actual
    )

    if ($Expected -ne $Actual) {
        throw "Model props reported $Expected slots, but /slots exposed $Actual."
    }
}

function Assert-ModelCompletionResponse {
    param([Parameter(Mandatory)]$Completion)

    $choices = @(Get-ModelPropertyValue -InputObject $Completion -Name 'choices')
    if ($choices.Count -lt 1) {
        throw 'The completion response did not contain a choice.'
    }
    $message = Get-ModelPropertyValue -InputObject $choices[0] -Name 'message'
    $content = Get-ModelPropertyValue -InputObject $message -Name 'content'
    if ($content -isnot [string] -or [string]::IsNullOrWhiteSpace($content)) {
        throw 'The completion response did not contain a non-empty final answer.'
    }
}

function Get-ModelRuntimeSnapshot {
    param([Parameter(Mandatory)]$Ownership)

    $health = Invoke-ModelEndpoint -Path '/health' -TimeoutSec 5
    Assert-ModelHealthResponse -Health $health
    $models = Invoke-ModelEndpoint -Path '/v1/models' -TimeoutSec 5
    Assert-ModelDiscoveryResponse -Models $models
    $props = Invoke-ModelEndpoint -Path '/props' -TimeoutSec 5
    $totalSlots = Assert-ModelPropsResponse -Props $props
    $slotPayload = Invoke-ModelEndpoint -Path '/slots' -TimeoutSec 5
    $slots = @($slotPayload)
    $slotCount = Assert-ModelSlotsResponse -Slots $slots
    Assert-ModelSlotCount -Expected $totalSlots -Actual $slotCount

    [pscustomobject]@{
        Project = [string]$Ownership.Project
        Profile = [string]$Ownership.Profile
        State = [string]$Ownership.State
        Host = [string]$Ownership.Host
        Port = [int]$Ownership.Port
        Health = 'ok'
        Model = $script:ModelName
        Slots = $slotCount
    }
}
