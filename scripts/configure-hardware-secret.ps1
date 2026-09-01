[CmdletBinding(DefaultParameterSetName = 'Credentials')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Credentials')]
    [ValidateNotNullOrEmpty()]
    [string]$WifiSsid,

    [Parameter(Mandatory = $true, ParameterSetName = 'Credentials')]
    [ValidateNotNull()]
    [Security.SecureString]$WifiPassword,

    [Parameter(Mandatory = $true, ParameterSetName = 'ReuseExisting')]
    [switch]$ReuseExistingWifi,

    [switch]$PrepareOnly,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https?://')]
    [string]$ApiBaseUrl
)

$ErrorActionPreference = "Stop"
$workspacePath = Split-Path -Parent $PSScriptRoot
$firmwareConfigPath = Join-Path $workspacePath "hardware\tag\supalai_tag\secrets.h"
$firmwareIngestSecretPath = Join-Path $workspacePath "hardware\tag\supalai_tag\ingest_secret.h"
$preparedSecretDirectory = Join-Path $workspacePath '.pio-secrets'
$preparedSecretEnvPath = Join-Path $preparedSecretDirectory 'hardware-ingest.env'
$backendEnvPath = Join-Path $workspacePath 'backend\.env'
$temporaryEnvPath = Join-Path ([System.IO.Path]::GetTempPath()) ("uwb-secret-" + [guid]::NewGuid().ToString("N") + ".env")
$passwordBstr = [IntPtr]::Zero
$wifiPasswordPlain = $null
$existingFirmwareConfig = $null

if ($ReuseExistingWifi) {
    if (-not (Test-Path -LiteralPath $firmwareConfigPath)) {
        throw 'Existing secrets.h was not found. Run the script with WifiSsid and WifiPassword instead.'
    }
    $existingFirmwareConfig = Get-Content -LiteralPath $firmwareConfigPath -Raw
    foreach ($name in @('UWB_WIFI_SSID', 'UWB_WIFI_PASSWORD')) {
        $pattern = '(?m)^\s*#define\s+' + [regex]::Escape($name) + '\s+"([^\"]+)"\s*$'
        $match = [regex]::Match($existingFirmwareConfig, $pattern)
        if (-not $match.Success -or $match.Groups[1].Value -match '^YOUR_') {
            throw "$name is missing or still contains a placeholder."
        }
    }
} else {
    if ($WifiSsid -eq 'YOUR_WIFI_NAME') {
        throw 'Replace the placeholder with the Wi-Fi SSID used at the installation site.'
    }

    $passwordBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($WifiPassword)
    $wifiPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordBstr)
    if ([string]::IsNullOrWhiteSpace($wifiPasswordPlain) -or $wifiPasswordPlain -eq 'YOUR_WIFI_PASSWORD') {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordBstr)
        $passwordBstr = [IntPtr]::Zero
        throw 'A real Wi-Fi password is required.'
    }
}

$randomBytes = $null
$ingestSecret = $null
if (Test-Path -LiteralPath $backendEnvPath) {
    $backendEnv = Get-Content -LiteralPath $backendEnvPath -Raw
    $backendSecretMatch = [regex]::Match(
        $backendEnv,
        '(?m)^\s*HARDWARE_INGEST_SECRET\s*=\s*([^\r\n#]+)\s*$'
    )
    if ($backendSecretMatch.Success -and $backendSecretMatch.Groups[1].Value.Trim().Length -ge 32) {
        $ingestSecret = $backendSecretMatch.Groups[1].Value.Trim()
    }
}
if (-not $ingestSecret) {
    $randomBytes = New-Object byte[] 48
    $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $randomGenerator.GetBytes($randomBytes)
    $randomGenerator.Dispose()
    $ingestSecret = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
if ($ingestSecret.Length -lt 32) {
    throw 'Generated hardware ingest secret is unexpectedly short.'
}

function Escape-CppString([string]$value) {
    return $value.Replace('\', '\\').Replace('"', '\"')
}

$firmwareConfig = if ($ReuseExistingWifi) {
    $secretPattern = '(?m)^(\s*#define\s+UWB_INGEST_SECRET\s+")[^\"]*("\s*)$'
    if ([regex]::IsMatch($existingFirmwareConfig, $secretPattern)) {
        [regex]::Replace(
            $existingFirmwareConfig,
            $secretPattern,
            { param($match) $match.Groups[1].Value + $ingestSecret + $match.Groups[2].Value }
        )
    } else {
        $existingFirmwareConfig.TrimEnd() + "`n#define UWB_INGEST_SECRET `"$ingestSecret`"`n"
    }
} else {
@"
#pragma once
#define UWB_WIFI_SSID "$(Escape-CppString $WifiSsid)"
#define UWB_WIFI_PASSWORD "$(Escape-CppString $wifiPasswordPlain)"
#define UWB_INGEST_SECRET "$ingestSecret"
#define UWB_INGEST_URL "$($ApiBaseUrl.TrimEnd('/'))/api/hardware/ingest"
"@
}

$ingestUrl = $ApiBaseUrl.TrimEnd('/') + '/api/hardware/ingest'
if ($ingestUrl.StartsWith('http://')) {
    Write-Warning 'HTTP does not encrypt UWB data. Use it only on a trusted local network; use HTTPS in production.'
}
$urlPattern = '(?m)^\s*#define\s+UWB_INGEST_URL\s+"[^"]*"\s*$'
$urlDefinition = '#define UWB_INGEST_URL "' + (Escape-CppString $ingestUrl) + '"'
if ([regex]::IsMatch($firmwareConfig, $urlPattern)) {
    $firmwareConfig = [regex]::Replace($firmwareConfig, $urlPattern, $urlDefinition)
} else {
    $firmwareConfig = $firmwareConfig.TrimEnd() + "`n" + $urlDefinition + "`n"
}

$configuredSecretMatch = [regex]::Match(
    $firmwareConfig,
    '(?m)^\s*#define\s+UWB_INGEST_SECRET\s+"([^\"]+)"\s*$'
)
if (-not $configuredSecretMatch.Success -or $configuredSecretMatch.Groups[1].Value.Length -ne $ingestSecret.Length) {
    throw 'Generated secret was not written into the firmware configuration.'
}
$firmwareIngestSecretConfig = @"
#pragma once
#define UWB_INGEST_SECRET "$ingestSecret"
"@

try {
    New-Item -ItemType Directory -Path $preparedSecretDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText($preparedSecretEnvPath, "HARDWARE_INGEST_SECRET=$ingestSecret`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($firmwareConfigPath, $firmwareConfig, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($firmwareIngestSecretPath, $firmwareIngestSecretConfig, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Hardware credentials prepared for the PostgreSQL-backed FastAPI service:"
    Write-Host $firmwareConfigPath
    Write-Host $firmwareIngestSecretPath
    Write-Host "Copy HARDWARE_INGEST_SECRET from this file into backend/.env or your API host's secret manager:"
    Write-Host $preparedSecretEnvPath
} finally {
    if (Test-Path -LiteralPath $temporaryEnvPath) {
        Remove-Item -LiteralPath $temporaryEnvPath -Force
    }
    $ingestSecret = $null
    $wifiPasswordPlain = $null
    if ($passwordBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordBstr)
    }
    if ($randomBytes) {
        [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    }
}
