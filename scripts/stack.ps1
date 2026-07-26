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
      "JVB_ADVERTISE_IPS=127.0.0.1",
      "DOCKER_HOST_ADDRESS=127.0.0.1",
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

  Write-Host "Jitsi is prepared in $JitsiRoot"
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
  Write-Host "Jitsi:    https://localhost:8443"
}
