<#
.SYNOPSIS
    Accept one Windows custom-core installer on an isolated runner by overwriting a baseline installation.

.DESCRIPTION
    The runner is a one-time virtual machine, so the real `%USERPROFILE%`, `%APPDATA%`,
    and `%LOCALAPPDATA%` are the isolated configuration this script seeds. It installs the
    baseline package into one pinned per-user directory, seeds a real Session, a
    non-default Desktop JSON preference, a credentials placeholder, and the acceptance
    fixture plugin, records the data hashes, then overwrite-installs the custom package
    into the same directory and compares every recorded hash before launching anything
    again. Only processes this script started are terminated, and only in `finally`.

.PARAMETER BaselineInstaller
    Absolute path of the unsigned baseline NSIS installer of the same release.

.PARAMETER CustomInstaller
    Absolute path of the unsigned custom-core NSIS installer under acceptance.

.PARAMETER Report
    Absolute path of the JSON report to write. A failed acceptance still writes it.

.PARAMETER FixtureDirectory
    Directory holding the acceptance fixture plugin; copied only into the isolated profile.

.PARAMETER TimeoutSeconds
    How long one application launch may take to produce its fixture report.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaselineInstaller,
    [Parameter(Mandatory)][string]$CustomInstaller,
    [Parameter(Mandatory)][string]$Report,
    [string]$FixtureDirectory = (Join-Path $PSScriptRoot 'fixtures/unified-own-tool-plugin'),
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$productName = 'DeepSeek Harness'
$fixturePackageName = 'dsh-fixture-unified-own-tool'
$fixtureRowId = 'fixture-unified-own-tool'
$ownTool = 'fixture_unified_own_tool'
$inheritedTool = 'bash'
$unknownToolCode = 'UNKNOWN_TOOL'
$ownToolReply = 'fixture-own-tool-ran'

$userProfile = $env:USERPROFILE
$appData = $env:APPDATA
$localAppData = $env:LOCALAPPDATA
$dshHome = Join-Path $userProfile '.dsh'
$profileDir = Join-Path $dshHome 'profiles\desktop'
$desktopJsonDir = Join-Path $appData '@deepseek-ai\dsh-desktop\desktop'
$installDir = Join-Path $localAppData "Programs\$fixturePackageName-acceptance\$productName"
$application = Join-Path $installDir "$productName.exe"
$reportRoot = Join-Path (Split-Path -Parent $Report) 'observations'
$baselineReport = Join-Path $reportRoot 'baseline-own-tool.json'
$customReport = Join-Path $reportRoot 'custom-own-tool.json'
$credentialsFile = Join-Path $dshHome '.credentials.yaml'
$desktopSettingsFile = Join-Path $desktopJsonDir 'settings.json'
$profileManifest = Join-Path $profileDir 'package.json'
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
$fixtureInstallDir = Join-Path $profileDir "node_modules\$fixturePackageName"

$state = [ordered]@{
    schemaVersion = 1
    outcome = 'failed'
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    finishedAt = $null
    isolatedRunner = [ordered]@{
        userProfile = $userProfile
        appData = $appData
        localAppData = $localAppData
        dshHome = $dshHome
        installDirectory = $installDir
        note = 'GitHub-hosted windows-2022 is a one-time virtual machine; no real user configuration is touched.'
    }
    installers = [ordered]@{ baseline = $null; custom = $null }
    fixture = [ordered]@{ directory = $null; files = @(); fixtureSha256 = $null; ownTool = $ownTool; inheritedTool = $inheritedTool }
    installs = [ordered]@{ baselineArguments = ''; baselineExitCode = $null; customArguments = ''; customExitCode = $null }
    observation = [ordered]@{ baseline = $null; custom = $null }
    data = [ordered]@{ before = @(); after = @(); identical = $false; differences = @(); profileBundles = $null }
    checks = @()
    errors = @()
}

$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()

