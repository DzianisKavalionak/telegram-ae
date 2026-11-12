param(
    [string]$ProjectRoot = $PSScriptRoot,
    [string]$AfterEffectsDirectory,
    [switch]$Resume,
    [ValidateRange(1,100)][int]$CpuPercent = 70,
    [int]$BuildTimeoutSeconds = 300,
    [int]$RenderTimeoutSeconds = 1800
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$name = Split-Path -Leaf $root
$stateBase = Join-Path $root '.render'
$stateDir = Join-Path $stateBase ('run_'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Find-Executable([string]$Name) {
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $found) { throw ('Не найден необходимый инструмент: ' + $Name) }
    return $found.Source
}
function Save-State([string]$Stage, [hashtable]$Details = @{}) {
    $record = @{stage=$Stage;time=[DateTime]::UtcNow.ToString('o')}
    foreach ($key in $Details.Keys) { $record[$key]=$Details[$key] }
    [IO.File]::WriteAllText((Join-Path $stateDir 'status.json'), ($record|ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $record['directory']=$stateDir
    [IO.File]::WriteAllText((Join-Path $stateBase 'status.json'), ($record|ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Write-Output ('STAGE: ' + $Stage)
}
function Wait-Worker($Process, [int]$Timeout, [string]$Stage) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Timeout)
    while (-not $Process.HasExited) {
        if ([DateTime]::UtcNow -gt $deadline) {
            throw ($Stage + ' не завершился за отведённое время. Процесс задания: ' + $Process.Id + '. Проверьте .render; открытый пользовательский AE не затрагивался.')
        }
        Start-Sleep -Seconds 2
        $Process.Refresh()
    }
    return $Process.ExitCode
}
try {
    if (-not $AfterEffectsDirectory) {
        $running = Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1
        if ($running) { $AfterEffectsDirectory = Split-Path -Parent $running.Path }
        if (-not $AfterEffectsDirectory) {
            $candidates = @()
            foreach ($base in @((Join-Path $env:ProgramFiles 'Adobe'), 'D:\Adobe')) {
                if (Test-Path -LiteralPath $base) {
                    $candidates += Get-ChildItem -LiteralPath $base -Directory -Filter 'Adobe After Effects*' | Sort-Object Name -Descending
                }
            }
            foreach ($candidate in $candidates) {
                $support = Join-Path $candidate.FullName 'Support Files'
                if (Test-Path -LiteralPath (Join-Path $support 'aerender.exe')) { $AfterEffectsDirectory=$support;break }
            }
        }
    }
    $afterfx = Join-Path $AfterEffectsDirectory 'AfterFX.exe'
    $aerender = Join-Path $AfterEffectsDirectory 'aerender.exe'
    if (-not (Test-Path -LiteralPath $afterfx) -or -not (Test-Path -LiteralPath $aerender)) { throw 'Укажите папку Support Files установленного AE через -AfterEffectsDirectory.' }
    $ffmpeg = Find-Executable 'ffmpeg.exe'
    $ffprobe = Find-Executable 'ffprobe.exe'
    $project = Join-Path $root ($name+'.aep')
    $video = Join-Path $root ($name+'.mp4')
    $archive = Join-Path (Split-Path -Parent $root) ($name+'_Project.zip')
    foreach ($target in @($project,$video,$archive)) { if ((Test-Path -LiteralPath $target) -and -not ($Resume -and $target -eq $project)) { throw ('Выходной файл уже существует: '+$target) } }
    $token = [Guid]::NewGuid().ToString('N')
    $job = @{
        token=$token;builderPath=(Join-Path $root 'Build_Telegram.jsx');projectPath=$project
        intermediatePath=(Join-Path $stateDir 'master.avi');resultPath=(Join-Path $stateDir 'build.json')
        outputTemplate='Lossless'
    }
    if ($Resume) {
        if (-not (Test-Path -LiteralPath $project)) { throw 'Для продолжения нужен ранее сохранённый AEP.' }
        $savedResult = $null
        foreach ($candidateResult in (Get-ChildItem -LiteralPath $stateBase -Filter 'build.json' -Recurse -File | Sort-Object LastWriteTimeUtc -Descending)) {
            $candidateBuild = Get-Content -LiteralPath $candidateResult.FullName -Raw | ConvertFrom-Json
            if ($candidateBuild.status -eq 'ready' -and $candidateBuild.project -eq $project) { $savedResult=$candidateResult;$build=$candidateBuild;break }
        }
        if (-not $savedResult) { throw 'Не найден отчёт успешной сборки этого AEP.' }
        if ((Get-Item -LiteralPath $project).LastWriteTimeUtc -gt $savedResult.LastWriteTimeUtc.AddSeconds(2)) { throw 'AEP изменён после сборки; нужна новая версия задания.' }
        [IO.File]::WriteAllText($job.resultPath,($build|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
        Save-State 'resuming' @{project=$project;comp=$build.comp}
    } else {
    $bootstrap = Join-Path ([IO.Path]::GetTempPath()) ('telegram-ae-'+$token)
    New-Item -ItemType Directory -Path $bootstrap | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'automation\Prepare_Project.jsx') -Destination (Join-Path $bootstrap 'Prepare_Project.jsx')
    $descriptor = Join-Path $bootstrap 'job.jsxinc'
    [IO.File]::WriteAllText($descriptor, ('('+($job|ConvertTo-Json -Depth 4)+');'), [Text.UTF8Encoding]::new($true))
    $env:TELEGRAM_AE_JOB_PATH = $descriptor
    $env:TELEGRAM_AE_JOB_TOKEN = $token
    # AE 26.x does not reliably dispatch -r to an instance started with -m.
    # A per-job startup stub reaches only the new process carrying this token.
    $aeVersion = (Get-Item -LiteralPath $afterfx).VersionInfo.FileVersion
    if ($aeVersion -notmatch '^(\d+\.\d+)') { throw 'Не удалось определить версию профиля AE.' }
    $startupDirectory = Join-Path $env:APPDATA ('Adobe\After Effects\'+$Matches[1]+'\Scripts\Startup')
    New-Item -ItemType Directory -Path $startupDirectory -Force | Out-Null
    $startupStub = Join-Path $startupDirectory ('Telegram_AE_Job_'+$token+'.jsx')
    $workerLiteral = ((Join-Path $bootstrap 'Prepare_Project.jsx').Replace('\','/') | ConvertTo-Json -Compress)
    $scheduledLiteral = (('$.evalFile(new File('+$workerLiteral+'));') | ConvertTo-Json -Compress)
    $stubSource = '(function(){if($.getenv("TELEGRAM_AE_JOB_TOKEN")!=="'+$token+'")return;app.scheduleTask('+$scheduledLiteral+',1500,false);}());'
    [IO.File]::WriteAllText($startupStub,$stubSource,[Text.UTF8Encoding]::new($false))
    Save-State 'building' @{project=$project}
    $worker = Start-Process -FilePath $afterfx -ArgumentList @('-m') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'build.stdout.log') -RedirectStandardError (Join-Path $stateDir 'build.stderr.log')
    $buildExit = Wait-Worker $worker $BuildTimeoutSeconds 'Сборка AEP'
    if (-not (Test-Path -LiteralPath $job.resultPath)) { throw ('AE не создал отчёт сборки. Код процесса: '+$buildExit+'. Проверьте build.stdout.log и build.stderr.log.') }
    $build = Get-Content -LiteralPath $job.resultPath -Raw | ConvertFrom-Json
    if ($build.status -ne 'ready' -or -not (Test-Path -LiteralPath $project)) { throw ('Ошибка сборки AE: '+$build.error+'; строка '+$build.line) }
    }
    Save-State 'rendering' @{project=$project;frames=$build.frames;comp=$build.comp}
    if (-not ($build.availableOutputTemplates -contains 'TIFF Sequence with Alpha')) { throw 'В AE не найден шаблон TIFF Sequence with Alpha для надёжного рендера кадров.' }
    $sequenceDir = Join-Path $stateDir 'frames'
    New-Item -ItemType Directory -Path $sequenceDir -ErrorAction Stop | Out-Null
    $aePattern = Join-Path $sequenceDir 'frame_[#####].tif'
    $ffPattern = Join-Path $sequenceDir 'frame_%05d.tif'
    $renderArgs = @('-project',('"'+$project+'"'),'-comp',('"'+$build.comp+'"'),'-OMtemplate','"TIFF Sequence with Alpha"','-output',('"'+$aePattern+'"'),'-mfr','ON',[string]$CpuPercent,'-mem_usage','10','60','-sound','OFF')
    $render = Start-Process -FilePath $aerender -ArgumentList $renderArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'aerender.stdout.log') -RedirectStandardError (Join-Path $stateDir 'aerender.stderr.log')
    $renderExit = Wait-Worker $render $RenderTimeoutSeconds 'Фоновый рендер'
    if ($renderExit -ne 0) { throw ('aerender завершился с кодом '+$renderExit+'. Проверьте журнал в .render.') }
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
        $voiceFrame = [int]$build.audio.startFrame
        $offsetSamples = [long][Math]::Round(48000.0 * $voiceFrame / [double]$build.fps)
        if ($voiceFrame -lt 0 -or $voiceDuration -le 0 -or ($voiceFrame / [double]$build.fps + $voiceDuration + 1 -gt [double]$build.duration + 0.00001)) { throw 'Неверный тайминг начитки или паузы.' }
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
    $report = @("After Effects: $($build.aeVersion)","Composition: $($build.comp)","Video: $($stream.width) x $($stream.height), $($build.fps) fps, $($stream.duration) s, $($stream.nb_read_frames) frames",'Codec: H.264 / yuv420p / CRF 17','Native AEP saved and rendered with aerender.','Technical check: frame count, dimensions and duration match the native composition.','Visual inspection is performed separately.')
    if ($build.audio) { $report += ("Voiceover starts at frame $($build.audio.startFrame); source duration $($build.audio.duration) s; at least one second of silence follows.") }
    [IO.File]::WriteAllLines((Join-Path $root 'Render_Report.txt'),$report,[Text.UTF8Encoding]::new($false))
    Save-State 'packaging' @{video=$video;project=$project}
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = @('Build_Telegram.jsx','shot.jsxinc','README.txt','Render_Report.txt','Render_Telegram.ps1','automation\Prepare_Project.jsx',($name+'.aep'))
        $files += Get-ChildItem -LiteralPath (Join-Path $root 'assets') -File | ForEach-Object { 'assets\'+$_.Name }
        foreach ($relative in $files) {
            $file = Join-Path $root $relative
            if (-not (Test-Path -LiteralPath $file)) { throw ('Не найден файл для архива: '+$relative) }
            $entry = $name+'/'+$relative.Replace('\','/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file,$entry,[IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $zip.Dispose() }
    Save-State 'complete' @{video=$video;project=$project;archive=$archive;width=$build.width;height=$build.height;fps=$build.fps;duration=$build.duration;frames=$build.frames}
    # Keep logs and native project; discard only this job's verified frame files.
    for ($frame = 0; $frame -lt [int]$build.frames; $frame++) {
        Remove-Item -LiteralPath (Join-Path $sequenceDir ('frame_{0:D5}.tif' -f $frame))
    }
    Write-Output ([ordered]@{video=$video;project=$project;archive=$archive}|ConvertTo-Json -Compress)
} catch {
    Save-State 'failed' @{error=$_.Exception.Message}
    throw
} finally {
    if ($startupStub -and (Test-Path -LiteralPath $startupStub)) { Remove-Item -LiteralPath $startupStub }
    Remove-Item Env:TELEGRAM_AE_JOB_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:TELEGRAM_AE_JOB_TOKEN -ErrorAction SilentlyContinue
}
