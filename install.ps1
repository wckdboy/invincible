# Invincible and Autobot on Windows: `irm https://invincible.sh/install.ps1 | iex`
#
# Installs `invincible` and `autobot` from a signed release (SHA256SUMS signed with the release
# key, checked with OpenSSH's ssh-keygen, then the archive against it), llama.cpp (pinned, CUDA
# when there is an NVIDIA GPU, Vulkan otherwise, CPU on arm64), puts them on your PATH, and starts
# the services (Task Scheduler tasks, at logon). Run it again any time: it converges.
#
# Options (as environment variables, since `iex` takes no arguments):
#   INVINCIBLE_CHANNEL=edge     the newest green build of main instead of the latest release
#   INVINCIBLE_VERSION=0.0.20   that release
#   INVINCIBLE_BIN=<dir>        install the programs there (default %LOCALAPPDATA%\Programs\Invincible)
#   INVINCIBLE_NO_SERVICE=1     do not install or start the services
#   INVINCIBLE_BASE=<url>       where the release files are (tests)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'https://github.com/wckdboy/invincible'
$ReleaseKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo'
# llama.cpp, pinned as in install.sh: build tag and the SHA-256 of each archive.
$LlamaTag = 'b11721'
$LlamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaTag"
$Llama = @{
    'cuda-x64'    = @("llama-$LlamaTag-bin-win-cuda-12.4-x64.zip", 'a343ee836e03b205881c8add4ebdbac33e49f3662fb3521b44585ca271870748')
    'cudart-x64'  = @('cudart-llama-bin-win-cuda-12.4-x64.zip', '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6')
    'vulkan-x64'  = @("llama-$LlamaTag-bin-win-vulkan-x64.zip", 'b2dab62833cc07aae4a1f28752874668b6a98d304a7f8ca6c1421a0d1e1a7075')
    'cpu-arm64'   = @("llama-$LlamaTag-bin-win-cpu-arm64.zip", '710ce7825b31bd39bd0325234522e4e9e76d3c04cab00b0c2d3e5b2bc411dc15')
}

