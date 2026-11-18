<#
.SYNOPSIS
    Fail a Windows custom-core packaging run when a target volume cannot hold the remaining work.

.DESCRIPTION
    The workflow runs this check twice: both checkouts plus one build must fit before the baseline
    install, and the custom install plus its build must fit after the baseline intermediates are
    released. The floor covers one full pnpm install per checkout, one unpacked Electron build with its
    asar runtime tree, and both NSIS installers. CI records the reported byte counts; the exit code,
    not an estimate, decides whether the run continues.

.PARAMETER Stage
    Stage the report names, such as `before the baseline install`.

.PARAMETER Path
    Directories whose volumes must each carry `MinimumBytes` of free space.

.PARAMETER MinimumBytes
    Required free bytes per volume; 15 GiB by default.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Stage,
    [string[]]$Path = @($PWD.Path),
    [long]$MinimumBytes = 16106127360
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$roots = @($Path | ForEach-Object { [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($_)) } | Sort-Object -Unique)
$shortfalls = @()
foreach ($root in $roots) {
    $free = [IO.DriveInfo]::new($root).AvailableFreeSpace
    Write-Output ('custom core disk: {0}: {1} bytes free (minimum {2}) on {3}' -f $Stage, $free, $MinimumBytes, $root)
    if ($free -lt $MinimumBytes) {
        $shortfalls += ('{0} has {1} bytes free; need at least {2} ({3} bytes short)' -f $root, $free, $MinimumBytes, ($MinimumBytes - $free))
    }
}
if ($shortfalls.Count -gt 0) {
    [Console]::Error.WriteLine(('custom core disk: {0}: {1}' -f $Stage, ($shortfalls -join '; ')))
    exit 1
}
exit 0
