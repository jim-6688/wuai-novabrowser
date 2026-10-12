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
            box.appendChild(a);
        }
        if (window.console) console.warn('[Nova] version.json 读取失败：', err);
    }

    fetch(VERSION_URL, { cache: 'no-store' })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(render)
        .catch(fallback);
})();
