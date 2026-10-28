import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const pages = JSON.parse(await readFile(join(root, 'src/content.json'), 'utf8'));
const shell = await readFile(join(root, 'src/shell.html'), 'utf8');
const out = join(root, 'dist');
const esc = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const groups = ['认识产品', '开始使用', '应用集成', '运行维护','开发与贡献'];
const order = ['', 'overview', 'support', 'quickstart', 'installation', 'server', 'usage', 'sdk', 'lifecycle', 'pairing', 'troubleshooting', 'deploy-docs','architecture','drivers','verification','distribution'];
const iconPaths={
'':'M4 10 12 3l8 7v10H4V10Zm5 10v-7h6v7',
overview:'M12 8v1m0 3v5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
support:'m5 12 4 4L19 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
quickstart:'m9 4 12 8-12 8V4ZM3 5v14',
installation:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
server:'M3 3h18v7H3V3Zm0 11h18v7H3v-7M7 6h1M7 17h1',
usage:'M4 5h16v14H4V5Zm4 4 3 3-3 3m5 0h3',
sdk:'m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
lifecycle:'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6M12 7v5l3 2',
pairing:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
troubleshooting:'M12 17v.01M9 9a3 3 0 1 1 6 0c0 2-3 2-3 5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
'deploy-docs':'M3 4h18v14H3V4Zm5 18h8m-4-4v4M3 8h18'
};
const navIcon=slug=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(iconPaths[slug]??iconPaths.sdk)+'"/></svg>';
const sorted = order.map(slug => pages.find(page => page.slug === slug));
if (sorted.length !== pages.length || sorted.some(page => !page) || new Set(pages.map(p=>p.slug)).size !== pages.length) throw new Error('Invalid documentation navigation');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'public'), out, { recursive: true });
for (const [index, page] of sorted.entries()) {
  const base = page.slug ? '../' : './';
  const href = slug => base + (slug ? slug + '/' : '');
  const nav = groups.map(group => '<div class="nav-group"><div class="nav-heading">'+group+'</div>'+sorted.filter(p=>p.group===group).map(p=>'<a class="nav-link'+(p.slug===page.slug?' selected':'')+'" '+(p.slug===page.slug?'aria-current="page" ':'')+'href="'+href(p.slug)+'">'+navIcon(p.slug)+'<span>'+esc(p.label)+'</span></a>').join('')+'</div>').join('');
  let body = page.body.replaceAll('%BASE%', base);
  const headings = [...body.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(m=>({id:m[1],text:m[2].replace(/<[^>]+>/g,' ')}));
  if(new Set(headings.map(h=>h.id)).size!==headings.length) throw new Error('Duplicate heading IDs: '+page.slug);
  body = body.replace(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g, (_,id,title)=>'<h2 id="'+id+'">'+title+'<a class="heading-anchor" href="#'+id+'" aria-label="链接到此节">#</a></h2>');
  const toc = page.slug ? '<aside class="page-toc"><div>本页内容</div><nav aria-label="本页目录">'+headings.map(h=>'<a href="#'+h.id+'">'+esc(h.text)+'</a>').join('')+'</nav><div class="toc-note">Developer Alpha<br><span>以实际候选包为准</span></div></aside>' : '';
  const pageHeader = page.slug ? '<header class="article-header"><div class="breadcrumb">文档 <span>/</span> '+page.group+'</div><h1>'+esc(page.title)+'</h1><p>'+esc(page.description)+'</p></header>' : '';
  const prev=sorted[index-1], next=sorted[index+1];
  const pagination = page.slug ? '<nav class="pagination" aria-label="翻页">'+(prev?'<a href="'+href(prev.slug)+'"><span>← 上一篇</span><strong>'+esc(prev.label)+'</strong></a>':'<div></div>')+(next?'<a class="next" href="'+href(next.slug)+'"><span>下一篇 →</span><strong>'+esc(next.label)+'</strong></a>':'')+'</nav>':'';
  const values = {TITLE:page.slug ? page.title+' | harness-dock 文档' : 'harness-dock · 原生 Harness，统一接入',DESCRIPTION:esc(page.description),BASE:base,SLUG:page.slug,NAV:nav,BODY:body,TOC:toc,PAGE_HEADER:pageHeader,PAGINATION:pagination,LAYOUT:page.slug?'article-layout':'home-layout',BODY_CLASS:page.slug?'is-docs':'is-home',TAB_DEV:page.group==='开发与贡献'?'active':'',TAB_INTRO:page.group==='认识产品'?'active':'',TAB_START:['quickstart','installation','usage'].includes(page.slug)?'active':'',TAB_SDK:page.group==='应用集成'?'active':'',TAB_OPS:['server','pairing','troubleshooting','deploy-docs'].includes(page.slug)?'active':''};
  const html = shell.replace(/\{\{([A-Z_]+)\}\}/g, (_,key) => {if(!(key in values)) throw new Error('Unknown template field '+key);return values[key];});
  const dir=page.slug?join(out,page.slug):out;
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'index.html'),html);
}
const plain = html => html.replace(/<[^>]*>/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
await writeFile(join(out,'.nojekyll'),'');
await writeFile(join(out,'search-index.json'),JSON.stringify(sorted.map(p=>({title:p.label,slug:p.slug,description:p.description,text:plain(p.body)}))));
await writeFile(join(out,'404.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>404 · harness-dock</title><body style="font:18px/1.8 system-ui;max-width:600px;margin:15vh auto;padding:30px"><h1>404</h1><p>这个文档页面不存在，请使用浏览器后退，或从站点首页重新进入。</p></body></html>');
console.log('Built '+sorted.length+' pages → dist/ (zero runtime dependencies)');
