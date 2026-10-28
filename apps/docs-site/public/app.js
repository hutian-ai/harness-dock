(function () {
  'use strict';
  var root=document.documentElement, base=document.body.dataset.base || './';
  var menu=document.querySelector('.menu-toggle'), scrim=document.querySelector('.sidebar-scrim'), sidebar=document.querySelector('.sidebar'), mobile=matchMedia('(max-width:760px)');
  function syncSidebar(){sidebar.inert=mobile.matches&&!root.classList.contains('menu-open');}
  mobile.addEventListener('change',syncSidebar);syncSidebar();
  function closeMenu(){root.classList.remove('menu-open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','打开导航');syncSidebar();}
  menu.addEventListener('click',function(){var open=root.classList.toggle('menu-open');menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'关闭导航':'打开导航');syncSidebar();});
  scrim.addEventListener('click',closeMenu);
  var themeButton=document.querySelector('.theme-toggle');
  function applyTheme(theme){
    root.dataset.theme=theme;
    var label=theme==='dark'?'切换到浅色主题':'切换到深色主题';
    themeButton.setAttribute('aria-label',label);
    themeButton.setAttribute('title',label);
    document.querySelector('meta[name="theme-color"]').content=theme==='dark'?'#09090b':'#ffffff';
  }
  applyTheme(root.dataset.theme==='light'?'light':'dark');
  themeButton.addEventListener('click',function(){var theme=root.dataset.theme==='dark'?'light':'dark';applyTheme(theme);try{localStorage.setItem('dock-theme',theme);}catch(e){}});
  var toast=document.querySelector('.toast'),timer;
  function notify(text){toast.textContent=text;toast.classList.add('visible');clearTimeout(timer);timer=setTimeout(function(){toast.classList.remove('visible');},1800);}
  document.querySelectorAll('.copy-code').forEach(function(button){button.addEventListener('click',async function(){var value=button.closest('.code-block').querySelector('code').textContent;try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);}else{var area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();var ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('copy');}button.textContent='已复制';notify('代码已复制');setTimeout(function(){button.textContent='复制';},1800);}catch(e){notify('复制未成功，请选择代码手动复制');}});});
  var dialog=document.querySelector('.search-dialog'), input=document.getElementById('search-input'),results=document.getElementById('search-results'), indexPromise, current=-1;
  function escape(text){var span=document.createElement('span');span.textContent=text;return span.innerHTML;}
  function getIndex(){if(!indexPromise)indexPromise=fetch(base+'search-index.json').then(function(r){if(!r.ok)throw new Error('index');return r.json();}).catch(function(e){indexPromise=null;throw e;});return indexPromise;}
  function select(n){var links=results.querySelectorAll('a');if(!links.length)return;current=(n+links.length)%links.length;links.forEach(function(link,i){link.classList.toggle('focused',i===current);});links[current].scrollIntoView({block:'nearest'});}
  var querySequence=0;
  async function search(){var seq=++querySequence;current=-1;var q=input.value.trim().toLowerCase();try{var entries=await getIndex();if(seq!==querySequence)return;var terms=q.split(/\s+/).filter(Boolean);var hits=entries.map(function(p){var title=p.title.toLowerCase(),content=(p.description+' '+p.text).toLowerCase();var matched=terms.every(function(term){return title.includes(term)||content.includes(term);});var score=terms.reduce(function(total,term){return total+(title.includes(term)?10:0)+(p.description.toLowerCase().includes(term)?4:0);},0);return {page:p,score:matched?score+1:0};}).filter(function(hit){return hit.score>0;}).sort(function(a,b){return b.score-a.score;});if(!q)hits=entries.filter(function(p){return ['quickstart','installation','sdk','troubleshooting'].includes(p.slug);}).map(function(p){return {page:p};});results.innerHTML='<div class="results-label">'+(q?'找到 '+hits.length+' 篇文档':'常用文档')+'</div>'+(hits.length?hits.map(function(hit){var p=hit.page;var summary=p.description;if(q){var pos=p.text.toLowerCase().indexOf(terms[0]);if(pos>=0)summary=(pos>24?'…':'')+p.text.slice(Math.max(0,pos-24),pos+110)+'…';}return '<a class="search-result" href="'+base+(p.slug?p.slug+'/':'')+'"><div><strong>'+escape(p.title)+'</strong><p>'+escape(summary)+'</p></div><span aria-hidden="true">↗</span></a>';}).join(''):'<div class="empty-search">没有匹配结果，试试“安装”“审批”或“unknown”。</div>');}catch(e){results.innerHTML='<div class="empty-search">搜索索引暂时不可用。请通过 HTTP 预览或部署后使用。</div>';}}
  function openSearch(){closeMenu();dialog.showModal();search();input.focus();}
  document.querySelector('.search-trigger').addEventListener('click',openSearch);
  document.querySelector('.close-search').addEventListener('click',function(){dialog.close();});
  dialog.addEventListener('click',function(e){if(e.target===dialog){var r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  input.addEventListener('input',search);
  input.addEventListener('keydown',function(e){if(e.key==='ArrowDown'){e.preventDefault();select(current+1);}else if(e.key==='ArrowUp'){e.preventDefault();select(current-1);}else if(e.key==='Enter'){var links=results.querySelectorAll('a');var hit=links[current<0?0:current];if(hit){e.preventDefault();hit.click();}}});
  document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(dialog.open)dialog.close();else openSearch();}if(e.key==='Escape')closeMenu();});
  if('IntersectionObserver' in window){var headings=document.querySelectorAll('article h2[id]'),links=document.querySelectorAll('.page-toc a');var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){links.forEach(function(link){link.classList.toggle('active',link.hash==='#'+entry.target.id);});}});},{rootMargin:'-80px 0px -65% 0px'});headings.forEach(function(h){observer.observe(h);});}
})();
