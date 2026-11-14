// 吾爱Nova浏览器 · 移动版阅读模式（正文提取）。
// 这是一段「自调用」脚本：每次注入即执行一次切换 ——
//   · 当前未在阅读模式 → 提取正文、铺全屏阅读层、返回 on~1~标题~字数~~
//   · 当前已在阅读模式 → 撤掉阅读层、返回 off~1~~~~
//   · 提取不到正文 / 出错 → 返回 none~0~~~原因
// 状态串用 ~ 分隔（见 Reader.java 的 parseStatus），文本里的 ~ 在拼串前先换成 /。
(function(){
  try {
    if (window.__novaReaderOn) { window.__novaReaderOff(); return 'off~1~~~~'; }

    // 正文打分：字数越多越好，链接越多、链接密度越高越像导航/列表。
    function scoreNode(n){
      if(!n) return 0;
      var t = n.innerText || '';
      var words = t.trim().split(/\s+/).length;
      var as = n.getElementsByTagName('a');
      var linkLen = 0;
      for (var i=0;i<as.length;i++) linkLen += (as[i].innerText||'').length;
      var density = t.length ? linkLen/t.length : 0;
      return words - as.length*2 - density*12;
    }

    var cands = [];
    var arts = document.getElementsByTagName('article');
    for (var i=0;i<arts.length;i++) cands.push(arts[i]);
    var divs = document.getElementsByTagName('div');
    for (var j=0;j<divs.length;j++){ if (divs[j].getElementsByTagName('p').length>=3) cands.push(divs[j]); }
    var best=null, bs=-1e9;
    for (var k=0;k<cands.length;k++){ var s=scoreNode(cands[k]); if(s>bs){bs=s;best=cands[k];} }
    if(!best) return 'none~0~~~no-content';

    var h1 = document.querySelector('h1');
    var title = (document.title||(h1?h1.innerText:'')||'').trim();
    var node = best.cloneNode(true);
    var bad = node.querySelectorAll('script,style,iframe,noscript,ins,button,form,nav,header,footer,aside');
    for (var b=0;b<bad.length;b++){ if(bad[b].parentNode) bad[b].parentNode.removeChild(bad[b]); }

    var root = document.createElement('div');
    root.id = 'nova-reader-root';
    root.innerHTML = '<style id="nova-reader-style">'
      + '#nova-reader-root{position:fixed;inset:0;z-index:2147483647;background:#f7f5f0;color:#222;overflow:auto;-webkit-overflow-scrolling:touch;font-family:-apple-system,Segoe UI,Roboto,sans-serif;}'
      + '#nova-reader-root *{box-sizing:border-box;}'
      + '.nr-bar{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(247,245,240,0.96);border-bottom:1px solid #e3ded3;z-index:2;}'
      + '.nr-name{font-weight:600;opacity:0.65;font-size:14px;}'
      + '.nr-actions button{margin-left:8px;border:1px solid #d8d2c4;background:#fff;color:#333;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:14px;}'
      + '.nr-actions button:active{background:#efece4;}'
      + '.nr-wrap{max-width:720px;margin:0 auto;padding:18px 16px 90px;}'
      + '.nr-content{font-size:18px;line-height:1.85;}'
      + '.nr-content h1{font-size:25px;line-height:1.3;margin:0 0 14px;}'
      + '.nr-content img{max-width:100%;height:auto;display:block;margin:18px auto;border-radius:6px;}'
      + '.nr-content p{margin:0 0 16px;}'
      + '.nr-content a{color:#1a6fc4;}'
      + '.nr-content pre{background:#efece4;padding:12px;border-radius:6px;overflow:auto;}'
      + '.nr-content code{font-family:Consolas,monospace;font-size:0.92em;}'
      + '#nova-reader-root.nr-serif .nr-content{font-family:Georgia,"Times New Roman",serif;line-height:1.95;}'
      + '</style>'
      + '<div class="nr-bar"><span class="nr-name">阅读模式</span><div class="nr-actions">'
      + '<button data-nr="dec" title="缩小字号">A-</button>'
      + '<button data-nr="inc" title="放大字号">A+</button>'
      + '<button data-nr="serif" title="衬线 / 无衬线">衬线</button>'
      + '<button data-nr="close" title="退出阅读模式">退出</button>'
      + '</div></div>'
      + '<div class="nr-wrap"><div class="nr-content" id="nova-reader-content">'
      + (title?('<h1>'+title.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</h1>'):'')
      + node.innerHTML
      + '</div></div>';
    document.body.appendChild(root);

    var content = document.getElementById('nova-reader-content');
    var sz = 18;
    root.addEventListener('click', function(e){
      var el = e.target;
      var b = (el && el.closest) ? el.closest('[data-nr]') : null;
      if(!b) return;
      var act = b.getAttribute('data-nr');
      if(act==='close'){ window.__novaReaderOff(); }
      else if(act==='inc'){ sz += 2; content.style.fontSize = sz+'px'; }
      else if(act==='dec'){ sz = Math.max(14, sz-2); content.style.fontSize = sz+'px'; }
      else if(act==='serif'){ root.classList.toggle('nr-serif'); }
    });

    window.__novaReaderOn = true;
    window.__novaReaderOff = function(){
      var r = document.getElementById('nova-reader-root');
      if(r && r.parentNode) r.parentNode.removeChild(r);
      window.__novaReaderOn = false;
    };
    window.scrollTo(0,0);

    var safeTitle = title.replace(/~/g,'/').replace(/[\r\n]+/g,' ');
    return 'on~1~' + safeTitle + '~' + (best.innerText||'').length + '~~';
  } catch(err){ return 'none~0~~~' + String((err&&err.message)||err).replace(/~/g,'/'); }
})()
