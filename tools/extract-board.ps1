# Extracts the 9x9 board from image.png: region colors per cell + X-mark positions.
# Usage: powershell -File tools/extract-board.ps1 [-Image image.png]
param([string]$Image = "image.png")

Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile((Join-Path $PWD $Image))
$W = $bmp.Width
$H = $bmp.Height

function IsLinePixel($px) {
  $mx = [Math]::Max($px.R, [Math]::Max($px.G, $px.B))
  $mn = [Math]::Min($px.R, [Math]::Min($px.G, $px.B))
  return (($mx - $mn) -lt 40) -and ($mx -lt 170)
}

function Find-Lines($horizontal) {
  # For vertical lines ($horizontal=$false): scan columns, count line pixels.
  $len = if ($horizontal) { $W } else { $H }
  $span = if ($horizontal) { $H } else { $W }
  $hits = @()
  for ($i = 0; $i -lt $len; $i++) {
    $cnt = 0
    $tot = 0
    for ($j = 0; $j -lt $span; $j += 3) {
      $px = if ($horizontal) { $bmp.GetPixel($i, $j) } else { $bmp.GetPixel($j, $i) }
      $tot++
      if (IsLinePixel $px) { $cnt++ }
    }
    if ($cnt -gt $tot * 0.7) { $hits += $i }
  }
  # Group consecutive hits -> line centers
  $lines = @()
  $start = $hits[0]; $prev = $hits[0]
  for ($k = 1; $k -lt $hits.Count; $k++) {
    if ($hits[$k] -gt $prev + 2) {
      $lines += [int](($start + $prev) / 2)
      $start = $hits[$k]
    }
    $prev = $hits[$k]
  }
  $lines += [int](($start + $prev) / 2)
  return $lines
}

$vlines = Find-Lines $false
$hlines = Find-Lines $true
Write-Output "GRID $($vlines.Count)x$($hlines.Count) size=${W}x${H}"
if ($vlines.Count -ne $hlines.Count -or $vlines.Count -lt 2) {
  Write-Output ("V: " + ($vlines -join ","))
  Write-Output ("H: " + ($hlines -join ","))
  throw "expected a square grid line layout"
}
$N = $vlines.Count - 1
Write-Output "BOARD ${N}x${N}"

function Avg-Patch($cx, $cy) {
  $r = 0; $g = 0; $b = 0; $n = 0
  for ($dy = -1; $dy -le 1; $dy++) {
    for ($dx = -1; $dx -le 1; $dx++) {
      $px = $bmp.GetPixel($cx + $dx, $cy + $dy)
      $r += $px.R; $g += $px.G; $b += $px.B; $n++
    }
  }
  return @([int]($r / $n), [int]($g / $n), [int]($b / $n))
}

$cells = @()
for ($r = 0; $r -lt $N; $r++) {
  for ($c = 0; $c -lt $N; $c++) {
    $x0 = $vlines[$c]; $x1 = $vlines[$c + 1]
    $y0 = $hlines[$r]; $y1 = $hlines[$r + 1]
    $cw = $x1 - $x0; $ch = $y1 - $y0
    # background: 4 off-center points (avoid centered X strokes + borders)
    $pts = @(
      @([int]($x0 + $cw * 0.28), [int]($y0 + $ch * 0.28)),
      @([int]($x0 + $cw * 0.72), [int]($y0 + $ch * 0.28)),
      @([int]($x0 + $cw * 0.28), [int]($y0 + $ch * 0.72)),
      @([int]($x0 + $cw * 0.72), [int]($y0 + $ch * 0.72))
    )
    $br = 0; $bg = 0; $bb = 0
    foreach ($p in $pts) {
      $a = Avg-Patch $p[0] $p[1]
      $br += $a[0]; $bg += $a[1]; $bb += $a[2]
    }
    $br = [int]($br / 4); $bg = [int]($bg / 4); $bb = [int]($bb / 4)
    # X test: center whiteness vs background whiteness
    $ctr = Avg-Patch ([int]($x0 + $cw / 2)) ([int]($y0 + $ch / 2))
    $wCtr = [Math]::Min($ctr[0], [Math]::Min($ctr[1], $ctr[2]))
    $wBg = [Math]::Min($br, [Math]::Min($bg, $bb))
    $hasX = ($wCtr - $wBg) -gt 50
    $cells += [pscustomobject]@{ r = $r; c = $c; rgb = @($br, $bg, $bb); x = $hasX }
  }
}

# Greedy color clustering
$clusters = @()  # list of @{rgb; members}
foreach ($cell in $cells) {
  $best = -1; $bestD = 1e9
  for ($i = 0; $i -lt $clusters.Count; $i++) {
    $p = $clusters[$i].rgb
    $dr = $cell.rgb[0] - $p[0]; $dg = $cell.rgb[1] - $p[1]; $db = $cell.rgb[2] - $p[2]
    $d = [Math]::Sqrt($dr * $dr + $dg * $dg + $db * $db)
    if ($d -lt $bestD) { $bestD = $d; $best = $i }
  }
  if ($best -ge 0 -and $bestD -lt 30) { $clusters[$best].members += $cell }
  else { $clusters += [pscustomobject]@{ rgb = $cell.rgb; members = @($cell) } }
}

$result = [pscustomobject]@{
  clusterCount = $clusters.Count
  palette = @($clusters | ForEach-Object { $_.rgb })
  sizes = @($clusters | ForEach-Object { $_.members.Count })
  maxDist = @(
    $clusters | ForEach-Object {
      $p = $_.rgb; $m = 0
      foreach ($cell in $_.members) {
        $dr = $cell.rgb[0] - $p[0]; $dg = $cell.rgb[1] - $p[1]; $db = $cell.rgb[2] - $p[2]
        $d = [Math]::Sqrt($dr * $dr + $dg * $dg + $db * $db)
        if ($d -gt $m) { $m = $d }
      }
      [Math]::Round($m, 1)
    }
  )
  marks = @($cells | Where-Object { $_.x } | ForEach-Object { @($_.r, $_.c) })
  grid = @(
    for ($r = 0; $r -lt $N; $r++) {
      ,@($cells | Where-Object { $_.r -eq $r } | Sort-Object c | ForEach-Object {
        $ci = $_
        $id = -1
        for ($i = 0; $i -lt $clusters.Count; $i++) {
          if ($clusters[$i].members -contains $ci) { $id = $i; break }
        }
        $id
      })
    }
  )
}
$bmp.Dispose()
$result | ConvertTo-Json -Depth 6 -Compress
