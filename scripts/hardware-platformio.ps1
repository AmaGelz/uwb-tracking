[CmdletBinding()]
param(
    [ValidateSet('Build', 'Upload', 'Monitor', 'Devices')]
    [string]$Action = 'Build',

    [ValidateSet('tag', 'anchor_1782', 'anchor_1783', 'anchor_1784', 'calib_anchor', 'all')]
    [string]$Environment = 'tag',

    [string]$Port,

    [switch]$AllowCalibration
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$platformioConfig = Join-Path $projectRoot 'platformio.ini'
$localPlatformIOCore = Join-Path $projectRoot '.pio-core'

if (-not $env:PLATFORMIO_CORE_DIR -and (Test-Path -LiteralPath $localPlatformIOCore)) {
    $env:PLATFORMIO_CORE_DIR = $localPlatformIOCore
}

function Wait-LocalPlatformIOFiles {
    if (-not $env:PLATFORMIO_CORE_DIR) {
        return
    }

    $resolvedCore = [System.IO.Path]::GetFullPath($env:PLATFORMIO_CORE_DIR)
    if (-not $resolvedCore.Equals($localPlatformIOCore, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $requiredFiles = @(
        (Join-Path $resolvedCore 'platforms\espressif32\platform.json'),
        (Join-Path $resolvedCore 'platforms\espressif32\platform.py'),
        (Join-Path $resolvedCore 'packages\framework-arduinoespressif32\cores\esp32\Arduino.h'),
        (Join-Path $resolvedCore 'packages\toolchain-xtensa-esp32\bin\xtensa-esp32-elf-g++.exe'),
        (Join-Path $resolvedCore 'packages\tool-scons\scons.py')
    )

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $missingFiles = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
        if ($missingFiles.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Local PlatformIO files are not ready: $($missingFiles -join ', ')"
}

Wait-LocalPlatformIOFiles

if (-not (Test-Path -LiteralPath $platformioConfig)) {
    throw "platformio.ini was not found at $platformioConfig"
}

function Find-PlatformIOLauncher {
    $pioCommand = Get-Command pio -ErrorAction SilentlyContinue
    if ($pioCommand) {
        return @{ Executable = $pioCommand.Source; PrefixArgs = @() }
    }

    $platformioCommand = Get-Command platformio -ErrorAction SilentlyContinue
    if ($platformioCommand) {
        return @{ Executable = $platformioCommand.Source; PrefixArgs = @() }
    }

    $candidates = @(
        @{ Path = (Join-Path $projectRoot '.pio-python311\python.exe'); PrefixArgs = @('-m', 'platformio') },
        @{ Path = (Join-Path $projectRoot '.venv-platformio\Scripts\platformio.exe'); PrefixArgs = @() },
        @{ Path = (Join-Path $env:USERPROFILE '.platformio\penv\Scripts\platformio.exe'); PrefixArgs = @() }
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate.Path) {
            return @{ Executable = (Resolve-Path -LiteralPath $candidate.Path).Path; PrefixArgs = $candidate.PrefixArgs }
        }
    }

    throw 'PlatformIO CLI was not found. Install the PlatformIO IDE extension in VS Code, then reload VS Code.'
}

function Invoke-PlatformIO {
    param([string[]]$Arguments)

    $launcher = Find-PlatformIOLauncher
    $allArguments = @($launcher.PrefixArgs) + $Arguments
    Push-Location -LiteralPath $projectRoot
    try {
        & $launcher.Executable @allArguments
        if ($LASTEXITCODE -ne 0) {
            throw "PlatformIO exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

if ($Environment -eq 'all' -and $Action -ne 'Build') {
    throw "Environment 'all' is valid only with Action Build."
}

if ($Environment -eq 'calib_anchor' -and $Action -eq 'Upload' -and -not $AllowCalibration) {
    throw 'Calibration firmware is temporary. Add -AllowCalibration only when calibrating an anchor on the bench.'
}

switch ($Action) {
    'Devices' {
        Invoke-PlatformIO -Arguments @('device', 'list')
    }
    'Build' {
        if ($Environment -eq 'all') {
            Invoke-PlatformIO -Arguments @('run', '-e', 'tag', '-e', 'anchor_1782', '-e', 'anchor_1783', '-e', 'anchor_1784', '-e', 'calib_anchor')
        }
        else {
            Invoke-PlatformIO -Arguments @('run', '-e', $Environment)
        }
    }
    'Upload' {
        if ([string]::IsNullOrWhiteSpace($Port)) {
            throw 'Specify the connected board explicitly, for example -Port COM5.'
        }

        if ($Environment -eq 'tag') {
            $tagSecrets = Join-Path $projectRoot 'hardware\tag\supalai_tag\secrets.h'
            $tagIngestSecret = Join-Path $projectRoot 'hardware\tag\supalai_tag\ingest_secret.h'
            if (-not (Test-Path -LiteralPath $tagSecrets) -or -not (Test-Path -LiteralPath $tagIngestSecret)) {
                throw 'Tag credential headers are missing. Run scripts\configure-hardware-secret.ps1 before flashing the tag.'
            }
        }

        Invoke-PlatformIO -Arguments @('run', '-e', $Environment, '--target', 'upload', '--upload-port', $Port)
    }
    'Monitor' {
        if ([string]::IsNullOrWhiteSpace($Port)) {
            throw 'Specify the connected board explicitly, for example -Port COM5.'
        }
        Invoke-PlatformIO -Arguments @('device', 'monitor', '--environment', $Environment, '--port', $Port)
    }
}
