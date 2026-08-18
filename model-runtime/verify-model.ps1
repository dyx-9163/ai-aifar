[CmdletBinding()]
param(
    [switch]$ArtifactsOnly,
    [ValidateRange(1, 128)]
    [int]$ConcurrentRequests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

function New-CompletionJson {
    $utf8Marker = '{0}{1}' -f [char]0x4F60, [char]0x597D
    @{
        model = 'Qwen3.5-9B'
        messages = @(
            @{ role = 'user'; content = "Reply with exactly: UTF-8 verified - $utf8Marker" }
        )
        max_tokens = 32
        temperature = 0
        chat_template_kwargs = @{ enable_thinking = $false }
    } | ConvertTo-Json -Depth 10 -Compress
}

function Invoke-CompletionRequest {
    $json = New-CompletionJson
    $body = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Method Post -Uri "$script:ModelBaseUri/v1/chat/completions" -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 300
}

function Invoke-VerifyModel {
    param(
        [switch]$ArtifactsOnly,
        [ValidateRange(1, 128)]
        [int]$ConcurrentRequests
    )

    $verifiedArtifacts = @(Assert-ModelArtifacts)
    $verifiedArtifacts | Format-Table -AutoSize
    if ($ArtifactsOnly) {
        Write-Host "Verified $($verifiedArtifacts.Count) model artifacts."
        return
    }

    Assert-ModelDockerDaemon
    $ownership = Assert-ModelRuntimeOwnership
    $snapshot = Get-ModelRuntimeSnapshot -Ownership $ownership
    $completion = Invoke-CompletionRequest
    Assert-ModelCompletionResponse -Completion $completion

    $snapshot | Format-List Project, Profile, State, Host, Port, Health, Model, Slots
    Write-Host 'Single UTF-8 completion verified.'
    if ($PSBoundParameters.ContainsKey('ConcurrentRequests')) {
        $jobs = @()
        try {
            for ($index = 1; $index -le $ConcurrentRequests; $index++) {
                $jobs += Start-Job -ScriptBlock {
                    param($Uri, $Json)
                    $requestBody = [System.Text.Encoding]::UTF8.GetBytes($Json)
                    Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Body $requestBody -TimeoutSec 300
                } -ArgumentList "$script:ModelBaseUri/v1/chat/completions", (New-CompletionJson)
            }

            $null = $jobs | Wait-Job -Timeout 300
            $incomplete = @($jobs | Where-Object State -ne 'Completed')
            if ($incomplete.Count -gt 0) {
                throw "$($incomplete.Count) concurrent completion request(s) did not complete."
            }
            $responses = @($jobs | Receive-Job)
            if ($responses.Count -ne $ConcurrentRequests) {
                throw "Expected $ConcurrentRequests concurrent responses, got $($responses.Count)."
            }
            foreach ($response in $responses) {
                Assert-ModelCompletionResponse -Completion $response
            }
            Write-Host "Verified $ConcurrentRequests concurrent completion requests."
        } finally {
            $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $invokeParameters = @{ ArtifactsOnly = $ArtifactsOnly }
    if ($PSBoundParameters.ContainsKey('ConcurrentRequests')) {
        $invokeParameters.ConcurrentRequests = $ConcurrentRequests
    }
    Invoke-VerifyModel @invokeParameters
}
