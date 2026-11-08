$ErrorActionPreference = 'Stop'
$distRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\dist')).Path.TrimEnd('\')
$distPrefix = $distRoot + '\'
$keep = @('深入·局域网互传-Windows.zip', '深入·局域网互传-Mac.zip', '归档资料')
foreach ($file in @('深入·局域网互传-Windows.zip', '深入·局域网互传-Mac.zip')) {
    if (-not (Test-Path -LiteralPath (Join-Path $distRoot $file) -PathType Leaf)) { throw "Missing final archive: $file" }
}
$moves = @()
$archiveStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
foreach ($item in @(Get-ChildItem -LiteralPath $distRoot)) {
    if ($keep -contains $item.Name) { continue }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $($item.Name)" }
    $category = '软件旧版'
    if ($item.Name -like '*功能宣传*') { $category = '宣传素材' }
    elseif ($item.Name -like '*上传信息*' -or $item.Extension -in @('.png', '.jpg')) { $category = '设计预览' }
    elseif ($item.Extension -in @('.svg', '.ai')) { $category = '品牌素材' }
    $destinationDirectory = [IO.Path]::GetFullPath((Join-Path $distRoot ('归档资料\' + $category)))
    $source = (Resolve-Path -LiteralPath $item.FullName).Path
    $target = [IO.Path]::GetFullPath((Join-Path $destinationDirectory $item.Name))
    # Validate both absolute paths before moving any directory recursively.
    if (-not $source.StartsWith($distPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not $target.StartsWith($distPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes dist' }
    if (Test-Path -LiteralPath $target) {
        $destinationDirectory = [IO.Path]::GetFullPath((Join-Path $destinationDirectory $archiveStamp))
        $target = [IO.Path]::GetFullPath((Join-Path $destinationDirectory $item.Name))
        if (-not $target.StartsWith($distPrefix, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $target)) { throw 'Archive collision or out-of-scope target' }
    }
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $target
    $moves += @{source=$source; target=$target}
}
$moves | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\.qa\dist-organization.json') -Encoding utf8
Get-ChildItem -LiteralPath $distRoot | Select-Object Name,Mode,Length | ConvertTo-Json -Compress