function Add-Check {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $script:state.checks += [ordered]@{ name = $Name; passed = $Passed; detail = $Detail }
    if (-not $Passed) { Write-Output "FAIL: $Name — $Detail" } else { Write-Output "PASS: $Name" }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-ReportFile {
    $parent = Split-Path -Parent $Report
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $state | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $Report -Encoding utf8
}

function Get-InstallerFacts {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "custom core acceptance: the $Label installer is missing at $Path"
    }
    $item = Get-Item -LiteralPath $Path
    return [ordered]@{ path = $item.FullName; bytes = $item.Length; sha256 = (Get-Sha256 $item.FullName) }
}

function Get-FixtureFacts {
    if (-not (Test-Path -LiteralPath $FixtureDirectory -PathType Container)) {
        throw "custom core acceptance: the fixture plugin directory is missing at $FixtureDirectory"
    }
    $files = @(Get-ChildItem -Force -LiteralPath $FixtureDirectory -File | Sort-Object Name)
    if ($files.Count -eq 0) { throw "custom core acceptance: the fixture plugin directory $FixtureDirectory is empty" }
    $records = @()
    $digestInput = ''
    foreach ($file in $files) {
        $sha = Get-Sha256 $file.FullName
        $records += [ordered]@{ name = $file.Name; bytes = $file.Length; sha256 = $sha }
        $digestInput += "$($file.Name) $sha`n"
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($digestInput)
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    return [ordered]@{
        directory = (Get-Item -LiteralPath $FixtureDirectory).FullName
        files = $records
        fixtureSha256 = $digest
        ownTool = $ownTool
        inheritedTool = $inheritedTool
    }
}

function Get-DataHashes {
    $entries = [Collections.Generic.List[object]]::new()
    $recordFile = {
        param([string]$Path, [string]$Name)
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $item = Get-Item -Force -LiteralPath $Path
            $entries.Add([ordered]@{ path = $Name; exists = $true; bytes = $item.Length; sha256 = (Get-Sha256 $Path) })
        } else {
            $entries.Add([ordered]@{ path = $Name; exists = $false; bytes = 0; sha256 = $null })
        }
    }
    & $recordFile $credentialsFile '.dsh/.credentials.yaml'
    & $recordFile (Join-Path $dshHome 'settings.json') '.dsh/settings.json'
    & $recordFile $profileManifest '.dsh/profiles/desktop/package.json'
    & $recordFile $profilePatch '.dsh/profiles/desktop/cordis.patch.yml'
    $sessionRoot = Join-Path $dshHome 'sessions'
    if (Test-Path -LiteralPath $sessionRoot -PathType Container) {
        foreach ($file in @(Get-ChildItem -Force -LiteralPath $sessionRoot -Recurse -File | Sort-Object FullName)) {
            $relative = [IO.Path]::GetRelativePath($dshHome, $file.FullName) -replace '\\', '/'
            $entries.Add([ordered]@{ path = ".dsh/$relative"; exists = $true; bytes = $file.Length; sha256 = (Get-Sha256 $file.FullName) })
        }
    } else {
        $entries.Add([ordered]@{ path = '.dsh/sessions'; exists = $false; bytes = 0; sha256 = $null })
    }
    if (Test-Path -LiteralPath $fixtureInstallDir -PathType Container) {
        foreach ($file in @(Get-ChildItem -Force -LiteralPath $fixtureInstallDir -Recurse -File | Sort-Object FullName)) {
            $relative = [IO.Path]::GetRelativePath($profileDir, $file.FullName) -replace '\\', '/'
            $entries.Add([ordered]@{ path = ".dsh/profiles/desktop/$relative"; exists = $true; bytes = $file.Length; sha256 = (Get-Sha256 $file.FullName) })
        }
    }
    if (Test-Path -LiteralPath $desktopJsonDir -PathType Container) {
        foreach ($file in @(Get-ChildItem -Force -LiteralPath $desktopJsonDir -Filter '*.json' -File | Sort-Object Name)) {
            $entries.Add([ordered]@{
                    path = "%APPDATA%/@deepseek-ai/dsh-desktop/desktop/$($file.Name)"
                    exists = $true
                    bytes = $file.Length
                    sha256 = (Get-Sha256 $file.FullName)
                })
        }
    }
    return $entries.ToArray()
}

