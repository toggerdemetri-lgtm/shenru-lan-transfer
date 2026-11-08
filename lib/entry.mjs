import { BRAND_SVG, BRAND_FAVICON } from './brand.mjs';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

// Tunnel adapters can use ordinary private IPv4 ranges too. Prefer a physical
// network before comparing address ranges; keep tunnel URLs as fallbacks.
const VIRTUAL_INTERFACE = /virtual|vmware|vethernet|vpn|docker|proxy|mihomo|clash|sing[-_ ]?tun|wintun|wireguard|tailscale|zerotier|^(?:utun|tun|tap|wg|vmnet|vboxnet)(?:\d+)?(?:$|[\s_.:()\-])/i;
const PRIVATE_IPV4 = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function lanAddresses(port, interfaces = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, list]) => (list || [])
    .filter(n => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.') && !/^198\.(18|19)\./.test(n.address))
    .map(n => ({ name, address: n.address })))
    .sort((a, b) => Number(VIRTUAL_INTERFACE.test(a.name)) - Number(VIRTUAL_INTERFACE.test(b.name)) || Number(PRIVATE_IPV4.test(b.address)) - Number(PRIVATE_IPV4.test(a.address)))
    .map(n => `http://${n.address}:${port}/`);
}

export function normalizeAddress(input) {
  const u = new URL(input);
  if (u.protocol !== 'http:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.hostname !== 'localhost' && isIP(u.hostname) !== 4))
    throw Error('请输入局域网 HTTP 地址，例如 http://192.168.1.8:3000/');
  return u.origin + '/';
}

export function renderEntry(addresses = []) {
  const urls = [...new Set(addresses.map(normalizeAddress))];
  const payload = JSON.stringify(urls).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>深入·局域网互传 · 连接空间</title><link rel="icon" href="${BRAND_FAVICON}" type="image/svg+xml">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:28px;background:#07121f;color:#e9f4ff;font-family:"Segoe UI","Microsoft YaHei",sans-serif;background-image:radial-gradient(ellipse at 10% 0%,#1b496c77,transparent 60%),radial-gradient(ellipse at 100% 100%,#35437877,transparent 55%)}body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:radial-gradient(#cadfff80 1px,transparent 1px);background-size:73px 81px;opacity:.23}.panel{position:relative;width:min(100%,510px);padding:42px;border:1px solid #d4e9ff29;border-radius:32px;background:linear-gradient(130deg,#d5e8ff13,#101f3266);box-shadow:0 32px 100px #0005,inset 0 1px #ffffff12;backdrop-filter:blur(28px)}.brand{font-size:14px;letter-spacing:4px;color:#a6c8e9}.orb{width:48px;height:48px;border-radius:17px;margin:28px 0;background:radial-gradient(circle at 30% 20%,#def5ff,#70b4e388 45%,#395a9c44);box-shadow:inset 0 0 0 1px #d5efff55,0 8px 40px #69aee51c;display:grid;place-items:center;font-size:27px}.orb>svg{width:42px;height:42px;display:block}h1{font-size:32px;letter-spacing:-1px;font-weight:500;margin:0 0 14px}p{color:#9fb4c9;font-size:14px;line-height:1.9;margin:0 0 24px}label{display:block;font-size:12px;color:#aabfd3;margin:0 0 10px}input{width:100%;border:1px solid #c5e2ff26;background:#04101f66;border-radius:14px;padding:15px;color:#d8ebfa;font-size:14px;outline:none}input:focus{border-color:#aacfe7}button{border:0;border-radius:14px;padding:15px 20px;background:#d7eafb;color:#16354b;cursor:pointer;font:500 15px "Segoe UI","Microsoft YaHei",sans-serif;width:100%;margin-top:12px}button:hover{background:#eaf5ff}button:focus-visible,a:focus-visible{outline:2px solid #acd8ff;outline-offset:4px}.note{font-size:12px;color:#8ea6be;margin-top:24px;line-height:1.8}.error{color:#ffb5b5;min-height:18px;margin:10px 0 0;font-size:12px}.alternatives{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.alternatives button{width:auto;background:#d5e7ff0d;border:1px solid #c5e2ff20;color:#bed3e6;font-size:11px;padding:6px 10px;margin:0}footer{border-top:1px solid #b5d8ff1a;margin-top:28px;padding-top:20px;font-size:11px;color:#7e98b2;display:flex;justify-content:space-between}@media(max-width:480px){body{padding:18px}.panel{padding:28px;border-radius:26px}h1{font-size:28px}footer{gap:12px;flex-wrap:wrap}}
</style></head><body><main class="panel"><div class="brand">深入·局域网互传</div><div class="orb" aria-hidden="true">${BRAND_SVG}</div><h1>在同一个空间相遇。</h1><p>聊天、原图与大文件，近在身边。<br>连接主机，继续你的分享。</p><form id="connect"><label for="address">空间地址</label><input id="address" type="url" required spellcheck="false" placeholder="http://192.168.1.8:3000/" aria-describedby="error"><div id="alternatives" class="alternatives"></div><button type="submit">进入深入·局域网互传 <span aria-hidden="true">↗</span></button><div class="error" id="error" role="alert"></div></form><div class="note" id="note"></div><footer><span>同一局域网 · 原文件传输</span><span>保持主机运行</span></footer></main>
<script>
const addresses=${payload};
const input=document.getElementById('address');input.value=addresses[0]||'';
document.getElementById('note').textContent=!addresses.length?'请先启动深入·局域网互传应用（Windows EXE 或 macOS APP），它会更新这份 HTML；再把更新后的文件发给朋友。':addresses.every(a=>/http:\\/\\/(localhost|127\\.)/.test(a))?'当前服务仅允许本机访问，朋友无法连接。请关闭旧服务后重新打开深入·局域网互传应用，获取局域网入口。':'打不开时，请确认主机仍在运行，双方连接同一个 Wi-Fi。更换网络后，请向主机索取最新入口。';
for(const value of addresses.slice(1)){const b=document.createElement('button');b.type='button';b.textContent=value;b.addEventListener('click',()=>{input.value=value;});document.getElementById('alternatives').append(b);}
document.getElementById('connect').addEventListener('submit',e=>{e.preventDefault();try{let value=input.value.trim();if(!value.includes('://'))value='http://'+value;const u=new URL(value);if(u.protocol!=='http:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.hostname==='localhost'||/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(u.hostname)))throw Error();location.assign(u.origin+'/');}catch{document.getElementById('error').textContent='请输入有效的局域网地址，例如 http://192.168.1.8:3000/';}});
</script></body></html>`;
}
