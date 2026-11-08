"""Build unsigned native menu-bar .app ZIPs with explicit Unix permissions.

Build requirements: Python 3 + Pillow, Node 24 on the build computer. Neither
Python nor a user-installed Node is needed by the resulting applications.
"""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import os
import plistlib
import stat
import struct
import subprocess
import sys
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
PINNED = {
    'arm64': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    'x64': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def icon_assets():
    source = Image.open(ROOT / 'public/brand/logo.png').convert('RGBA')
    # Retain the source silhouette; AppKit template mode supplies the system's
    # light/dark menu-bar color from alpha, without a separately drawn symbol.
    menu = source.resize((76, 76), Image.Resampling.LANCZOS)
    menu_bytes = BytesIO()
    menu.save(menu_bytes, format='PNG')
    icon = source.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon_bytes = BytesIO()
    icon.save(icon_bytes, format='ICNS')
    return menu_bytes.getvalue(), icon_bytes.getvalue()


def zip_entry(archive, name, data, executable=False):
    info = zipfile.ZipInfo(name, (2026, 11, 5, 0, 0, 0))
    info.create_system = 3  # Unix; Finder honors the stored execute bits.
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)


def instructions(arch):
    cpu = 'Apple Silicon（M 系列）' if arch == 'arm64' else 'Intel'
    return f'''深入·局域网互传 {VERSION} · macOS {cpu} · APP + HTML

1. 要求 macOS 13.5 或更高版本。请先解压整个压缩包，保留“深入·局域网互传.app”和“深入·局域网互传.html”在同一文件夹，再双击应用。可将整个文件夹移到喜欢的位置；应用运行期间请勿移动。
2. 程序使用系统原生菜单栏，在屏幕顶部显示深入·局域网互传标志。点击可选择“打开深入·局域网互传”或“退出深入·局域网互传”。关闭浏览器后，菜单栏应用继续运行；再次打开应用会回到现有空间。
3. 自动寻找局域网内已有的深入·局域网互传，找到就加入，否则本机提供服务。macOS、Windows 电脑可以互相加入。首次出现网络/本地网络提示时，请允许在信任的网络通信；访客 Wi-Fi 隔离或防火墙可能影响发现。
4. 启动后，同文件夹的“深入·局域网互传.html”会更新成当前主机地址。把它发给同一 Wi-Fi / 局域网的朋友，朋友打开后点击进入即可。HTML 本身不会启动应用。地址变化后请重新发送更新后的文件。
5. 启动和“打开深入·局域网互传”会直接打开当前空间网页。特殊网络地址会使用 HTML 入口。如果应用所在文件夹不可写，HTML 入口保存在 ~/Library/Application Support/Shenru/data/深入·局域网互传.html；网页也可下载入口。
6. “退出深入·局域网互传”只退出本机。加入者退出不影响远端主机；主机退出会结束当前空间，临时聊天与文件不会迁移。身份数据库和缓存位于 ~/Library/Application Support/Shenru/data。
7. 无需安装 Node、Python 或浏览器扩展。本包包含经官方 SHA256 校验的 Node 24.22.1 {arch} 运行时，保留其许可证。原生菜单和打开网页不使用 Apple Events UI 自动化权限。

发布状态：本应用未做 Developer ID 签名或 Apple 公证，且当前构建环境为 Windows，尚未在真实 Mac 上完成 UI/网络验收。macOS 可能阻止首次打开；只在确认来源可信后按系统“隐私与安全性”中的提示操作。应用跨平台逻辑测试通过不等于 Mac 实机验证通过。
'''.encode('utf-8') + (ROOT/'docs/content-encryption.txt').read_bytes()


