<#
.SYNOPSIS
    List helpers the Windows custom-core acceptance script shares with its tests.

.DESCRIPTION
    Each function reads recorded acceptance state only: no process starts, no product file changes.
    Keeping them here lets the suite exercise the bundle-list and seeded-file rules on any host with
    PowerShell 7 instead of only on the Windows runner that performs the installation.
#>

<#
.SYNOPSIS
    Read one field from a parsed JSON object or a recorded dictionary entry.

.PARAMETER Entry
    Object to read; `$null` answers the default.

.PARAMETER Name
    Field name.

.PARAMETER Default
    Answer when the field is absent.

.RETURNS
    The field value, or the default when the object or field is absent.
#>
function Get-JsonField {
    param($Entry, [string]$Name, $Default = $null)
    if ($null -eq $Entry) { return $Default }
    if ($Entry -is [Collections.IDictionary]) {
        if ($Entry.Contains($Name)) { return $Entry[$Name] }
        return $Default
    }
    $property = $Entry.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

<#
.SYNOPSIS
    Read the enabled bundle list from one Desktop profile manifest.

.DESCRIPTION
    A missing manifest, an absent list, a null list and blank entries all answer an empty list, so a
    caller that requires bundles must reject the empty answer instead of counting a null entry.

.PARAMETER Path
    Profile `package.json`.

.RETURNS
    The non-blank bundle names in their recorded order; empty when nothing usable is recorded.
#>
function Get-ProfileBundles {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 16
    $raw = @(Get-JsonField (Get-JsonField (Get-JsonField $manifest 'dsh') 'profile') 'bundles' @())
    return @($raw | Where-Object { $_ -is [string] -and -not [string]::IsNullOrWhiteSpace($_) })
}

<#
.SYNOPSIS
    Compare two bundle lists item by item.

.PARAMETER Before
    Bundle names read at seeding time.

.PARAMETER After
    Bundle names read after the overwrite installation.

.RETURNS
    One difference per count mismatch or changed position; empty when both lists are identical.
#>
function Compare-ProfileBundles {
    param([string[]]$Before, [string[]]$After)
    $expected = @($Before)
    $actual = @($After)
    $differences = @()
    if ($expected.Count -ne $actual.Count) {
        $differences += ('count {0} -> {1}' -f $expected.Count, $actual.Count)
    }
    $shared = [Math]::Min($expected.Count, $actual.Count)
    for ($index = 0; $index -lt $shared; $index++) {
        if ($expected[$index] -cne $actual[$index]) {
            $differences += ('index {0}: {1} -> {2}' -f $index, $expected[$index], $actual[$index])
        }
    }
    return $differences
}

<#
.SYNOPSIS
    Name every required seeded file the recorded snapshot cannot prove.

.PARAMETER Entries
    Hash-snapshot entries recorded from disk.

.PARAMETER Required
    Snapshot paths that must be present, existing and non-empty.

.RETURNS
    One gap per missing path, absent file or empty file; empty when every required file is proven.
#>
function Get-SeedGaps {
    param([object[]]$Entries, [string[]]$Required)
    $byPath = @{}
    foreach ($entry in @($Entries)) {
        if ($null -eq $entry) { continue }
        $byPath[[string](Get-JsonField $entry 'path' '')] = $entry
    }
    $gaps = @()
    foreach ($path in $Required) {
        if (-not $byPath.ContainsKey($path)) {
            $gaps += "missing from the hash snapshot: $path"
            continue
        }
        $entry = $byPath[$path]
        if (-not [bool](Get-JsonField $entry 'exists' $false)) {
            $gaps += "not present on disk: $path"
            continue
        }
        if ([long](Get-JsonField $entry 'bytes' 0) -le 0) { $gaps += "empty on disk: $path" }
    }
    return $gaps
}
