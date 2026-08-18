[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

function Invoke-StopModel {
    Assert-ModelDockerDaemon
    Invoke-ModelCompose -ComposeArguments @('--profile', '*', 'down')
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-StopModel
}
