import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const python = process.env.PYTHON || (existsSync(bundled) ? bundled : 'python3');
execFileSync(python, [join(root, 'scripts', 'package-macos.py'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE: process.execPath, PYTHONIOENCODING: 'utf-8' } });
