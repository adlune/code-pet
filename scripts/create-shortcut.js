#!/usr/bin/env node
// Creates "Claude Pet" shortcuts on the Desktop and in the Start Menu that launch the pet
// directly through electron.exe.
// Usage: npm run shortcut            (create)
//        npm run shortcut -- --remove (delete them again)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') {
  console.error('Shortcuts are only supported on Windows.');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const remove = process.argv.includes('--remove');

if (!remove && !fs.existsSync(electronExe)) {
  console.error('Electron is not installed yet. Run "npm install" first.');
  process.exit(1);
}

// the pixel Claude icon, generated from src/icon.js
const iconPath = path.join(root, 'assets', 'icon.ico');
if (!remove) {
  fs.mkdirSync(path.dirname(iconPath), { recursive: true });
  fs.writeFileSync(iconPath, require('../src/icon').toIco());
}

// Values go in through environment variables so paths with spaces or quotes need no escaping.
const ps = `
$ErrorActionPreference = 'Stop'
$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($d in $dirs) {
  $lnk = Join-Path $d 'Claude Pet.lnk'
  if ($env:PET_REMOVE -eq '1') {
    if (Test-Path $lnk) { Remove-Item $lnk; Write-Output "removed  $lnk" }
    continue
  }
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $env:PET_EXE
  $s.Arguments = '"' + $env:PET_ROOT + '"'
  $s.WorkingDirectory = $env:PET_ROOT
  $s.IconLocation = $env:PET_ICON + ',0'
  $s.Description = 'Claude Pet'
  $s.Save()
  Write-Output "created  $lnk"
}
`;

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  stdio: 'inherit',
  env: { ...process.env, PET_EXE: electronExe, PET_ROOT: root, PET_ICON: iconPath, PET_REMOVE: remove ? '1' : '0' },
});