function Compare-DataHashes {
    param($Before, $After)
    $differences = @()
    $beforeMap = @{}
    foreach ($entry in $Before) { $beforeMap[$entry.path] = $entry }
    $afterMap = @{}
    foreach ($entry in $After) { $afterMap[$entry.path] = $entry }
    foreach ($path in @($beforeMap.Keys | Sort-Object)) {
        if (-not $afterMap.ContainsKey($path)) {
            $differences += "removed: $path"
            continue
        }
        $left = $beforeMap[$path]
        $right = $afterMap[$path]
        if ($left.exists -ne $right.exists -or $left.sha256 -ne $right.sha256) {
            $differences += "changed: $path ($($left.sha256) -> $($right.sha256))"
        }
    }
    foreach ($path in @($afterMap.Keys | Sort-Object)) {
        if (-not $beforeMap.ContainsKey($path)) { $differences += "added: $path" }
    }
    return $differences
}

function Install-Product {
    param([string]$Installer, [string]$Arguments, [string]$Label)
    Write-Output "== install $Label ($Arguments)"
    $process = Start-Process -FilePath $Installer -ArgumentList $Arguments -PassThru -Wait -WindowStyle Hidden
    if ($null -eq $process.ExitCode) { throw "custom core acceptance: the $Label installer produced no exit code" }
    return [int]$process.ExitCode
}

function Start-DesktopApplication {
    param([hashtable]$Environment)
    if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
        throw "custom core acceptance: the installed application is missing at $application"
    }
    $saved = @{}
    foreach ($name in $Environment.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $Environment[$name])
    }
    try {
        $process = Start-Process -FilePath $application -PassThru -WorkingDirectory $installDir
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
    $ownedProcesses.Add($process)
    return $process
}

function Wait-FixtureObservation {
    param([string]$Path, [Diagnostics.Process]$Process, [string]$Label)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try {
                return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 16)
            } catch [System.Text.Json.JsonException] {
                Write-Output "waiting for a complete $Label fixture report at $Path"
            } catch [ArgumentException] {
                Write-Output "waiting for a readable $Label fixture report at $Path"
            }
        }
        if ($Process.HasExited) {
            throw "custom core acceptance: the $Label application exited with code $($Process.ExitCode) before reporting"
        }
        Start-Sleep -Milliseconds 250
    }
    throw "custom core acceptance: the $Label application produced no fixture report at $Path within $TimeoutSeconds seconds"
}

function Stop-OwnedApplication {
    param([Diagnostics.Process]$Process, [string]$Label)
    if ($null -eq $Process) { return }
    if ($Process.HasExited) { return }
    Write-Output "== stopping $Label application (pid $($Process.Id))"
    [void]$Process.CloseMainWindow()
    if (-not $Process.WaitForExit(15000)) {
        # The Electron shell owns its Node-mode Host child, so the tree goes with it.
        $Process.Kill($true)
        [void]$Process.WaitForExit(15000)
    }
}

function Install-FixturePlugin {
    if (Test-Path -LiteralPath $fixtureInstallDir) { Remove-Item -LiteralPath $fixtureInstallDir -Recurse -Force }
    New-Item -ItemType Directory -Path $fixtureInstallDir -Force | Out-Null
    foreach ($file in @(Get-ChildItem -Force -LiteralPath $FixtureDirectory -File)) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $fixtureInstallDir $file.Name)
    }
    $row = @(
        '# Enabled by the Windows custom-core acceptance runner; removed with the runner.',
        "- insert:",
        "    - id: $fixtureRowId",
        "      name: $fixturePackageName"
    ) -join "`n"
    if (-not (Test-Path -LiteralPath $profilePatch -PathType Leaf)) {
        Set-Content -LiteralPath $profilePatch -Value "$row`n" -Encoding utf8
        return
    }
    $existing = Get-Content -LiteralPath $profilePatch -Raw
    $meaningful = @($existing -split "`n" | Where-Object { $_.Trim() -ne '' -and -not $_.TrimStart().StartsWith('#') })
    if (($meaningful -join "`n").Trim() -ne '[]') {
        throw "custom core acceptance: the Desktop profile already carries a non-empty patch layer at $profilePatch; refusing to rewrite it: $($meaningful -join ' ')"
    }
    Set-Content -LiteralPath $profilePatch -Value "$row`n" -Encoding utf8
}

