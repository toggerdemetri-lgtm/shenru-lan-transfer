"""Consolidate verified releases into one Windows ZIP and one auto-selecting Mac app.

Does not delete or move any originals; organize dist separately after verification.
"""
from pathlib import Path
import hashlib,json,plistlib,shutil,stat,zipfile,struct

ROOT=Path(__file__).resolve().parent.parent
DIST=ROOT/'dist'
def find(name):
    direct=DIST/name
    if direct.exists():return direct
    matches=list((DIST/'归档资料/软件旧版').rglob(name))
    if not matches:raise RuntimeError(f'Cannot locate source: {name}')
    return max(matches,key=lambda p:p.stat().st_mtime)
def digest(data):return hashlib.sha256(data).hexdigest()
def app_files(path):
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        prefix=next(n[:-len('Contents/Info.plist')] for n in z.namelist() if n.endswith('Contents/Info.plist'))
        return {n[len(prefix):]:z.read(n) for n in z.namelist() if n.startswith(prefix) and not n.endswith('/')}

win=find('深入·局域网互传-1.0.0-EXE+HTML-Windows-x64.zip')
mac={arch:app_files(find(f'深入·局域网互传-1.0.0-APP+HTML-macOS-{arch}.zip')) for arch in ['arm64','x64']}
runtime='Contents/Resources/runtime/'
shared={k:v for k,v in mac['arm64'].items() if not k.startswith(runtime)}
assert shared=={k:v for k,v in mac['x64'].items() if not k.startswith(runtime)},'Platform-independent Mac sources differ'
files=dict(shared)
executables={'Contents/MacOS/Shenru',runtime+'node'}
nodes={}
for arch,source in mac.items():
    node=source[runtime+'node']
    provenance=json.loads(source[runtime+'PROVENANCE.json'])
    assert digest(node)==provenance['nodeSha256']
    magic,cpu=struct.unpack_from('<II',node)
    assert magic==0xFEEDFACF and cpu=={'arm64':0x0100000C,'x64':0x01000007}[arch]
    for name,value in source.items():
        if name.startswith(runtime):files[runtime+arch+'/'+name[len(runtime):]]=value
    executables.add(runtime+arch+'/node')
    nodes[arch]={'nodeSha256':digest(node),'sourceArchive':str(find(f'深入·局域网互传-1.0.0-APP+HTML-macOS-{arch}.zip').name)}

# Retain each signed official Mach-O file unchanged; select it with a tiny OS shell wrapper.
wrapper=b'''#!/bin/sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
case "$(/usr/bin/uname -m)" in
  arm64) exec "$base/arm64/node" "$@" ;;
  x86_64) exec "$base/x64/node" "$@" ;;
  *) printf '%s\\n' 'Unsupported Mac architecture' >&2; exit 1 ;;
esac
'''
files[runtime+'node']=wrapper
files[runtime+'PROVENANCE.json']=json.dumps({'selection':'uname -m; original official binaries unchanged','architectures':nodes},ensure_ascii=False,indent=2).encode('utf-8')
info=plistlib.loads(files['Contents/Info.plist'])
assert info['CFBundleShortVersionString']=='1.0.0' and info['LSUIElement']

prefix='深入·局域网互传 Mac/深入·局域网互传.app/'
entries={prefix+k:v for k,v in files.items()}
with zipfile.ZipFile(find('深入·局域网互传-1.0.0-APP+HTML-macOS-arm64.zip')) as z:
    entry=next(n for n in z.namelist() if n.endswith('/深入·局域网互传.html') and '/深入·局域网互传.app/' not in n)
    entries['深入·局域网互传 Mac/深入·局域网互传.html']=z.read(entry)
entries['深入·局域网互传 Mac/使用说明.txt']='''深入·局域网互传 1.0.0 · Mac 版

只有一个“深入·局域网互传.app”，会自动选择苹果芯片或 Intel 对应的运行时，无需手动挑选。
要求 macOS 13.5 或更新版本。完整解压，保留“深入·局域网互传.app”和“深入·局域网互传.html”在同一文件夹，再双击应用。
顶部深入·局域网互传菜单提供“打开深入·局域网互传”和“退出深入·局域网互传”。关闭浏览器后服务仍在后台运行。
同一局域网内先启动者提供服务，后启动者加入；Windows 与 Mac 可以互连，iPhone 使用浏览器进入主机网址。
启动完成后把更新的“深入·局域网互传.html”发给同网朋友。应用目录不可写时，入口保存到 ~/Library/Application Support/Shenru/data。
退出只关闭本机；如果本机是主机，会结束当前空间。

发布状态：这是当前功能的测试构建，未完成真实 Mac 启动、菜单和跨设备网络验收，未做 Developer ID 签名或 Apple 公证。首次打开可能被 macOS 拦截，请遵循系统对可信来源的提示，不关闭系统保护。合并打包不改变这些验证限制。
'''.encode('utf-8') + (ROOT/'docs/content-encryption.txt').read_bytes()
entries['深入·局域网互传 Mac/SHA256SUMS.txt']=(''.join(f'{digest(data)}  {name[len("深入·局域网互传 Mac/"):] }\n' for name,data in sorted(entries.items()))).encode('utf-8')
target=DIST/'深入·局域网互传-Mac.zip'
pending=DIST/'深入·局域网互传-Mac.zip.pending'
with zipfile.ZipFile(pending,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    directories=set()
    for name in entries:
        parts=Path(name).parts
        for i in range(1,len(parts)):directories.add('/'.join(parts[:i])+'/')
    for name in sorted(directories):
        entry=zipfile.ZipInfo(name);entry.create_system=3;entry.external_attr=(stat.S_IFDIR|0o755)<<16|0x10
        z.writestr(entry,b'')
    for name,data in sorted(entries.items()):
        entry=zipfile.ZipInfo(name);entry.create_system=3
        executable=name.startswith(prefix) and name[len(prefix):] in executables
        entry.external_attr=(stat.S_IFREG|(0o755 if executable else 0o644))<<16
        z.writestr(entry,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
with zipfile.ZipFile(pending) as z:
    assert z.testzip() is None
    assert all(z.read(name)==value for name,value in entries.items())
    for name in executables:assert stat.S_IMODE(z.getinfo(prefix+name).external_attr>>16)==0o755
    assert len([n for n in z.namelist() if n.endswith('/Contents/Info.plist')])==1
    for arch in nodes:assert z.read(prefix+runtime+arch+'/node')==mac[arch][runtime+'node']
pending.replace(target)
shutil.copyfile(win,DIST/'深入·局域网互传-Windows.zip')
with zipfile.ZipFile(DIST/'深入·局域网互传-Windows.zip') as z:
    assert z.testzip() is None and set(z.namelist())=={'深入·局域网互传.exe','深入·局域网互传.html','使用说明.txt'}
assert (DIST/'深入·局域网互传-Windows.zip').read_bytes()==win.read_bytes()
report={'version':'1.0.0','macOneApp':True,'macAutoArchitectureSelection':True,'macNativeExecuted':False,'signed':False,'nodes':nodes,'files':[{'name':p.name,'bytes':p.stat().st_size,'sha256':digest(p.read_bytes()),'crc':True} for p in [DIST/'深入·局域网互传-Windows.zip',target]]}
(ROOT/'.qa/final-release-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps(report,ensure_ascii=False))