function Say($text) { Write-Host "▪ $text" }
function Ok($text) { Write-Host "✓ $text" }
function Warn($text) { Write-Host "! $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "✗ $text" -ForegroundColor Red; exit 1 }

function Sha256($path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

# Downloads [url] to [file] and keeps it only if its SHA-256 is [sha].
function Fetch($url, $file, $sha) {
    if ((Test-Path $file) -and (Sha256 $file) -eq $sha) { return }
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$file.partial"
    if ((Sha256 "$file.partial") -ne $sha) {
        Remove-Item -Force "$file.partial"
        Die "$(Split-Path -Leaf $file) does not match its checksum; not installing it"
    }
    Move-Item -Force "$file.partial" $file
}

$Platform = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'windows-x64' }
    'ARM64' { 'windows-arm64' }
    default { Die "no Windows release for $($env:PROCESSOR_ARCHITECTURE) (x64 or arm64)" }
}
$Bin = if ($env:INVINCIBLE_BIN) { $env:INVINCIBLE_BIN } else { Join-Path $env:LOCALAPPDATA 'Programs\Invincible' }
$InvHome = if ($env:INVINCIBLE_HOME) { $env:INVINCIBLE_HOME } else { Join-Path $HOME '.invincible' }
$Cache = Join-Path $InvHome 'cache'
New-Item -ItemType Directory -Force -Path $Bin, $Cache | Out-Null
$Work = Join-Path ([IO.Path]::GetTempPath()) ("invincible-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null

try {
    # --- 1. The release ------------------------------------------------------------------------
    $Base = if ($env:INVINCIBLE_BASE) { $env:INVINCIBLE_BASE }
        elseif ($env:INVINCIBLE_VERSION) { "$Repo/releases/download/v$($env:INVINCIBLE_VERSION.TrimStart('v'))" }
        elseif ($env:INVINCIBLE_CHANNEL -eq 'edge') { "$Repo/releases/download/edge" }
        else { "$Repo/releases/latest/download" }
    if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
        Die "ssh-keygen (OpenSSH Client) is needed to check the release signature: Settings > System > Optional features > OpenSSH Client"
    }
    Say "checking the release ($Platform)"
    foreach ($f in 'SHA256SUMS', 'SHA256SUMS.sig') {
        try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/$f" -OutFile (Join-Path $Work $f) }
        catch { Die "the release has no $f; not installing it" }
    }
    "invincible-release $ReleaseKey" | Set-Content -Encoding ascii (Join-Path $Work 'allowed_signers')
    # The file itself as stdin: a PowerShell pipe would re-encode it, and the signature is over its bytes.
    $verify = Start-Process -FilePath (Get-Command ssh-keygen).Source -NoNewWindow -Wait -PassThru `
        -ArgumentList @('-Y', 'verify', '-f', "`"$(Join-Path $Work 'allowed_signers')`"", '-I', 'invincible-release',
            '-n', 'invincible-release', '-s', "`"$(Join-Path $Work 'SHA256SUMS.sig')`"") `
        -RedirectStandardInput (Join-Path $Work 'SHA256SUMS') -RedirectStandardOutput (Join-Path $Work 'verify.out') `
        -RedirectStandardError (Join-Path $Work 'verify.err')
    if ($verify.ExitCode -ne 0) { Die "the release's SHA256SUMS is not signed with the Invincible release key; not installing it" }
    $Archive = "invincible-$Platform.tar.gz"
    $Line = Get-Content (Join-Path $Work 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($Archive))$" } | Select-Object -First 1
    if (-not $Line) { Die "the release has no $Archive" }
    $ArchiveSha = ($Line -split '\s+')[0]
    Ok 'release signature verified'

    Say "downloading $Archive"
    $ArchiveFile = Join-Path $Cache $Archive
    Fetch "$Base/$Archive" $ArchiveFile $ArchiveSha
    $Stage = Join-Path $Work 'stage'
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    & tar.exe -xzf $ArchiveFile -C $Stage
    if ($LASTEXITCODE -ne 0) { Die "$Archive does not unpack" }
    foreach ($program in 'invincible', 'autobot') {
        $new = Join-Path $Stage "invincible-$Platform\$program.exe"
        if (-not (Test-Path $new)) { Die "the archive has no $program.exe" }
        $dest = Join-Path $Bin "$program.exe"
        if ((Test-Path $dest) -and (Sha256 $dest) -eq (Sha256 $new)) { continue }
        # A running program cannot be replaced, but it can be renamed.
        if (Test-Path $dest) {
            Remove-Item -Force -ErrorAction SilentlyContinue "$dest.old"
            Move-Item -Force $dest "$dest.old"
        }
        Copy-Item $new $dest
    }
    Remove-Item -Force $ArchiveFile
    $Version = (& (Join-Path $Bin 'invincible.exe') --version)
    Ok "installed $Version in $Bin"

    # On the user's PATH, for new terminals; and for this one.
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($UserPath -split ';') -contains $Bin)) {
        [Environment]::SetEnvironmentVariable('Path', (@($UserPath, $Bin) | Where-Object { $_ }) -join ';', 'User')
        Ok "added $Bin to your PATH (new terminals have it)"
    }
    if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$env:Path;$Bin" }

    # --- 2. llama.cpp --------------------------------------------------------------------------
    $LlamaDir = Join-Path $InvHome 'llama.cpp'
    $LlamaServer = Join-Path $LlamaDir 'llama-server.exe'
    if (Get-Command llama-server -ErrorAction SilentlyContinue) {
        Ok "llama.cpp at $((Get-Command llama-server).Source)"
        $LlamaServer = $null
    } elseif (Test-Path $LlamaServer) {
        Ok "llama.cpp at $LlamaServer"
    } else {
        $kind = if ($Platform -eq 'windows-arm64') { 'cpu-arm64' }
            elseif (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { 'cuda-x64' }
            else { 'vulkan-x64' }
        Say "downloading llama.cpp $LlamaTag ($kind)"
        $parts = @(, $Llama[$kind])
        if ($kind -eq 'cuda-x64') { $parts += , $Llama['cudart-x64'] }
        $New = "$LlamaDir.new"
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $New
        New-Item -ItemType Directory -Force -Path $New | Out-Null
        foreach ($part in $parts) {
            $zip = Join-Path $Cache $part[0]
            Fetch "$LlamaUrl/$($part[0])" $zip $part[1]
            Expand-Archive -Force -LiteralPath $zip -DestinationPath $New
            Remove-Item -Force $zip
        }
        $found = Get-ChildItem -Recurse -LiteralPath $New -Filter 'llama-server.exe' | Select-Object -First 1
        if (-not $found) { Die 'the llama.cpp archive has no llama-server.exe' }
        # The server and the libraries beside it, at the top of the directory.
        if ($found.DirectoryName -ne $New) { Get-ChildItem -LiteralPath $found.DirectoryName | Move-Item -Force -Destination $New }
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $LlamaDir
        Move-Item $New $LlamaDir
        Ok "llama.cpp installed in $LlamaDir"
    }
    # The gateway finds llama-server on its PATH, unless told where it is.
    if ($LlamaServer) {
        $config = Join-Path $InvHome 'config.toml'
        $text = if (Test-Path $config) { Get-Content -Raw $config } else { '' }
        if ($text -notmatch '(?m)^llama_server') {
            $line = "llama_server = '$LlamaServer'"
            if ($text -match '(?m)^\[engine\]') { $text = $text -replace '(?m)^\[engine\]\r?$', "[engine]`n$line" }
            else { $text = "$text`n[engine]`n$line`n" }
            Set-Content -NoNewline -Encoding utf8 -Path $config -Value $text
        }
    }

    # --- 3. Services ---------------------------------------------------------------------------
    if ($env:INVINCIBLE_NO_SERVICE -ne '1') {
        Say 'starting the services (Task Scheduler, at logon)'
        & (Join-Path $Bin 'autobot.exe') service install
        if ($LASTEXITCODE -ne 0) { Warn 'the services did not start: `autobot service install` says why' }
    }
    Ok 'done: `autobot setup` picks a model and a chat channel; `autobot doctor` checks everything'
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
}
