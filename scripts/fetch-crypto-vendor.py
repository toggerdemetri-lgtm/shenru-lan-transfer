"""Fetch pinned upstream releases, verify npm SHA512, vendor browser ESM only."""
from pathlib import Path, PurePosixPath
import urllib.request, hashlib, base64, tarfile, io, json, posixpath, re
ROOT = Path(__file__).resolve().parents[1]
PACKAGES = {
 'ciphers': 'AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw==',
 'curves': 'P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew=='
}
records=[]
for name, expected in PACKAGES.items():
 url=f'https://registry.npmjs.org/@noble/{name}/-/{name}-2.4.0.tgz'
 raw=urllib.request.urlopen(url,timeout=45).read()
 assert base64.b64encode(hashlib.sha512(raw).digest()).decode()==expected, 'release SHA512 mismatch'
 target=ROOT/'public'/'vendor'/f'noble-{name}'
 files={}
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
  for item in archive.getmembers():
   path=PurePosixPath(item.name)
   if not item.isfile() or path.parts[0]!='package' or '..' in path.parts: continue
   relative=PurePosixPath(*path.parts[1:])
   if not (str(relative).endswith('.js') or str(relative) in ['LICENSE','package.json']): continue
   content=archive.extractfile(item).read()
   if str(relative).endswith('.js'):
    prefix=posixpath.relpath('../noble-hashes',str(relative.parent))
    if not prefix.startswith('.'): prefix='./'+prefix
    content=re.sub(r'([\'\"])@noble/hashes/([^\'\"]+)\1',lambda m:m[1]+prefix+'/'+m[2]+m[1],content.decode()).encode()
   dest=target/str(relative); dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(content)
   files[str(relative)]=hashlib.sha256(content).hexdigest()
 records.append({'name':f'@noble/{name}','version':'2.4.0','url':url,'integrity':'sha512-'+expected,'transformation':'relative browser imports to existing noble-hashes 2.4.0','files':files})
 print(f'vendored @noble/{name} 2.4.0: {len(files)} files')
(ROOT/'public'/'vendor'/'content-crypto-lock.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf8')
