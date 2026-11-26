param(
    [string]$ProjectRoot = $PSScriptRoot,
    [string]$AfterEffectsDirectory,
    [switch]$Resume,
    [switch]$DisableResident, # Kept for commands that selected the former non-resident mode.
    [ValidateRange(1,100)][int]$CpuPercent = 70,
    [ValidateRange(1,86400)][int]$BuildTimeoutSeconds = 300,
    [ValidateRange(1,86400)][int]$RenderTimeoutSeconds = 1800
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$versionPath = Join-Path $root 'VERSION'
if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { throw 'Не найден VERSION. Скопируйте его из telegram-ae/main вместе с шаблоном.' }
$templateVersion = (Get-Content -LiteralPath $versionPath -Raw -Encoding UTF8).Trim()
if ($templateVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'В VERSION ожидается номер версии вида 1.0.0.' }
$name = Split-Path -Leaf $root
$stateBase = Join-Path $root '.render'
$stateDir = Join-Path $stateBase ('run_'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stateBase -Force | Out-Null
try {
    $jobLock = [IO.File]::Open((Join-Path $stateBase 'job.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch [IO.IOException] {
    throw "Не удалось заблокировать папку сюжета $root. $($_.Exception.Message)"
}

function Find-Executable([string]$Name) {
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $found) { throw ('Не найден необходимый инструмент: ' + $Name) }
    return $found.Source
}
function Save-State([string]$Stage, [hashtable]$Details = @{}) {
    $record = @{stage=$Stage;time=[DateTime]::UtcNow.ToString('o');templateVersion=$templateVersion}
    foreach ($key in $Details.Keys) { $record[$key]=$Details[$key] }
    [IO.File]::WriteAllText((Join-Path $stateDir 'status.json'), ($record|ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $record['directory']=$stateDir
    [IO.File]::WriteAllText((Join-Path $stateBase 'status.json'), ($record|ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Write-Output ('STAGE: ' + $Stage)
}
try {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    if (-not $AfterEffectsDirectory) {
        $registration = Get-Item -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe' -ErrorAction SilentlyContinue
        if ($registration -and $registration.GetValue('')) {
            $AfterEffectsDirectory = Split-Path -Parent ([string]$registration.GetValue(''))
        }
        if (-not $AfterEffectsDirectory) {
            $candidates = @()
            foreach ($base in @((Join-Path $env:ProgramFiles 'Adobe'), 'D:\Adobe')) {
                if (Test-Path -LiteralPath $base) {
                    $candidates += Get-ChildItem -LiteralPath $base -Directory -Filter 'Adobe After Effects*' | Sort-Object Name -Descending
                }
            }
            foreach ($candidate in $candidates) {
                $support = Join-Path $candidate.FullName 'Support Files'
                if (Test-Path -LiteralPath (Join-Path $support 'AfterFX.exe')) { $AfterEffectsDirectory=$support;break }
            }
        }
    }
    $afterfx = Join-Path $AfterEffectsDirectory 'AfterFX.exe'
    if (-not (Test-Path -LiteralPath $afterfx -PathType Leaf)) { throw 'Укажите папку Support Files установленного AE через -AfterEffectsDirectory.' }
    $ffmpeg = Find-Executable 'ffmpeg.exe'
    $ffprobe = Find-Executable 'ffprobe.exe'
    $project = Join-Path $root ($name+'.aep')
    $video = Join-Path $root ($name+'.mp4')
    foreach ($target in @($project,$video)) { if ((Test-Path -LiteralPath $target) -and -not ($Resume -and $target -eq $project)) { throw ('Выходной файл уже существует: '+$target) } }
    $sequenceDir = Join-Path $stateDir 'frames'
    $token = [Guid]::NewGuid().ToString('N')
    $job = @{
        token = $token
        templateVersion = $templateVersion
        builderPath = Join-Path $root 'Build_Telegram.jsx'
        projectPath = $project
        outputPattern = Join-Path $sequenceDir 'frame_[#####].tif'
        resultPath = Join-Path $stateDir 'build.json'
        statusPath = Join-Path $stateDir 'worker.json'
        cpuPercent = $CpuPercent
    }
    if ($Resume) {
        if (-not (Test-Path -LiteralPath $project)) { throw 'Для продолжения нужен ранее сохранённый AEP.' }
        $savedResult = $null
        foreach ($candidateResult in (Get-ChildItem -LiteralPath $stateBase -Filter 'build.json' -Recurse -File | Sort-Object LastWriteTimeUtc -Descending)) {
            $candidateBuild = Get-Content -LiteralPath $candidateResult.FullName -Raw | ConvertFrom-Json
            if ($candidateBuild.status -eq 'ready' -and $candidateBuild.project -eq $project) { $savedResult=$candidateResult;$build=$candidateBuild;break }
        }
        if (-not $savedResult) { throw 'Не найден отчёт успешной сборки этого AEP.' }
        if ($build.templateVersion -cne $templateVersion) { throw 'Для продолжения используйте скрипты и VERSION той версии, которой был собран AEP.' }
        if ((Get-Item -LiteralPath $project).LastWriteTimeUtc -gt $savedResult.LastWriteTimeUtc.AddSeconds(2)) { throw 'AEP изменён после сборки; нужна новая версия задания.' }
        $job.resumeComp = [string]$build.comp
        $job.resumeAudio = $build.audio
        if (-not $job.resumeComp) { throw 'В отчёте сборки отсутствует имя композиции.' }
        Save-State 'resuming' @{project=$project;comp=$build.comp}
    } else {
        foreach ($required in @($job.builderPath,(Join-Path $root 'shot.jsxinc'))) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Не найден $required." }
        }
        Save-State 'building' @{project=$project}
    }

    $helper = Join-Path $root 'automation\Invoke_Isolated.ps1'
    $workerPath = Join-Path $root 'automation\Prepare_Project.jsx'
    foreach ($required in @($helper,$workerPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Не найден $required." }
    }
    New-Item -ItemType Directory -Path $sequenceDir -ErrorAction Stop | Out-Null
    $jobJson = $job | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText((Join-Path $stateDir 'job.json'), $jobJson, [Text.UTF8Encoding]::new($true))
    $bootstrap = Join-Path ([IO.Path]::GetTempPath()) ("Telegram_AE_$token.jsx")
    $workerLiteral = ConvertTo-Json -InputObject $workerPath -Compress
    $script = "#target aftereffects`n" + '(function(){if($.getenv("TELEGRAM_AE_JOB_TOKEN")!=="' + $token +
        '"){return;}$.global.TELEGRAM_AE_JOB = ' + $jobJson +
        ';var f=new File($.global.TELEGRAM_AE_JOB.statusPath);f.encoding="UTF-8";' +
        'if(f.open("w")){f.write(' + (ConvertTo-Json -InputObject ('{"status":"loading","token":"' + $token + '"}') -Compress) +
        ');f.close();}$.evalFile(new File(' + $workerLiteral + '));}());'
    [IO.File]::WriteAllText($bootstrap, $script, [Text.UTF8Encoding]::new($true))
    . $helper
    Invoke-TelegramIsolatedAE -AfterEffectsPath $afterfx -WorkerPath $bootstrap -Token $token -JobStatusPath $job.statusPath -BuildTimeoutSeconds $BuildTimeoutSeconds -RenderTimeoutSeconds $RenderTimeoutSeconds

    $build = Get-Content -LiteralPath $job.resultPath -Raw | ConvertFrom-Json
    if ($build.status -ne 'ready' -or -not (Test-Path -LiteralPath $project -PathType Leaf)) { throw 'Изолированный AE не сохранил проект.' }
    if ($build.templateVersion -cne $templateVersion) { throw 'Версия собранного AEP не соответствует VERSION.' }
    Save-State 'checking_frames' @{project=$project;frames=$build.frames;comp=$build.comp}
    $ffPattern = Join-Path $sequenceDir 'frame_%05d.tif'
    for ($frame = 0; $frame -lt [int]$build.frames; $frame++) {
        $framePath = Join-Path $sequenceDir ('frame_{0:D5}.tif' -f $frame)
        if (-not (Test-Path -LiteralPath $framePath) -or (Get-Item -LiteralPath $framePath).Length -eq 0) { throw ('Отсутствует кадр рендера: '+$framePath) }
    }
    $sequenceRate = ([double]$build.fps).ToString([Globalization.CultureInfo]::InvariantCulture)
    Save-State 'encoding' @{video=$video}
    if ($build.audio) {
        $voicePath = [string]$build.audio.file
        if (-not (Test-Path -LiteralPath $voicePath)) { throw 'Не найден источник начитки для MP4.' }
        $voiceDuration = [double]$build.audio.duration
        $voiceFrame = [double]$build.audio.startFrame
        if ($voiceFrame -ne 15) { throw 'Начитка должна начинаться на кадре 15, нумерация от нуля.' }
        $offsetSamples = [long][Math]::Round(48000.0 * $voiceFrame / [double]$build.fps)
        if ($voiceDuration -le 0 -or ($voiceFrame / [double]$build.fps + $voiceDuration + 1 -gt [double]$build.duration + 0.00001)) { throw 'Неверная длительность начитки или паузы.' }
        $durationText = $voiceDuration.ToString([Globalization.CultureInfo]::InvariantCulture)
        $totalText = ([double]$build.duration).ToString([Globalization.CultureInfo]::InvariantCulture)
        $voiceFilter = "aresample=48000,atrim=duration=$durationText,asetpts=PTS-STARTPTS,adelay=${offsetSamples}S:all=1,apad"
        & $ffmpeg -hide_banner -loglevel error -nostdin -framerate $sequenceRate -start_number 0 -i $ffPattern -i $voicePath -map 0:v:0 -map 1:a:0 -af $voiceFilter -t $totalText -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart $video
    } else {
        & $ffmpeg -hide_banner -loglevel error -nostdin -framerate $sequenceRate -start_number 0 -i $ffPattern -an -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -movflags +faststart $video
    }
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить MP4.' }
    $probeText = & $ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_read_frames,duration -of json $video
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить готовый MP4.' }
    $stream = ($probeText|ConvertFrom-Json).streams[0]
    $rateParts = $stream.r_frame_rate -split '/'
    $actualFps = [double]$rateParts[0] / [double]$rateParts[1]
    if ($stream.width -ne $build.width -or $stream.height -ne $build.height -or [int]$stream.nb_read_frames -ne [int]$build.frames -or [Math]::Abs($actualFps-[double]$build.fps) -gt 0.0001 -or [Math]::Abs([double]$stream.duration-[double]$build.duration) -gt 0.05) { throw 'MP4 не совпадает с параметрами композиции.' }
    if ($build.audio) {
        $audioProbe = & $ffprobe -v error -select_streams a:0 -show_entries stream=codec_type,duration -of json $video
        if ($LASTEXITCODE -ne 0 -or -not (($audioProbe | ConvertFrom-Json).streams | Where-Object { $_.codec_type -eq 'audio' })) { throw 'В готовом MP4 не найдена звуковая дорожка.' }
    }
    $report = @("Template version: $templateVersion","After Effects: $($build.aeVersion)","Composition: $($build.comp)","Video: $($stream.width) x $($stream.height), $($build.fps) fps, $($stream.duration) s, $($stream.nb_read_frames) frames",'Codec: H.264 / yuv420p / CRF 17','Native AEP saved and rendered with After Effects.','Technical check: frame count, dimensions and duration match the native composition.','Visual inspection is performed separately.')
    if ($build.audio) { $report += ("Voiceover starts at frame $($build.audio.startFrame); source duration $($build.audio.duration) s; at least one second of silence follows.") }
    [IO.File]::WriteAllLines((Join-Path $root 'Render_Report.txt'),$report,[Text.UTF8Encoding]::new($false))
    # Keep logs and native project; discard only this job's verified frame files.
    for ($frame = 0; $frame -lt [int]$build.frames; $frame++) {
        Remove-Item -LiteralPath (Join-Path $sequenceDir ('frame_{0:D5}.tif' -f $frame))
    }
    Save-State 'complete' @{video=$video;project=$project;width=$build.width;height=$build.height;fps=$build.fps;duration=$build.duration;frames=$build.frames}
    Write-Output ([ordered]@{video=$video;project=$project}|ConvertTo-Json -Compress)
} catch {
    if (Test-Path -LiteralPath $stateDir) { Save-State 'failed' @{error=$_.Exception.Message} }
    throw
} finally {
    if ($bootstrap -and (Test-Path -LiteralPath $bootstrap)) { Remove-Item -LiteralPath $bootstrap -ErrorAction SilentlyContinue }
    $jobLock.Dispose()
}
