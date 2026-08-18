[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

function Invoke-StatusModel {
    Assert-ModelDockerDaemon
    $ownership = Assert-ModelRuntimeOwnership
    $snapshot = Get-ModelRuntimeSnapshot -Ownership $ownership
    $snapshot | Format-List Project, Profile, State, Host, Port, Health, Model, Slots
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-StatusModel
}
