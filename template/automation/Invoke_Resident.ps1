param(
    [Parameter(Mandatory=$true)][string]$AfterEffectsPath,
    [Parameter(Mandatory=$true)][string]$BuilderPath,
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [Parameter(Mandatory=$true)][string]$OutputPattern,
    [Parameter(Mandatory=$true)][string]$ResultPath,
    [Parameter(Mandatory=$true)][string]$JobStatusPath,
    [ValidateRange(1,100)][int]$CpuPercent = 70,
    [int]$TimeoutSeconds = 2100
)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'ResidentWorker.jsx'
if(-not(Test-Path -LiteralPath $source)){throw 'Не найден ResidentWorker.jsx.'}
$base=Join-Path $env:LOCALAPPDATA 'TelegramAEWorker'
$instances=Join-Path $base 'instances'
New-Item -ItemType Directory -Path $instances -Force | Out-Null
$lockPath=Join-Path $base 'worker.lock';$deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds);$lock=$null
while(-not $lock){
 try{$lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
 catch [IO.IOException]{if([DateTime]::UtcNow -ge $deadline){throw 'Не удалось дождаться освобождения фонового AE.'};Start-Sleep -Seconds 1}
}
try {
 $scriptHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
 $currentPath=Join-Path $base 'current.json';$current=$null;$usable=$false
 if(Test-Path -LiteralPath $currentPath){
  try{
   $candidate=Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
   $expectedRoot=[IO.Path]::GetFullPath($instances).TrimEnd('\')+'\'
   $candidateRoot=[IO.Path]::GetFullPath([string]$candidate.root)
   $proc=Get-Process -Id ([int]$candidate.pid) -ErrorAction Stop
   $ready=Get-Content -LiteralPath (Join-Path $candidateRoot 'worker_ready.json') -Raw | ConvertFrom-Json
   if($candidateRoot.StartsWith($expectedRoot,[StringComparison]::OrdinalIgnoreCase) -and
      $candidate.scriptHash -eq $scriptHash -and $ready.token -eq $candidate.token -and
      $proc.ProcessName -eq 'AfterFX' -and $proc.Path -eq $AfterEffectsPath -and
      $proc.StartTime.ToUniversalTime().Ticks -eq ([DateTime]$candidate.startUtc).ToUniversalTime().Ticks){$current=$candidate;$usable=$true}
  }catch{$usable=$false}
 }
 if(-not $usable){
  $id=[Guid]::NewGuid().ToString('N');$token=[Guid]::NewGuid().ToString('N');$instance=Join-Path $instances $id
  New-Item -ItemType Directory -Path $instance -ErrorAction Stop | Out-Null
  $worker=Join-Path $instance 'ResidentWorker.jsx';Copy-Item -LiteralPath $source -Destination $worker
  $version=(Get-Item -LiteralPath $AfterEffectsPath).VersionInfo.FileVersion
  if($version -notmatch '^(\d+\.\d+)'){throw 'Не удалось определить версию AE.'}
  $startup=Join-Path $env:APPDATA ('Adobe\After Effects\'+$Matches[1]+'\Scripts\Startup')
  New-Item -ItemType Directory -Path $startup -Force | Out-Null
  $stub=Join-Path $startup ('Telegram_Resident_'+$id+'.jsx')
  $workerLiteral=(($worker.Replace('\','/'))|ConvertTo-Json -Compress)
  $scheduled=(('$.evalFile(new File('+$workerLiteral+'));')|ConvertTo-Json -Compress)
  $stubText='(function(){if($.getenv("TELEGRAM_RESIDENT_TOKEN")!=="'+$token+'")return;app.scheduleTask('+$scheduled+',1500,false);}());'
  try{
   [IO.File]::WriteAllText($stub,$stubText,[Text.UTF8Encoding]::new($false))
   $env:TELEGRAM_RESIDENT_ROOT=$instance;$env:TELEGRAM_RESIDENT_TOKEN=$token
   $proc=Start-Process -FilePath $AfterEffectsPath -ArgumentList @('-m') -PassThru -WindowStyle Hidden
   $startDeadline=[DateTime]::UtcNow.AddSeconds(90);$readyPath=Join-Path $instance 'worker_ready.json';$ready=$null
   while([DateTime]::UtcNow -lt $startDeadline){
    if($proc.HasExited){throw 'Служебный AE завершился при запуске.'}
    if(Test-Path -LiteralPath $readyPath){try{$ready=Get-Content -LiteralPath $readyPath -Raw|ConvertFrom-Json;if($ready.token -eq $token){break}}catch{}}
    Start-Sleep -Seconds 1
   }
   if(-not $ready -or $ready.token -ne $token){throw ('Служебный AE не ответил: PID '+$proc.Id)}
   $current=@{pid=$proc.Id;token=$token;root=$instance;scriptHash=$scriptHash;startUtc=$proc.StartTime.ToUniversalTime().ToString('o')}
   $tempCurrent=Join-Path $base ('current_'+$id+'.tmp')
   [IO.File]::WriteAllText($tempCurrent,($current|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
   Move-Item -LiteralPath $tempCurrent -Destination $currentPath -Force
  }finally{
   if($stub -and (Test-Path -LiteralPath $stub)){Remove-Item -LiteralPath $stub}
   Remove-Item Env:TELEGRAM_RESIDENT_ROOT,Env:TELEGRAM_RESIDENT_TOKEN -ErrorAction SilentlyContinue
  }
 }
 $stateFile=Join-Path $current.root 'worker_state.json'
 do{
  $proc=Get-Process -Id ([int]$current.pid) -ErrorAction Stop
  $state=$null;if(Test-Path -LiteralPath $stateFile){try{$state=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json}catch{}}
  if($state -and $state.token -eq $current.token -and $state.status -eq 'idle'){break}
  if([DateTime]::UtcNow -ge $deadline){throw 'Фоновый AE не освободился вовремя.'}
  Start-Sleep -Seconds 1
 }while($true)
 $requestPath=Join-Path $current.root 'request.jsxinc';if(Test-Path -LiteralPath $requestPath){throw 'У фонового AE уже есть задание.'}
 $jobId=[Guid]::NewGuid().ToString('N')
 $request=@{id=$jobId;token=$current.token;builder=$BuilderPath;project=$ProjectPath;pattern=$OutputPattern;result=$ResultPath;status=$JobStatusPath;cpuPercent=$CpuPercent}
 $tmp=Join-Path $current.root ('request_'+$jobId+'.tmp')
 [IO.File]::WriteAllText($tmp,('('+($request|ConvertTo-Json -Compress)+');'),[Text.UTF8Encoding]::new($true))
 Move-Item -LiteralPath $tmp -Destination $requestPath
 do{
  $proc=Get-Process -Id ([int]$current.pid) -ErrorAction Stop
  $status=$null;if(Test-Path -LiteralPath $JobStatusPath){try{$status=Get-Content -LiteralPath $JobStatusPath -Raw|ConvertFrom-Json}catch{}}
  if($status -and $status.token -eq $current.token -and $status.job -eq $jobId){
   if($status.status -eq 'failed'){throw ('Фоновая сборка/рендер AE: '+$status.error+'; строка '+$status.line)}
   if($status.status -eq 'done'){break}
  }
  if([DateTime]::UtcNow -ge $deadline){throw ('Служебный AE не завершил задание вовремя; PID '+$current.pid)}
  Start-Sleep -Seconds 1
 }while($true)
 if(-not(Test-Path -LiteralPath $ResultPath)){throw 'Фоновый AE не создал отчёт сборки.'}
 Write-Output ('Resident AE PID '+$current.pid)
}finally{if($lock){$lock.Dispose()}}
