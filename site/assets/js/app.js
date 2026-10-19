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
        if (typeof counts.android === 'number') {
            var a = $('dlCountAndroid');
            if (a) { a.textContent = fmtCount(counts.android); a.hidden = false; }
        }
        if (typeof counts.pc === 'number') {
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

    fetch(VERSION_URL, { cache: 'no-store' })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(render)
        .catch(fallback);
})();
