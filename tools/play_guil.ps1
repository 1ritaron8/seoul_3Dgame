param([string]$UnrealEditor)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repo 'Guil2026\Guil2026.uproject'
$projectDir = Split-Path -Parent $project
$level = '/Game/GuilWalk/ShinyeongWalk'
$mapFile = Join-Path $projectDir 'Content\GuilWalk\ShinyeongWalk.umap'
$saved = Join-Path $projectDir 'Saved'

function Get-MapDigest {
    $stream = [IO.File]::OpenRead($mapFile)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Find-UnrealEditor {
    if ($UnrealEditor) {
        $file = Get-Item -LiteralPath $UnrealEditor
        if ($file.PSIsContainer -or $file.Name -ne 'UnrealEditor.exe') { throw 'Expected the path to UnrealEditor.exe.' }
        return $file.FullName
    }
    $command = Get-Command UnrealEditor.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }

    $manifest = Join-Path $env:ProgramData 'Epic\UnrealEngineLauncher\LauncherInstalled.dat'
    $installs = @(
        if (Test-Path -LiteralPath $manifest) {
            try {
                (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).InstallationList
            } catch { Write-Warning 'Could not read the Epic Launcher installation list.' }
        }
        $defaultDir = Join-Path $env:ProgramFiles 'Epic Games'
        if (Test-Path -LiteralPath $defaultDir) {
            Get-ChildItem -LiteralPath $defaultDir -Directory -Filter 'UE_5.*' | ForEach-Object {
                [pscustomobject]@{ AppName = $_.Name; InstallLocation = $_.FullName }
            }
        }
    )
    $installedUE5 = $installs | Where-Object { $_.AppName -match '^UE_5\.\d+(\.\d+)?$' } |
        Sort-Object { [version]$_.AppName.Substring(3) } -Descending
    foreach ($install in $installedUE5) {
        $file = Join-Path $install.InstallLocation 'Engine\Binaries\Win64\UnrealEditor.exe'
        if (Test-Path -LiteralPath $file -PathType Leaf) { return $file }
    }
    throw 'UE5 was not found. If installed elsewhere, use Play-Guil.cmd -UnrealEditor "D:\...\Engine\Binaries\Win64\UnrealEditor.exe".'
}

function Get-FirstRunPackConfig($editorDir, $runId) {
    $content = Join-Path $projectDir 'Content'
    if (Test-Path -LiteralPath $content -PathType Container) {
        $existingAsset = Get-ChildItem -LiteralPath $content -File -Recurse |
            Where-Object { $_.Extension -in '.uasset', '.umap' } | Select-Object -First 1
        if ($existingAsset) { return }
    }
    # Import Epic's installed Blueprint pack only into an empty project. Keep the
    # startup action private to this editor invocation so later edits are preserved.
    $packDir = [IO.Path]::GetFullPath((Join-Path $editorDir '..\..\..\FeaturePacks'))
    $packName = 'TP_FirstPersonBP.upack', 'FP_FirstPersonBP.upack' |
        Where-Object { Test-Path -LiteralPath (Join-Path $packDir $_) -PathType Leaf } | Select-Object -First 1
    if (-not $packName) {
        throw 'First Person Blueprint pack not found. Add First Person using the UE editor, or enable Templates and Feature Packs in Epic Launcher, then retry. See the home handoff in docs.'
    }
    $existingConfig = Join-Path $projectDir 'Config\DefaultGame.ini'
    $settings = if (Test-Path -LiteralPath $existingConfig) { [IO.File]::ReadAllText($existingConfig) } else { '' }
    if ($settings -match '(?im)^\s*\[StartupActions\]') { return }
    $config = Join-Path $saved ("GuilWalk-first-run-" + $runId + '.ini')
    $action = '[StartupActions]', 'bAddPacks=True', ('InsertPack=(PackSource="{0}",PackName="FirstPerson")' -f $packName)
    [IO.File]::WriteAllText($config, ($settings + [Environment]::NewLine + ($action -join [Environment]::NewLine) + [Environment]::NewLine))
    return $config
}

try {
    $editor = Find-UnrealEditor
    $editorDir = Split-Path -Parent $editor
    [IO.Directory]::CreateDirectory($saved) | Out-Null
    $marker = Join-Path $saved 'GuilWalk.home.sha256'
    $lockPath = Join-Path $saved 'GuilWalk.home.lock'
    $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    $packConfig = $null
    try {
        $ready = (Test-Path -LiteralPath $mapFile -PathType Leaf) -and
            (Test-Path -LiteralPath $marker -PathType Leaf) -and
            ([IO.File]::ReadAllText($marker).Trim() -eq (Get-MapDigest))
        if (-not $ready) {
            $builderExe = Join-Path $editorDir 'UnrealEditor-Cmd.exe'
            $builder = Join-Path $PSScriptRoot 'build_shinyeong_walk.py'
            $runId = [guid]::NewGuid().ToString('N')
            $log = Join-Path $saved ("GuilWalk-home-" + $runId + '.log')
            $packConfig = Get-FirstRunPackConfig $editorDir $runId
            $buildArgs = @(('"{0}"' -f $project), ('-ExecutePythonScript="{0}"' -f $builder),
                ('-AbsLog="{0}"' -f $log), '-unattended', '-nosplash')
            if ($packConfig) { $buildArgs += ('-DefGameIni="{0}"' -f $packConfig) }
            Write-Host "Preparing Shinyeong in UE5. The first import can take several minutes. Log: $log"
            $process = Start-Process -FilePath $builderExe -ArgumentList $buildArgs -WorkingDirectory $repo -WindowStyle Hidden -Wait -PassThru
            $successMessages = "Walking map saved: $level", "Existing walking map reopened unchanged: $level"
            if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $mapFile -PathType Leaf) -or
                (Get-Item -LiteralPath $mapFile).Length -eq 0 -or -not (Test-Path -LiteralPath $log -PathType Leaf) -or
                -not (Select-String -LiteralPath $log -SimpleMatch -Pattern $successMessages -Quiet)) {
                throw "UE5 did not verify the walking map. See $log and the home handoff in docs."
            }
            [IO.File]::WriteAllText($marker, (Get-MapDigest))
        }
    } finally {
        try { if ($packConfig) { [IO.File]::Delete($packConfig) } } finally { $lock.Dispose() }
    }
    Write-Host 'Starting Shinyeong. WASD to walk, mouse to look. Alt+F4 to exit.'
    Start-Process -FilePath $editor -ArgumentList @(('"{0}"' -f $project), $level, '-game', '-windowed') -WorkingDirectory $repo
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
exit 0