function Write-CredentialsPlaceholder {
    $content = "version: 1`nrefs:`n  FIXTURE_ACCEPTANCE_PLACEHOLDER: fixture-not-a-real-credential`n"
    New-Item -ItemType Directory -Path $dshHome -Force | Out-Null
    Set-Content -LiteralPath $credentialsFile -Value $content -Encoding utf8 -NoNewline
}

function Write-DesktopPreference {
    New-Item -ItemType Directory -Path $desktopJsonDir -Force | Out-Null
    $settings = [ordered]@{ updates = [ordered]@{ channel = 'nightly' } }
    $settings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $desktopSettingsFile -Encoding utf8
}

function Get-ProfileBundles {
    if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) { return @() }
    try {
        $manifest = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json -Depth 16
        return @($manifest.dsh.profile.bundles)
    } catch [System.Management.Automation.PropertyNotFoundException] {
        Write-Output "profile manifest $profileManifest carries no dsh.profile.bundles list"
        return @()
    }
}

function Get-JsonField {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Assert-OwnToolObservation {
    param($Observation, [string]$Label, [bool]$ExpectAdmitted)
    $prefix = "own-tool:$Label"
    $catalog = @(Get-JsonField $Observation 'catalog' @())
    $projection = @(Get-JsonField $Observation 'projection' @())
    $execution = Get-JsonField $Observation 'execution' $null
    $registered = [bool](Get-JsonField $Observation 'registered' $false)
    $projected = [bool](Get-JsonField $Observation 'projectionListsOwnTool' $false)
    $host_ = Get-JsonField $Observation 'host'
    Add-Check "$prefix registered" $registered "catalog entries: $($catalog -join ', ')"
    Add-Check "$prefix fixture loaded in the Host" ([bool](Get-JsonField $host_ 'loadedFixture' $false)) 'the fixture reports its own load from inside the Host process'
    Add-Check "$prefix inherited tool present" ([bool](Get-JsonField $Observation 'inheritedToolPresent' $false)) "the scope allow-list names $inheritedTool"
    if ($ExpectAdmitted) {
        Add-Check "$prefix own tool projected" $projected "projection: $($projection -join ', ')"
        Add-Check "$prefix own tool executes" `
            ((-not [bool](Get-JsonField $execution 'isError' $true)) -and ((Get-JsonField $execution 'text' '') -eq $ownToolReply)) `
            "execution: $($execution | ConvertTo-Json -Compress -Depth 6)"
    } else {
        Add-Check "$prefix own tool withheld from the projection" (-not $projected) "projection: $($projection -join ', ')"
        Add-Check "$prefix own tool call rejected" `
            (([bool](Get-JsonField $execution 'isError' $false)) -and ((Get-JsonField $execution 'code' '') -eq $unknownToolCode)) `
            "execution: $($execution | ConvertTo-Json -Compress -Depth 6)"
        Add-Check "$prefix rejection is the restriction, not a missing registration" $registered 'the same scope registered the tool before the allow-list applied'
    }
    $error_ = Get-JsonField $Observation 'error' $null
    if ($null -ne $error_) {
        Add-Check "$prefix fixture reported no internal error" $false ([string]$error_)
    }
}

try {
    $state.fixture = Get-FixtureFacts
    $state.installers.baseline = Get-InstallerFacts -Path $BaselineInstaller -Label 'baseline'
    $state.installers.custom = Get-InstallerFacts -Path $CustomInstaller -Label 'custom'
    Add-Check 'installers are distinct files' ($state.installers.baseline.sha256 -ne $state.installers.custom.sha256) `
        "baseline $($state.installers.baseline.sha256) / custom $($state.installers.custom.sha256)"

    $running = @(Get-Process -Name $productName -ErrorAction SilentlyContinue)
    Add-Check 'no pre-existing application instance' ($running.Count -eq 0) "found $($running.Count) instance(s) this script does not own"
    if ($running.Count -ne 0) { throw "custom core acceptance: $productName is already running; this script only terminates processes it started" }

    $baselineArguments = "/S /D=$installDir"
    $state.installs.baselineArguments = $baselineArguments
    $state.installs.baselineExitCode = Install-Product -Installer $BaselineInstaller -Arguments $baselineArguments -Label 'baseline'
    Add-Check 'baseline installer exits 0' ($state.installs.baselineExitCode -eq 0) "exit code $($state.installs.baselineExitCode)"
    Add-Check 'baseline application installed' (Test-Path -LiteralPath $application -PathType Leaf) $application

    Write-Output '== first baseline launch: initialize the Desktop profile'
    $bootstrap = Start-DesktopApplication -Environment @{ DSH_FIXTURE_OWN_TOOL_REPORT = '' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds -and -not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) {
        if ($bootstrap.HasExited) { throw "custom core acceptance: the baseline application exited with code $($bootstrap.ExitCode) before creating its profile" }
        Start-Sleep -Milliseconds 250
    }
    Add-Check 'baseline initialized the Desktop profile' (Test-Path -LiteralPath $profileManifest -PathType Leaf) $profileManifest
    Stop-OwnedApplication -Process $bootstrap -Label 'baseline bootstrap'

    Write-Output '== seeding the isolated configuration'
    Install-FixturePlugin
    Write-CredentialsPlaceholder
    Write-DesktopPreference
    Add-Check 'fixture plugin enabled in the profile layer' ((Get-Content -LiteralPath $profilePatch -Raw) -match [regex]::Escape($fixturePackageName)) $profilePatch
    $state.data.profileBundles = Get-ProfileBundles
    Add-Check 'profile keeps its ordered bundle list' (@($state.data.profileBundles).Count -gt 0) ($state.data.profileBundles -join ', ')

    Write-Output '== baseline observation: seed the Session and project the own tool'
    $baselineApp = Start-DesktopApplication -Environment @{
        DSH_FIXTURE_OWN_TOOL_REPORT = $baselineReport
        DSH_FIXTURE_OWN_TOOL_MODE = 'seed'
    }
    $baseline = Wait-FixtureObservation -Path $baselineReport -Process $baselineApp -Label 'baseline'
    $state.observation.baseline = $baseline
    Assert-OwnToolObservation -Observation $baseline -Label 'baseline' -ExpectAdmitted $true
    $baselineSession = Get-JsonField $baseline 'session'
    $baselineSessionError = Get-JsonField $baselineSession 'error'
    $sessionSeeded = ($null -ne $baselineSession) -and ((Get-JsonField $baselineSession 'mode' '') -eq 'seed') -and ($null -eq $baselineSessionError)
    Add-Check 'baseline created a real Session' $sessionSeeded "session: $($baselineSession | ConvertTo-Json -Compress -Depth 6)"
    if (-not $baselineApp.HasExited) {
        Add-Check 'baseline Host stayed healthy through the observation' $true "pid $($baselineApp.Id) alive after reporting"
    } else {
        Add-Check 'baseline Host stayed healthy through the observation' $false "the application exited with code $($baselineApp.ExitCode)"
    }
    Stop-OwnedApplication -Process $baselineApp -Label 'baseline'

    Write-Output '== snapshot A: seeded data after the baseline observation'
    $state.data.before = @(Get-DataHashes)
    Add-Check 'seeded data recorded' (@($state.data.before).Count -gt 0) "$(@($state.data.before).Count) entries"
    $seededSessionFiles = @($state.data.before | Where-Object { $_.path -like '.dsh/sessions/*' -and $_.exists })
    Add-Check 'seeded Session is durable' ($seededSessionFiles.Count -gt 0) "$($seededSessionFiles.Count) session file(s) under .dsh/sessions"

    $customArguments = "/S --updated /D=$installDir"
    $state.installs.customArguments = $customArguments
    $state.installs.customExitCode = Install-Product -Installer $CustomInstaller -Arguments $customArguments -Label 'custom overwrite'
    Add-Check 'custom installer exits 0' ($state.installs.customExitCode -eq 0) "exit code $($state.installs.customExitCode)"
    Add-Check 'custom installer overwrote the same directory' (Test-Path -LiteralPath $application -PathType Leaf) $application
    $uninstallKeys = @(Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq $productName })
    Add-Check 'custom installer re-registered the same identity' ($uninstallKeys.Count -eq 1) "uninstall registrations: $($uninstallKeys.Count)"

    Write-Output '== snapshot B: the overwrite install must not rewrite recorded data'
    $state.data.after = @(Get-DataHashes)
    $differences = @(Compare-DataHashes -Before $state.data.before -After $state.data.after)
    $state.data.differences = $differences
    $state.data.identical = ($differences.Count -eq 0)
    Add-Check 'overwrite install preserved every recorded hash' $state.data.identical ($differences -join '; ')
    Add-Check 'fixture plugin still enabled after the overwrite' ((Get-Content -LiteralPath $profilePatch -Raw) -match [regex]::Escape($fixturePackageName)) $profilePatch
    Add-Check 'profile bundle list unchanged' ((@(Get-ProfileBundles) -join ',') -eq (@($state.data.profileBundles) -join ',')) (@(Get-ProfileBundles) -join ', ')

    Write-Output '== custom observation: reopen the Session and project the own tool'
    $customApp = Start-DesktopApplication -Environment @{
        DSH_FIXTURE_OWN_TOOL_REPORT = $customReport
        DSH_FIXTURE_OWN_TOOL_MODE = 'observe'
        DSH_FIXTURE_OWN_TOOL_SESSION = [string](Get-JsonField $baselineSession 'id' '')
    }
    $custom = Wait-FixtureObservation -Path $customReport -Process $customApp -Label 'custom'
    $state.observation.custom = $custom
    Assert-OwnToolObservation -Observation $custom -Label 'custom' -ExpectAdmitted $false
    $customSession = Get-JsonField $custom 'session'
    $customSessionError = Get-JsonField $customSession 'error'
    $sessionReopened = ($null -ne $customSession) -and ((Get-JsonField $customSession 'mode' '') -eq 'observe') `
        -and ($null -eq $customSessionError) `
        -and ((Get-JsonField $customSession 'id' '') -eq (Get-JsonField $baselineSession 'id' ''))
    Add-Check 'custom Host reopened the seeded Session' $sessionReopened "session: $($customSession | ConvertTo-Json -Compress -Depth 6)"
    if (-not $customApp.HasExited) {
        Add-Check 'custom Host stayed healthy through the observation' $true "pid $($customApp.Id) alive after reporting"
    } else {
        Add-Check 'custom Host stayed healthy through the observation' $false "the application exited with code $($customApp.ExitCode)"
    }
    Stop-OwnedApplication -Process $customApp -Label 'custom'

    Add-Check 'fixture differed between the two installations' `
        ([bool](Get-JsonField $state.observation.baseline 'projectionListsOwnTool' $false) -and -not [bool](Get-JsonField $state.observation.custom 'projectionListsOwnTool' $true)) `
        'the same fixture bytes registered the same tool and only the custom core withheld it'
    Add-Check 'baseline session id is known' (-not [string]::IsNullOrWhiteSpace([string](Get-JsonField $baselineSession 'id' ''))) ([string](Get-JsonField $baselineSession 'id' ''))

    $state.outcome = if (@($state.checks | Where-Object { -not $_.passed }).Count -eq 0) { 'passed' } else { 'failed' }
} catch {
    $state.errors += [string]$_
    $state.outcome = 'failed'
    Write-Output "FAIL: acceptance aborted — $_"
} finally {
    foreach ($process in $ownedProcesses) {
        try {
            Stop-OwnedApplication -Process $process -Label 'cleanup'
        } catch [InvalidOperationException] {
            Write-Output "cleanup: pid $($process.Id) was already gone"
        }
        $process.Dispose()
    }
    $state.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-ReportFile
    Write-Output "== report: $Report ($($state.outcome))"
}

if ($state.outcome -ne 'passed') { exit 1 }
exit 0
