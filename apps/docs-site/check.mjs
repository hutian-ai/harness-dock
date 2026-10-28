import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'dist');
const files=[];
async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,item.name);if(item.isDirectory())await walk(path);else files.push(path);}}
await walk(root);
const errors=[];
let links=0;
for(const file of files.filter(f=>extname(f)==='.html'&&!f.endsWith('/404.html'))){const html=await readFile(file,'utf8');if(/\{\{[A-Z_]+\}\}|%BASE%/.test(html))errors.push('Unresolved template: '+file);if(!html.includes('<title>'))errors.push('Missing title: '+file);const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);if(new Set(ids).size!==ids.length)errors.push('Duplicate IDs: '+file);for(const [,attr,raw] of html.matchAll(/\b(href|src)="([^"]+)"/g)){if(/^(?:https?:|data:|mailto:|javascript:)/.test(raw))continue;links++;const [path,hash]=raw.split('#');let target=resolve(dirname(file),path||'.');if(!path)target=file;try{if((await stat(target)).isDirectory())target=resolve(target,'index.html');await stat(target);if(hash&&extname(target)==='.html'){const targetHtml=target===file?html:await readFile(target,'utf8');if(!targetHtml.includes('id="'+hash+'"'))errors.push('Missing anchor '+raw+' in '+file);}}catch{errors.push('Broken '+attr+' '+raw+' in '+file);}}}
const index=JSON.parse(await readFile(resolve(root,'search-index.json'),'utf8'));
const sourcePages=JSON.parse(await readFile(resolve(root,'../src/content.json'),'utf8'));
if(index.length!==sourcePages.length)errors.push('Unexpected page count: '+index.length);
if(index.some(p=>!p.text||!p.title))errors.push('Empty search record');
const all=await Promise.all(files.filter(f=>/\.(html|js|json)$/.test(f)).map(f=>readFile(f,'utf8')));
if(all.some(text=>/\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|BEGIN (RSA |OPENSSH )?PRIVATE KEY/.test(text)))errors.push('Private material found in static output');
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log('Checked '+index.length+' pages, '+links+' local links/assets, anchors, templates, search index and private-path guard.');
