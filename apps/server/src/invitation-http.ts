import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from './config.ts';
import { redeemDeviceInvitation } from './invitations.ts';

const script = `const open=document.getElementById('open'),copy=document.getElementById('copy'),status=document.getElementById('status');
document.getElementById('server').textContent=location.host;
if(/^#[A-Za-z0-9_-]{100,2048}$/.test(location.hash)){
 open.href='harness-dock://connect?invite='+encodeURIComponent(location.href);
 open.addEventListener('click',()=>{status.textContent='请在客户端确认服务器并点击“连接这台 Mac”。如果没有打开，可复制链接后粘贴到客户端。';});
 copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);status.textContent='邀请链接已复制。在客户端选择“粘贴邀请链接”。';}catch{status.textContent='请复制浏览器地址栏中的完整链接，粘贴到客户端。';}});
}else{open.removeAttribute('href');copy.disabled=true;status.textContent='邀请链接不完整，请向服务管理员重新领取。';}`;
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接到 Harness Dock</title>
<style>:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:light-dark(#f6f7f6,#151817);color:light-dark(#17221d,#edf3ef)}main{max-width:420px;margin:28px;padding:36px;border:1px solid #81908740;border-radius:20px;background:light-dark(white,#202622)}small{color:#6e8f7d}h1{font-size:28px;letter-spacing:-.7px}p{line-height:1.7;font-size:14px}#server{font-size:18px;font-weight:600;overflow-wrap:anywhere}.actions{display:grid;gap:12px;margin:28px 0}a,button{font:inherit;cursor:pointer;text-align:center;padding:13px 18px;border-radius:9px;text-decoration:none}a{background:#21855b;color:white;font-weight:600}a:not([href]){opacity:.4;pointer-events:none}button{background:transparent;border:1px solid #81908770;color:inherit}#status{min-height:70px;color:light-dark(#496052,#afc4b7)}footer a.help{display:inline-block;background:transparent;color:inherit;padding:8px 0;text-align:left;font-size:12px;text-decoration:underline}footer{font-size:12px;line-height:1.7;color:#7b9286}</style>
<main><small>Harness Dock · 设备邀请</small><h1>连接这台 Mac</h1><p>接入服务</p><div id="server"></div><p>在 Harness Dock 中核对服务器并确认连接。该服务获授权的应用可使用这台 Mac 上已配置的原生 Harness；任务在这台 Mac 执行，进度、原生审批和结果回到调用方应用。</p><div class="actions"><a id="open">在 Harness Dock 中打开</a><button id="copy">复制邀请链接</button></div><p id="status">邀请仅在你确认连接后领取。打开此网页不会连接设备，也不会调用模型。</p><footer>还没安装？<a class="help" href="https://github.com/hutian-ai/harness-dock/releases/download/v0.1.2/harness-dock-panel-0.1.2-darwin-arm64.zip" rel="noreferrer">下载 macOS 客户端 v0.1.2</a>，解压并放入“应用程序”，安装后回到此页打开原邀请。<br>公开客户端适用于 macOS 13+、Apple 芯片，包含 Codex 支持与 dsh 实验适配；实际执行前另行安装并登录所选 Harness。Alpha 尚未完成 Apple 公证。<br><a class="help" href="https://hutian-ai.github.io/harness-dock/app/" target="_blank" rel="noreferrer">安装与使用指南</a><br>连接后回到提供邀请的应用发起任务；本机回显仅供按需核验。邀请有时效且仅可领取一次；安装期间过期请向服务管理员领取新链接，已有设备继续使用原身份。</footer></main><script>${script}</script></html>`;

export function serveInvitation(request: IncomingMessage, response: ServerResponse, config: ServerConfig, stateDir?: string): boolean {
  if (request.url !== '/connect' && request.url !== '/invitations/redeem') return false;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  if (request.method === 'GET' && request.url === '/connect') {
    const hash = createHash('sha256').update(script).digest('base64');
    response.setHeader('content-security-policy', `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  } else if (request.method === 'POST' && request.url === '/invitations/redeem') {
    response.setHeader('content-type', 'application/json');
    if (!stateDir) { response.writeHead(503).end('{"error":"invitation_storage_unavailable"}'); return true; }
    if (request.headers.origin || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return true; }
    request.setTimeout(10_000, () => request.destroy());
    void (async () => {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) { response.writeHead(413).end(); return; }
      }
      let code: string;
      try {
        const value = JSON.parse(body);
        if (!value || Object.keys(value).join() !== 'invitation' || typeof value.invitation !== 'string') throw new Error();
        code = value.invitation;
      } catch { response.writeHead(400).end('{"error":"invalid_invitation"}'); return; }
      try {
        const pairing = await redeemDeviceInvitation(code, config, stateDir);
        response.writeHead(200).end(JSON.stringify(pairing));
      } catch (error) {
        const unavailable = error instanceof Error && error.message === 'invitation_unavailable';
        response.writeHead(unavailable ? 410 : 503).end(JSON.stringify({ error: unavailable ? 'invitation_unavailable' : 'invitation_storage_unavailable' }));
      }
    })().catch(() => { if (!response.headersSent) response.writeHead(400).end(); else response.destroy(); });
  } else response.writeHead(405, { allow: request.url === '/connect' ? 'GET' : 'POST' }).end();
  return true;
}