def build(arch, menu_icon, app_icon, entry_html):
    if arch not in PINNED:
        raise ValueError('Expected arm64 or x64')
    runtime = ROOT / f'runtime/macos-{arch}'
    provenance = json.loads((runtime / 'PROVENANCE.json').read_text(encoding='utf-8'))
    node = (runtime / 'bin/node').read_bytes()
    official_archive = runtime / f'node-v24.22.1-darwin-{arch}.tar.gz'
    assert sha(official_archive.read_bytes()) == PINNED[arch] == provenance['archiveSha256']
    assert sha(node) == provenance['nodeSha256']
    magic, cpu = struct.unpack_from('<II', node)
    assert magic == 0xFEEDFACF
    assert cpu == (0x0100000C if arch == 'arm64' else 0x01000007)
    folder = f'深入·局域网互传 macOS-{arch}'
    app = folder + '/深入·局域网互传.app/Contents/'
    info = {
        'CFBundleInfoDictionaryVersion': '6.0', 'CFBundleIdentifier': 'cn.shenru.lan-chat',
        'CFBundleName': '深入·局域网互传', 'CFBundleDisplayName': '深入·局域网互传', 'CFBundleExecutable': 'Shenru',
        'CFBundleIconFile': 'Shenru.icns', 'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': VERSION, 'CFBundleVersion': VERSION,
        'LSMinimumSystemVersion': '13.5', 'LSUIElement': True,
        'NSHighResolutionCapable': True,
        'NSLocalNetworkUsageDescription': '深入·局域网互传使用本地网络发现同一局域网中的空间，并进行聊天与原文件互传。',
    }
    files = {
        app + 'Info.plist': plistlib.dumps(info), app + 'PkgInfo': b'APPL????',
        app + 'MacOS/Shenru': (ROOT / 'launcher/macos/Shenru').read_bytes().replace(b'\r\n', b'\n'),
        app + 'Resources/menu.js': (ROOT / 'launcher/macos/menu.js').read_bytes(),
        app + 'Resources/menu-icon.png': menu_icon,
        app + 'Resources/Shenru.icns': app_icon,
        app + 'Resources/runtime/node': node,
        app + 'Resources/runtime/LICENSE': (runtime / 'LICENSE').read_bytes(),
        app + 'Resources/runtime/PROVENANCE.json': (runtime / 'PROVENANCE.json').read_bytes(),
        app + 'Resources/runtime/SHASUMS256.txt': (runtime / 'SHASUMS256.txt').read_bytes(),
        folder + '/深入·局域网互传.html': entry_html,
        folder + '/使用说明.txt': instructions(arch),
    }
    for name in ['server.mjs', 'portable.mjs', 'desktop-macos.mjs', 'package.json']:
        files[app + 'Resources/app/' + name] = (ROOT / name).read_bytes()
    for name in ['lib', 'public']:
        for path in sorted((ROOT / name).rglob('*')):
            if path.is_file():
                assert not path.is_symlink(), 'Do not package symbolic links'
                files[app + 'Resources/app/' + path.relative_to(ROOT).as_posix()] = path.read_bytes()
    hashes = '\n'.join(f'{sha(data)}  {name[len(folder) + 1:]}' for name, data in sorted(files.items())) + '\n'
    files[folder + '/SHA256SUMS.txt'] = hashes.encode('utf-8')
    target = ROOT / 'dist' / f'深入·局域网互传-{VERSION}-APP+HTML-macOS-{arch}.zip'
    pending = target.with_suffix('.zip.pending')
    executable = {app + 'MacOS/Shenru', app + 'Resources/runtime/node'}
    with zipfile.ZipFile(pending, 'w', allowZip64=True) as archive:
        # Include directory entries explicitly for Finder/Archive Utility.
        directories = {str(Path(name).parent).replace('\\', '/') + '/' for name in files}
        for name in sorted(directories):
            parts = name.rstrip('/').split('/')
            for n in range(1, len(parts) + 1):
                directory = '/'.join(parts[:n]) + '/'
                if directory in archive.namelist():
                    continue
                entry = zipfile.ZipInfo(directory, (2026, 11, 5, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = (stat.S_IFDIR | 0o755) << 16 | 0x10
                archive.writestr(entry, b'')
        for name, data in sorted(files.items()):
            zip_entry(archive, name, data, name in executable)
    with zipfile.ZipFile(pending) as archive:
        assert archive.testzip() is None
        for name, data in files.items():
            assert archive.read(name) == data
        for name in executable:
            assert stat.S_IMODE(archive.getinfo(name).external_attr >> 16) == 0o755
        packaged = plistlib.loads(archive.read(app + 'Info.plist'))
        assert packaged['CFBundleShortVersionString'] == VERSION and packaged['LSUIElement']
        assert not any(name.endswith('.exe') for name in archive.namelist())
    os.replace(pending, target)
    result = {'archive': str(target), 'arch': arch, 'version': VERSION, 'bytes': target.stat().st_size,
              'sha256': sha(target.read_bytes()), 'files': len(files), 'nodeSha256': sha(node),
              'runtimeArchiveSha256': PINNED[arch], 'crc': 'all passed', 'unixExecutableModes': '0755',
              'signed': False, 'notarized': False, 'nativeMacExecuted': False}
    print(json.dumps(result, ensure_ascii=False))
    return result


def main():
    (ROOT / 'dist').mkdir(exist_ok=True)
    (ROOT / '.qa').mkdir(exist_ok=True)
    arches = sys.argv[1:] or ['arm64', 'x64']
    node = os.environ.get('NODE', 'node')
    entry_html = subprocess.check_output([node, '--input-type=module', '-e', "import {renderEntry} from './lib/entry.mjs'; process.stdout.write(renderEntry([]));"], cwd=ROOT)
    menu, icon = icon_assets()
    results = [build(arch, menu, icon, entry_html) for arch in arches]
    (ROOT / '.qa/macos-package-report.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
