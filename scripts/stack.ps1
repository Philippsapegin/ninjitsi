param(
  [ValidateSet("prepare", "up", "down", "status", "logs")]
  [string]$Action = "up"
)

$ErrorActionPreference = "Stop"
$JitsiVersion = "stable-11031"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LocalRoot = Join-Path $ProjectRoot ".local"
$JitsiRoot = Join-Path $LocalRoot "jitsi"
$ReleaseMarker = Join-Path $JitsiRoot ".ninjitsi-release"
$ReleaseUrl = "https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/$JitsiVersion.zip"
$UserDockerBin = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin"

if (
  -not (Get-Command "docker" -ErrorAction SilentlyContinue) -and
  (Test-Path (Join-Path $UserDockerBin "docker.exe"))
) {
  $env:PATH = "$UserDockerBin;$env:PATH"
}

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Command '$Name' was not found. Install Docker Desktop and retry."
  }
}

function New-Secret {
  return ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
}

function Get-JvbAdvertiseIps {
  if ($env:NINJITSI_JVB_ADVERTISE_IPS) {
    return $env:NINJITSI_JVB_ADVERTISE_IPS.Trim()
  }

  $Addresses = Get-NetIPInterface `
      -AddressFamily IPv4 `
      -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ConnectionState -eq "Connected" -and
      $_.InterfaceAlias -notmatch "(?i)docker|hyper-v|loopback|vethernet|wsl"
    } |
    Sort-Object InterfaceMetric |
    ForEach-Object {
      Get-NetIPAddress `
        -InterfaceIndex $_.InterfaceIndex `
        -AddressFamily IPv4 `
        -ErrorAction SilentlyContinue
    } |
    Where-Object {
      $_.AddressState -eq "Preferred" -and
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*"
    } |
    Select-Object -ExpandProperty IPAddress -Unique

  if (-not $Addresses) {
    Write-Warning "No active physical IPv4 address was found. Set NINJITSI_JVB_ADVERTISE_IPS manually."
    return "127.0.0.1"
  }

  return ($Addresses -join ",")
}

function Initialize-Docker {
  docker info *> $null

  if ($LASTEXITCODE -eq 0) {
    return
  }

  $DesktopCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
    "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  )
  $Desktop = $DesktopCandidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

  if (-not $Desktop) {
    throw "Docker daemon is not running and Docker Desktop was not found."
  }

  Write-Host "Starting Docker Desktop..."
  Start-Process -FilePath $Desktop -WindowStyle Hidden

  for ($Attempt = 0; $Attempt -lt 30; $Attempt += 1) {
    Start-Sleep -Seconds 2
    docker info *> $null

    if ($LASTEXITCODE -eq 0) {
      return
    }
  }

  throw "Docker Desktop did not become ready within 60 seconds."
}

function Initialize-Jitsi {
  New-Item -ItemType Directory -Force -Path $LocalRoot | Out-Null
  $JvbAdvertiseIps = Get-JvbAdvertiseIps

  $PreparedVersion = if (Test-Path $ReleaseMarker) {
    (Get-Content -Raw $ReleaseMarker).Trim()
  } else {
    ""
  }

  if ($PreparedVersion -ne $JitsiVersion) {
    if (Test-Path $JitsiRoot) {
      $BackupName = "jitsi-backup-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
      Move-Item -LiteralPath $JitsiRoot -Destination (Join-Path $LocalRoot $BackupName)
    }

    $TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ninjitsi-" + [guid]::NewGuid().ToString("N"))
    $ArchivePath = Join-Path $TempRoot "jitsi.zip"
    $ExtractRoot = Join-Path $TempRoot "extract"

    New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null

    try {
      Write-Host "Downloading official docker-jitsi-meet $JitsiVersion..."
      Invoke-WebRequest -UseBasicParsing -Uri $ReleaseUrl -OutFile $ArchivePath
      Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot
      $Extracted = Get-ChildItem -LiteralPath $ExtractRoot -Directory | Select-Object -First 1

      if (-not $Extracted) {
        throw "The Jitsi archive does not contain the expected directory."
      }

      Move-Item -LiteralPath $Extracted.FullName -Destination $JitsiRoot
      Set-Content -Encoding UTF8 -NoNewline -LiteralPath $ReleaseMarker -Value $JitsiVersion
    } finally {
      if (Test-Path $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
      }
    }
  }

  $EnvPath = Join-Path $JitsiRoot ".env"

  if (-not (Test-Path $EnvPath)) {
    Copy-Item -LiteralPath (Join-Path $JitsiRoot "env.example") -Destination $EnvPath

    $LocalDefaults = @(
      "",
      "# Ninjitsi local defaults",
      "CONFIG=./config",
      "HTTP_PORT=8000",
      "HTTPS_PORT=8443",
      "TZ=Asia/Yekaterinburg",
      "PUBLIC_URL=https://localhost:8443",
      "JVB_ADVERTISE_IPS=$JvbAdvertiseIps",
      "DOCKER_HOST_ADDRESS=$($JvbAdvertiseIps.Split(',')[0])",
      "ENABLE_AUTH=0",
      "ENABLE_GUESTS=1",
      "ENABLE_LETSENCRYPT=0",
      "ENABLE_HTTP_REDIRECT=0",
      "ENABLE_PREJOIN_PAGE=0",
      "ENABLE_WELCOME_PAGE=0",
      "JICOFO_AUTH_PASSWORD=$(New-Secret)",
      "JVB_AUTH_PASSWORD=$(New-Secret)",
      "JIGASI_XMPP_PASSWORD=$(New-Secret)",
      "JIBRI_RECORDER_PASSWORD=$(New-Secret)",
      "JIBRI_XMPP_PASSWORD=$(New-Secret)"
    )

    $LocalDefaults | Add-Content -Encoding UTF8 -LiteralPath $EnvPath
  }

  $EnvContent = Get-Content -Raw -LiteralPath $EnvPath
  $UpdatedEnvContent = $EnvContent.Replace(
    "PUBLIC_URL=http://localhost:8000",
    "PUBLIC_URL=https://localhost:8443"
  )
  $UpdatedEnvContent = [regex]::Replace(
    $UpdatedEnvContent,
    "(?m)^JVB_ADVERTISE_IPS=.*$",
    "JVB_ADVERTISE_IPS=$JvbAdvertiseIps"
  )
  $UpdatedEnvContent = [regex]::Replace(
    $UpdatedEnvContent,
    "(?m)^DOCKER_HOST_ADDRESS=.*$",
    "DOCKER_HOST_ADDRESS=$($JvbAdvertiseIps.Split(',')[0])"
  )

  if ($UpdatedEnvContent -ne $EnvContent) {
    Set-Content -Encoding UTF8 -NoNewline -LiteralPath $EnvPath -Value $UpdatedEnvContent
  }

  Write-Host "Jitsi is prepared in $JitsiRoot (media address: $JvbAdvertiseIps)"
}

function Set-LocalJitsiBrowserConfig {
  $ConfigPath = Join-Path $JitsiRoot "config\web\config.js"

  for ($Attempt = 0; $Attempt -lt 15; $Attempt += 1) {
    if (Test-Path -LiteralPath $ConfigPath) {
      $ConfigContent = Get-Content -Raw -LiteralPath $ConfigPath

      if ($ConfigContent -match "config\.bosh") {
        $UpdatedConfig = [regex]::Replace(
          $ConfigContent,
          "(?m)^config\.bosh = .*$",
          "config.bosh = 'http://localhost:8000/http-bind';"
        )
        $UpdatedConfig = [regex]::Replace(
          $UpdatedConfig,
          "(?m)^config\.websocket = .*$",
          "config.websocket = 'ws://localhost:8000/xmpp-websocket';"
        )
        Set-Content -Encoding UTF8 -NoNewline -LiteralPath $ConfigPath -Value $UpdatedConfig
        Write-Host "Jitsi browser signaling uses local HTTP endpoints."
        return
      }
    }

    Start-Sleep -Seconds 2
  }

  throw "Jitsi config.js was not generated within 30 seconds."
}

if ($Action -eq "prepare") {
  Initialize-Jitsi
  exit 0
}

Assert-Command "docker"
Initialize-Docker
Initialize-Jitsi

Push-Location $JitsiRoot
try {
  if ($Action -eq "up") {
    docker compose up -d
  } elseif ($Action -eq "down") {
    docker compose down
  } elseif ($Action -eq "status") {
    docker compose ps
  } elseif ($Action -eq "logs") {
    docker compose logs --tail 100
  }
} finally {
  Pop-Location
}

if ($Action -eq "up") {
  Set-LocalJitsiBrowserConfig
}

Push-Location $ProjectRoot
try {
  if ($Action -eq "up") {
    docker compose up -d --build
  } elseif ($Action -eq "down") {
    docker compose down
  } elseif ($Action -eq "status") {
    docker compose ps
  } elseif ($Action -eq "logs") {
    docker compose logs --tail 100
  }
} finally {
  Pop-Location
}

if ($Action -eq "up") {
  Write-Host ""
  Write-Host "Ninjitsi: http://localhost:3000"
  Write-Host "Jitsi:    http://localhost:8000"
}
