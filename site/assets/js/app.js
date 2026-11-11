/*
 * 吾爱Nova浏览器 · 官网前端逻辑
 *
 * 这里只做一件事：读 version.json，把最新版本信息渲染到页面上。
 *
 * <p>为什么不把版本号写死在 HTML 里：那会让「发新版」变成两处改动
 * （构建产物 + 官网文案），而这两处迟早会忘同步一处 ——
 * 于是官网写着 1.1.0、实际下载到的是 1.0.0。
 * 版本号只有一个来源，就是 version.json，App 端和官网都从它读。
 */
(function () {
    'use strict';

    var VERSION_URL = 'version.json';

    // 下载次数接口（Edge Function + KV）。未部署 / KV 未绑定时请求会失败，
    // 这里静默隐藏数字 —— 下载链接本身永远不受影响。
    var STATS_URL = '/api/dl-stats';
    var statCounts = null;

    function $(id) {
        return document.getElementById(id);
    }

    function human(bytes) {
        if (typeof bytes !== 'number' || bytes < 0) return '未知';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    /**
     * 把相对地址补全成绝对地址。
     *
     * <p>清单里的官网直链故意写成相对路径（{@code download/xxx.apk}）：
     * 这样换域名时清单文件一个字都不用改，由使用方自己拼基座地址。
     */
    function absolute(url) {
        if (!url) return url;
        if (/^https?:\/\//i.test(url)) return url;
        return new URL(url, location.href).href;
    }

    function render(data) {
        // 顶部 Hero
        var latest = $('verLatest');
        var date = $('verDate');
        if (latest) latest.textContent = '最新版本 ' + data.version
            + '（' + data.versionCode + '）';
        if (date) date.textContent = data.updatedAt
            ? '更新于 ' + data.updatedAt : '';

        // 下载区
        var ver = $('dlVer');
        var stamp = $('dlStamp');
        if (ver) ver.textContent = 'v' + data.version;
        if (stamp) stamp.textContent = data.updatedAt
            ? '更新于 ' + data.updatedAt : '';

        var note = $('dlNote');
        if (note) note.textContent = '安装包大小约 ' + human(pickSize(data))
            + '。安装前请在系统设置中允许来自此来源的应用。';

        var box = $('dlBtns');
        if (box) {
            box.innerHTML = '';
            (data.downloads || []).forEach(function (d) {
                var a = document.createElement('a');
                a.className = 'btn btn-primary';
                a.href = absolute(d.url);
                a.textContent = d.label + ' · ' + human(d.size);
                a.setAttribute('download', '');
                a.setAttribute('data-dl', 'android');
                box.appendChild(a);
            });
        }

        var facts = $('dlFacts');
        if (facts) {
            facts.hidden = false;
            facts.innerHTML = '';
            addFact(facts, '版本', data.version);
            addFact(facts, '版本码', String(data.versionCode));
            addFact(facts, '更新日期', data.updatedAt || '未知');
        }
    }

    function pickSize(data) {
        var list = data.downloads || [];
        return list.length > 0 ? list[0].size : -1;
    }

    function addFact(ul, k, v) {
        var li = document.createElement('li');
        var a = document.createElement('span');
        a.textContent = k;
        var b = document.createElement('span');
        b.textContent = v;
        li.appendChild(a);
        li.appendChild(b);
        ul.appendChild(li);
    }

    function fallback(err) {
        var note = $('dlNote');
        if (note) {
            note.textContent = '版本信息暂时读取不到，可直接从 Gitee Releases 下载。';
        }
        var box = $('dlBtns');
        if (box) {
            var a = document.createElement('a');
            a.className = 'btn btn-primary';
            a.href = 'https://gitee.com/jinghe-net/i-adore-the-nova-browser/releases';
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = '前往 Gitee Releases';
            a.setAttribute('data-dl', 'android');
            box.appendChild(a);
        }
        if (window.console) console.warn('[Nova] version.json 读取失败：', err);
    }

    /* ---------- 下载次数（/api/dl-stats） ---------- */

    function fmtCount(n) {
        return '已下载 ' + Number(n).toLocaleString('zh-CN') + ' 次';
    }

    function showCounts(counts) {
        if (!counts) return;
        // 0 次不展示（刚上线就写「已下载 0 次」是减分项），有真实下载量了再显示
        if (typeof counts.android === 'number' && counts.android > 0) {
            var a = $('dlCountAndroid');
            if (a) { a.textContent = fmtCount(counts.android); a.hidden = false; }
        }
        if (typeof counts.pc === 'number' && counts.pc > 0) {
            var p = $('dlCountPc');
            if (p) { p.textContent = fmtCount(counts.pc); p.hidden = false; }
        }
    }

    /*
     * KV 是最终一致（全球同步最长 60 秒）：刚 +1 再读可能还是旧值。
     * 这里只取较大者，避免数字往回跳。
     */
    function mergeCounts(incoming) {
        if (!incoming) return statCounts;
        if (!statCounts) statCounts = { android: 0, pc: 0 };
        ['android', 'pc'].forEach(function (k) {
            if (typeof incoming[k] === 'number') {
                statCounts[k] = Math.max(statCounts[k] || 0, incoming[k]);
            }
        });
        return statCounts;
    }

    function loadStats() {
        if (!window.fetch) return;
        fetch(STATS_URL, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j && j.counts) showCounts(mergeCounts(j.counts)); })
            .catch(function () { /* 后端未启用：不显示即可 */ });
    }

    function bump(channel) {
        if (!window.fetch || !channel) return;
        // 只有确认后端可用（GET 成功过）才做本地 +1，否则会凭空显示一个假数字
        if (statCounts && typeof statCounts[channel] === 'number') {
            var optimistic = { android: statCounts.android, pc: statCounts.pc };
            optimistic[channel] = statCounts[channel] + 1;
            statCounts[channel] = optimistic[channel];
            showCounts(optimistic);
        }
        try {
            fetch(STATS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: channel }),
                keepalive: true
            }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (j) { if (j && j.counts) showCounts(mergeCounts(j.counts)); })
              .catch(function () {});
        } catch (e) { /* 忽略 */ }
    }

    /* ---------- 下载区排序：手机访问手机版靠前，电脑访问 PC 版靠前 ---------- */

    function isMobileVisit() {
        var ua = navigator.userAgent || '';
        if (/Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(ua)) return true;
        if (window.matchMedia) return window.matchMedia('(max-width: 820px)').matches;
        return (window.innerWidth || 0) <= 820;
    }

    function orderPlatforms() {
        var sec = $('download');
        if (!sec) return;
        var wrap = sec.querySelector('.wrap');
        var a = sec.querySelector('.dl-plat[data-plat="android"]');
        var p = sec.querySelector('.dl-plat[data-plat="pc"]');
        if (!wrap || !a || !p) return;

        var kids = Array.prototype.slice.call(wrap.children);
        var ia = kids.indexOf(a);
        var ip = kids.indexOf(p);
        if (ia < 0 || ip < 0) return;

        var mobileFirst = isMobileVisit();
        if (mobileFirst && ia > ip) wrap.insertBefore(a, p);
        if (!mobileFirst && ip > ia) wrap.insertBefore(p, a);
    }

    /* ---------- 插件商店（extensions.json） ----------
       目录与卡片都不写死在 HTML 里：官网和 PC 端「设置 → 扩展 → 官网插件商店」
       读的是同一份 extensions.json，上架 / 下架只改那一个文件。
       网页没有操作本地扩展的权限，所以这里只做展示与「复制安装地址」，
       真正的安装动作由浏览器端完成。 */

    var EXT_URL = 'extensions.json';
    var extItems = [];
    var extFilter = '全部';

    function extText(v, fallback) {
        return (typeof v === 'string' && v.trim()) ? v.trim() : (fallback || '');
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    /** 只收能装的条目（必须有安装地址）；字段一律兜底，清单写错也不至于整页空掉。 */
    function normalizeExt(data) {
        if (!data || !Array.isArray(data.items)) throw new Error('清单格式不对');
        return data.items.filter(function (it) {
            return it && typeof it.id === 'string'
                && (typeof it.installUrl === 'string' || typeof it.packageUrl === 'string');
        }).slice(0, 60).map(function (it) {
            return {
                id: extText(it.id),
                name: extText(it.name, '未命名扩展'),
                developer: extText(it.developer, '未知开发者'),
                category: extText(it.category, '其它'),
                mark: extText(it.mark, 'E').slice(0, 2),
                accent: /^#[0-9a-fA-F]{6}$/.test(it.accent || '') ? it.accent : '#3D6BFF',
                description: extText(it.description),
                installUrl: extText(it.packageUrl) || extText(it.installUrl),
                source: extText(it.source, '来源未标注'),
                tags: Array.isArray(it.tags)
                    ? it.tags.filter(function (t) { return typeof t === 'string'; }).slice(0, 4)
                    : [],
                featured: !!it.featured
            };
        });
    }

    function extCard(it) {
        var card = el('article', 'ext-card');
        var top = el('div', 'ext-card-top');
        var mark = el('span', 'ext-mark', it.mark);
        // 走 CSSOM 而不是 setAttribute('style')：将来若给站点加 CSP，
        // 内联 style 属性会被挡，CSSOM 赋值不会。
        mark.style.background = it.accent;
        top.appendChild(mark);

        var head = el('div', 'ext-card-head');
        head.appendChild(el('h3', '', it.name));
        head.appendChild(el('span', 'ext-byline', it.developer + ' · ' + it.category));
        top.appendChild(head);
        if (it.featured) top.appendChild(el('span', 'ext-badge', '推荐'));
        card.appendChild(top);

        if (it.description) card.appendChild(el('p', 'ext-desc', it.description));

        if (it.tags.length) {
            var tags = el('div', 'ext-tags');
            it.tags.forEach(function (t) { tags.appendChild(el('span', 'ext-tag', t)); });
            card.appendChild(tags);
        }

        var foot = el('div', 'ext-card-foot');
        foot.appendChild(el('span', 'ext-source', '来源：' + it.source));
        var btn = el('button', 'btn btn-ghost btn-sm', '复制安装地址');
        btn.type = 'button';
        btn.setAttribute('data-ext-copy', it.id);
        foot.appendChild(btn);
        card.appendChild(foot);
        return card;
    }

    function renderExtFilters() {
        var box = $('extFilters');
        if (!box) return;
        box.innerHTML = '';
        var cats = ['全部'];
        extItems.forEach(function (it) {
            if (cats.indexOf(it.category) < 0) cats.push(it.category);
        });
        cats.forEach(function (c) {
            var b = el('button', 'ext-filter' + (c === extFilter ? ' is-on' : ''), c);
            b.type = 'button';
            b.setAttribute('data-ext-filter', c);
            box.appendChild(b);
        });
    }

    function renderExtGrid() {
        var grid = $('extGrid');
        if (!grid) return;
        grid.innerHTML = '';
        var list = extItems.filter(function (it) {
            return extFilter === '全部' || it.category === extFilter;
        });
        if (!list.length) {
            grid.appendChild(el('div', 'ext-empty', '这一分类还没有上架插件。'));
            return;
        }
        list.forEach(function (it) { grid.appendChild(extCard(it)); });
    }

    function extFail(err) {
        var grid = $('extGrid');
        if (grid) {
            grid.innerHTML = '';
            grid.appendChild(el('div', 'ext-empty',
                '插件目录暂时读取不到。可到 PC 版「设置 → 扩展」里粘贴扩展地址安装，或稍后重试。'));
        }
        var count = $('extStoreCount');
        if (count) count.textContent = '目录读取失败';
        if (window.console) console.warn('[Nova] extensions.json 读取失败：', err);
    }

    function legacyCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e) { return false; }
    }

    function copyExtAddress(btn, id) {
        var it = null;
        for (var i = 0; i < extItems.length; i++) {
            if (extItems[i].id === id) { it = extItems[i]; break; }
        }
        if (!it) return;
        function done(ok) {
            var old = btn.textContent;
            btn.textContent = ok ? '已复制' : '复制失败';
            setTimeout(function () { btn.textContent = old; }, 1600);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(it.installUrl)
                .then(function () { done(true); }, function () { done(legacyCopy(it.installUrl)); });
        } else {
            done(legacyCopy(it.installUrl));
        }
    }

    function loadExtensions() {
        if (!window.fetch) { extFail('浏览器不支持 fetch'); return; }
        fetch(EXT_URL, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                extItems = normalizeExt(data);
                var count = $('extStoreCount');
                if (count) count.textContent = '共 ' + extItems.length + ' 款 · 更新于 '
                    + (data.updatedAt || '未知');
                var foot = $('extStoreFoot');
                if (foot) foot.textContent = '目录文件 extensions.json 与 PC 版「设置 → 扩展 → 官网插件商店」同源。'
                    + '安装地址（扩展 ID 或直链）可复制后粘进 Nova 的扩展面板，网页本身不会触发安装。';
                renderExtFilters();
                renderExtGrid();
            })
            .catch(extFail);
    }

    // 卡片是动态渲染的，复制与分类筛选都用事件委托
    document.addEventListener('click', function (ev) {
        var node = ev.target;
        while (node && node.getAttribute) {
            var id = node.getAttribute('data-ext-copy');
            if (id) { copyExtAddress(node, id); return; }
            var cat = node.getAttribute('data-ext-filter');
            if (cat) {
                extFilter = cat;
                renderExtFilters();
                renderExtGrid();
                return;
            }
            node = node.parentNode;
        }
    }, false);

    /* ---------- 初始化 ---------- */

    orderPlatforms();
    window.addEventListener('resize', orderPlatforms, false);
    if (window.matchMedia) {
        var mq = window.matchMedia('(max-width: 820px)');
        if (mq.addEventListener) mq.addEventListener('change', orderPlatforms);
        else if (mq.addListener) mq.addListener(orderPlatforms);
    }

    // 下载点击 → 计数。用事件委托：按钮是动态渲染的，直接绑定会漏。
    document.addEventListener('click', function (ev) {
        var el = ev.target;
        while (el && el.getAttribute) {
            if (el.getAttribute('data-dl')) { bump(el.getAttribute('data-dl')); return; }
            el = el.parentNode;
        }
    }, false);

    loadStats();
    loadExtensions();

    fetch(VERSION_URL, { cache: 'no-store' })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(render)
        .catch(fallback);
})();
