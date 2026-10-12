'use strict';

/**
 * 广告拦截引擎 v2 —— 多源（multi-source）架构
 * ===========================================================================
 * 三个拦截源并存、各自独立统计与开关：
 *
 *   [1] 广告终结者  —— ChinaList + EasyList 修正（国内站点覆盖）
 *   [2] Adblock Plus —— EasyList 官方规则（含 EasyList China / EasyPrivacy）
 *   [3] 系统内置    —— 吾爱Nova 自带清单，零依赖、离线可用
 *
 * 两条线并行：
 *   网络层  按 ABP 语法匹配并 cancel 请求
 *   样式层  解析 ##选择器 生成 CSS 注入页面，干掉网络层拦不住的自售广告位
 *
 * ---------------------------------------------------------------------------
 * 性能：真实 EasyList 有 2.5 万条网络规则，逐条跑正则会到 15ms/请求
 * （一个页面 100 个请求就是 1.5 秒纯浪费）。因此这里做两级索引：
 *
 *   1) 域名锚索引  ||ads.com^ 这类规则（占绝大多数）按域名建表，
 *      查询时沿 hostname 的后缀链查表，O(1)。
 *   2) 4-gram 索引  其余规则取「最长字面量片段」的前 4 字符作 key，
 *      URL 小写后做 4 字符滑窗查表。若规则能匹配该 URL，其字面量必然
 *      出现在 URL 中，故其前 4 字符必是 URL 的某个 4-gram —— 不会漏。
 *
 * 落不进索引的规则（含通配、字面量不足 4 字符）进 generic 列表全扫，
 * 实测占比很小。索引只做「预筛」，命中后仍跑完整正则，故不影响正确性。
 */

const fs = require('fs');
const path = require('path');
const builtinLists = require('./adblock-lists');

const ROOT = path.join(__dirname, '..', '..');
const FILTER_DIR = path.join(ROOT, 'assets', 'filters');
/** bash 抓取器写下的「实际命中的镜像地址」，用于如实展示来源 */
const MIRROR_LOG = path.join(FILTER_DIR, '_mirrors.txt');

/* ------------------------------------------------------------------ *
 * 1. 拦截源定义
 * ------------------------------------------------------------------ */

const SOURCE_DEFS = [
  {
    id: 'adtchrome',
    name: '广告终结者',
    vendor: 'ChinaList + EasyList 修正',
    homepage: 'http://sub.adtchrome.com/',
    kind: 'remote',
    order: 1,
    note: '国内站点覆盖为主。官方订阅域 sub.adtchrome.com 已停服，使用同血统的 ChinaList 维护版还原。',
    files: [
      { file: 'adt-chinalist-easylist.txt', title: 'ChinaList · EasyList 修正版' },
      { file: 'adt-annoyance.txt', title: "CJX's Annoyance List" }
    ]
  },
  {
    id: 'abp',
    name: 'Adblock Plus',
    vendor: 'EasyList 官方规则',
    homepage: 'https://easylist.to/',
    kind: 'remote',
    order: 2,
    note: 'EasyList 是 Adblock Plus 的默认主订阅，面向国际站点。',
    files: [
      { file: 'easylist.txt', title: 'EasyList' },
      { file: 'easylist-china.txt', title: 'EasyList China' },
      { file: 'easyprivacy.txt', title: 'EasyPrivacy' }
    ]
  },
  {
    id: 'builtin',
    name: '系统内置拦截器',
    vendor: '吾爱Nova 自带清单',
    homepage: '',
    kind: 'builtin',
    order: 3,
    note: '随安装包分发，不依赖网络，首次启动即有基础防护。',
    files: []
  }
];

const SOURCE_BY_ID = new Map(SOURCE_DEFS.map((s) => [s.id, s]));

/* ------------------------------------------------------------------ *
 * 2. 语法过滤：剔除本引擎无法执行的规则
 * ------------------------------------------------------------------ */

/** 过滤器元指令，逐行控制规则生效范围，需跳过（否则会污染解析） */
const PREPROCESSOR = /^#(?:if|endif|include|else)\b/;

/** 我们不做请求改写，这些选项一律跳过而不是当普通规则收下 */
const UNSUPPORTED_OPTIONS = [
  'redirect', 'redirect-rule', 'csp', 'removeparam', 'replace', 'rewrite',
  'permissions', 'urltransform', 'set-cookie', 'removeheader', 'header'
];

function hasUnsupportedOption(line) {
  const d = line.lastIndexOf('$');
  if (d < 0) return false;
  const opts = line.slice(d + 1).toLowerCase();
  return UNSUPPORTED_OPTIONS.some((o) => opts.includes(o));
}

/* ------------------------------------------------------------------ *
 * 3. ABP 语法 → 正则
 * ------------------------------------------------------------------ */

const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

function abpToRegex(pattern) {
  let p = pattern;
  let prefix = '';
  let anchorEnd = false;

  if (p.startsWith('||')) {
    prefix = '^[a-z][a-z0-9+.\\-]*://(?:[^/?#@]*@)?(?:[^/?#.]+\\.)*';
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    prefix = '^';
    p = p.slice(1);
  }

  if (p.endsWith('|')) {
    anchorEnd = true;
    p = p.slice(0, -1);
  }

  let body = '';
  for (const ch of p) {
    if (ch === '*') body += '.*';
    else if (ch === '^') body += '(?:[^\\w\\-.%]|$)';
    else body += ch.replace(REGEX_SPECIALS, '\\$&');
  }

  return new RegExp(prefix + body + (anchorEnd ? '$' : ''), 'i');
}

/* ABP 资源类型 → Electron webRequest resourceType */
const TYPE_MAP = {
  script: ['script'], image: ['image'], stylesheet: ['stylesheet'],
  xmlhttprequest: ['xhr'], subdocument: ['subFrame'], document: ['mainFrame'],
  media: ['media'], font: ['font'], object: ['object'],
  websocket: ['webSocket'], ping: ['ping'], other: ['other']
};
const ALL_ELECTRON_TYPES = new Set(Object.values(TYPE_MAP).flat().concat(['cspReport', 'other']));

/** 可作为「字面量」的字符 —— 保守集合，宁可少收也不能误当字面量 */
const LITERAL_CHARS = /[a-z0-9._\-/:?&=%@+~!#$]/i;

/**
 * 抽取模式中最长的连续字面量片段。
 * 规则若能匹配 URL，该片段必然作为子串出现在 URL 里 —— 索引与预筛都靠这条性质。
 */
function longestLiteral(pattern) {
  let best = '';
  let cur = '';
  for (const ch of pattern) {
    if (LITERAL_CHARS.test(ch)) {
      cur += ch;
    } else {
      if (cur.length > best.length) best = cur;
      cur = '';
    }
  }
  if (cur.length > best.length) best = cur;
  return best;
}

/** 从 ||域名^ 形式的规则里取出域名，取不到返回 null（含通配则不敢索引） */
function domainAnchorOf(pattern) {
  if (!pattern.startsWith('||')) return null;
  const m = pattern.slice(2).match(/^[a-z0-9._-]+/i);
  if (!m) return null;
  const d = m[0].toLowerCase().replace(/^[.]+|[.]+$/g, '');
  if (!d || d.includes('*') || !d.includes('.')) return null;
  return d;
}

const GRAM = 4;

/* ------------------------------------------------------------------ *
 * 3b. 索引容器
 * ------------------------------------------------------------------ *
 * 单个 4-gram 会把「smet / stat / trac」这类高频词根聚成上千条的桶，
 * 逐条跑 matches 依然很贵。故按字面量长度分三层建表：
 *
 *   字面量 ≥ 12 字符 → 12-gram 表（桶最小）
 *   字面量 ≥ 8  字符 → 8-gram 表
 *   字面量 ≥ 4  字符 → 4-gram 表
 *
 * 查询时三层都扫。无损性论证：规则 R 的字面量 L 若能匹配 URL，L 必是
 * URL 的子串，故 L 的前 k 字符也是 URL 子串、也是 URL 的某个 k-gram
 * （k 取 L 所属的那一层，k ≤ |L|），必然被查到。
 *
 * 带域名锚（||domain^）的规则只进域名表 —— 请求 hostname 必然是
 * domain 或其子域，沿后缀链查表必命中，再进 token 表纯属浪费。
 */
function makeIndex(applyLevel) {
  return {
    applyLevel,
    domain: new Map(),
    t4: new Map(),
    t8: new Map(),
    t12: new Map(),
    generic: []
  };
}

function pushRule(map, key, rule) {
  let arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push(rule);
}


/* ------------------------------------------------------------------ *
 * 4. 网络规则
 * ------------------------------------------------------------------ */

class NetworkRule {
  constructor(line, sourceId) {
    this.raw = line;
    this.sourceId = sourceId;
    this.isException = line.startsWith('@@');
    let body = this.isException ? line.slice(2) : line;

    this.types = null;
    this.thirdParty = null;
    this.domains = null;
    this.excludeDomains = null;
    this.matchCase = false;
    this.important = false;

    const dollar = body.lastIndexOf('$');
    if (dollar > 0) {
      const maybe = body.slice(dollar + 1);
      if (/^[a-z~=\d|,\-_.]+$/i.test(maybe) && !maybe.includes('*')) {
        const opts = maybe.split(',');
        const types = [];
        let hasType = false;
        for (const o of opts) {
          const neg = o.startsWith('~');
          const key = neg ? o.slice(1) : o;
          if (key === 'third-party' || key === '3p') { this.thirdParty = !neg; continue; }
          if (key === 'match-case') { this.matchCase = true; continue; }
          if (key === 'important') { this.important = true; continue; }
          if (key === 'popup' || key === 'all') continue;
          if (key.startsWith('domain=')) {
            const list = key.slice(7).split('|').filter(Boolean);
            this.domains = list.filter((d) => !d.startsWith('~')).map((d) => d.toLowerCase());
            this.excludeDomains = list.filter((d) => d.startsWith('~')).map((d) => d.slice(1).toLowerCase());
            continue;
          }
          if (TYPE_MAP[key]) {
            hasType = true;
            if (!neg) types.push(...TYPE_MAP[key]);
            else types.push('!' + TYPE_MAP[key].join(','));
          }
        }
        if (hasType) {
          const excluded = new Set(types.filter((t) => t.startsWith('!')).flatMap((t) => t.slice(1).split(',')));
          const included = types.filter((t) => !t.startsWith('!'));
          this.types = included.filter((t) => !excluded.has(t));
          if (this.types.length === 0) this.types = [...ALL_ELECTRON_TYPES].filter((t) => !excluded.has(t));
        }
        body = body.slice(0, dollar);
      }
    }

    this.pattern = body;
    this.regex = abpToRegex(body);
    if (this.matchCase) this.regex = new RegExp(this.regex.source, '');

    // 索引信息
    this.domainAnchor = domainAnchorOf(body);
    const lit = longestLiteral(body);
    this.literal = lit.toLowerCase();
    this.token = this.literal.length >= GRAM ? this.literal.slice(0, GRAM) : null;

    // 去重戳记：同一请求内保证每条规则只判一次
    this._mark = 0;
  }

  /** ctx: { url, urlLower, hostname, resourceType, docHostname } */
  matches(ctx) {
    if (this.types && !this.types.includes(ctx.resourceType)) return false;

    if (this.thirdParty !== null) {
      const isThirdParty = ctx.docHostname ? !sameSite(ctx.hostname, ctx.docHostname) : false;
      if (this.thirdParty !== isThirdParty) return false;
    }

    if (this.domains) {
      const doc = (ctx.docHostname || '').toLowerCase();
      if (!this.domains.some((d) => doc === d || doc.endsWith('.' + d))) return false;
    }
    if (this.excludeDomains) {
      const doc = (ctx.docHostname || '').toLowerCase();
      if (this.excludeDomains.some((d) => doc === d || doc.endsWith('.' + d))) return false;
    }

    // 廉价预筛：字面量必须是 URL 的子串
    if (this.literal && this.literal.length >= GRAM && !ctx.urlLower.includes(this.literal)) return false;

    return this.regex.test(ctx.url);
  }
}

/** 粗略的站点同源判断（eTLD 简化处理，够用且不做 DNS 查询） */
function sameSite(a, b) {
  const base = (h) => {
    if (!h) return '';
    const parts = h.split('.');
    return parts.length <= 2 ? h : parts.slice(-2).join('.');
  };
  return base(a) === base(b);
}

/* ------------------------------------------------------------------ *
 * 5. 元素隐藏规则
 * ------------------------------------------------------------------ */

/** 我们的样式层是纯 CSS 隐藏，认不出的伪类/函数会让整条规则失效，必须剔除 */
const UNSUPPORTED_SELECTOR = /:has-text\(|:contains\(|:xpath\(|:matches-css|:style\(|:remove\(|:upward\(|:watch-attr\(|:min-text-length\(|:others\(|:matches-attr\(|:matches-prop\(|:shadow\(|:remove-attr\(|:remove-class\(|\$|\\/;

const COSMETIC_MARKERS = [
  ['##+js(', 'ext'],
  ['#@?#', 'ext'], ['#?#', 'ext'],
  ['#@$#', 'ext'], ['#$#', 'ext'],
  ['#@%#', 'ext'], ['#%#', 'ext'],
  ['#@#', 'exception'],
  ['##', 'hide']
];

/** 判定一行元素隐藏规则的语法类别，返回 null 表示不支持 */
function cosmeticKind(line) {
  if (line.includes('$$')) return null;
  for (const [marker, kind] of COSMETIC_MARKERS) {
    const idx = line.indexOf(marker);
    if (idx >= 0) return { kind, idx, marker };
  }
  return null;
}

class CosmeticRule {
  constructor(line, sourceId, kind, idx, marker) {
    this.raw = line;
    this.sourceId = sourceId;
    this.isException = kind === 'exception';
    const head = idx > 0 ? line.slice(0, idx) : '';
    this.selector = line.slice(idx + marker.length).trim();
    this.include = [];
    this.exclude = [];
    for (const d of head.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (d.startsWith('~')) this.exclude.push(d.slice(1).toLowerCase());
      else this.include.push(d.toLowerCase());
    }
  }

  appliesTo(hostname) {
    const h = (hostname || '').toLowerCase();
    if (this.exclude.some((d) => h === d || h.endsWith('.' + d))) return false;
    if (this.include.length === 0) return true;
    return this.include.some((d) => h === d || h.endsWith('.' + d));
  }

  get isUniversal() { return this.include.length === 0; }
}

/* ------------------------------------------------------------------ *
 * 6. 拦截器
 * ------------------------------------------------------------------ */

class AdBlocker {
  constructor() {
    /** @type {Map<string, {def:object, enabled:boolean, loaded:boolean, lists:array, counts:object, blocked:number}>} */
    this.sources = new Map();
    for (const def of SOURCE_DEFS) {
      this.sources.set(def.id, {
        def, enabled: true, loaded: false, error: null,
        lists: [], counts: { network: 0, cosmetic: 0, exceptions: 0, skipped: 0 },
        blocked: 0
      });
    }

    this._markSeq = 0;
    this._cssCache = new Map();
    this.resetRules();

    this.enabled = true;
    this.cosmeticEnabled = true;
    this.level = 'standard';
    this.allowlist = new Set();
    this.stats = { blocked: 0, byHost: new Map(), byRule: new Map(), bySource: new Map() };
    this.onChange = () => {};
  }

  resetRules() {
    this.net = makeIndex(true);
    this.ex = makeIndex(false);
    this._counts = { network: 0, exceptions: 0 };
    this.cosmeticUniversal = [];
    this.cosmeticByDomain = new Map();
    this.cosmeticUniversalExceptions = new Set();
    this.cosmeticDomainExceptions = new Map();
    this._activeUniversal = [];
    this._universalBytes = 0;
    this._markSeq = 0;
    this._cssCache.clear();
  }

  /** 记录当前正在装载的源，规则解析时打标 */
  _beginSource(id) { this._currentSource = id; }

  loadAll(opts = {}) {
    this.resetRules();
    for (const [id, src] of this.sources) {
      if (opts.only && opts.only !== id) continue;
      src.lists = [];
      src.counts = { network: 0, cosmetic: 0, exceptions: 0, skipped: 0 };
      src.error = null;
      this._beginSource(id);
      if (src.def.kind === 'builtin') this._loadBuiltin(src);
      else this._loadRemoteSource(src);
      src.loaded = true;
    }
    this._currentSource = null;
    this._rebuildActiveCosmetic();
    this.onChange(this.statsSnapshot());
    return this.statsSnapshot();
  }

  /** 兼容旧调用点 */
  loadBuiltin() { return this.loadAll(); }

  _loadBuiltin(src) {
    const network = builtinLists.network();
    const cosmetic = builtinLists.cosmetic();
    const n = this.addRules(network.concat(cosmetic), src.def.id);
    src.lists = [{
      file: 'src/main/adblock-lists.js', title: '吾爱Nova 内置清单',
      url: '', network: network.length, cosmetic: cosmetic.length,
      rules: network.length + cosmetic.length, bytes: null, updatedAt: null, builtin: true
    }];
    src.counts.network += n.network;
    src.counts.cosmetic += n.cosmetic;
    src.counts.exceptions += n.exceptions;
  }

  _loadRemoteSource(src) {
    const mirrors = readMirrors();
    for (const spec of src.def.files) {
      const abs = path.join(FILTER_DIR, spec.file);
      if (!fs.existsSync(abs)) {
        src.lists.push({ ...spec, url: mirrors[spec.file] || '', missing: true, rules: 0, network: 0, cosmetic: 0 });
        src.counts.skipped += 1;
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        src.error = err.message;
        continue;
      }
      const lines = parseList(text);
      const r = this.addRules(lines, src.def.id);

      const title = headerValue(text, 'Title') || spec.title;
      const version = headerValue(text, 'Version');
      const modified = headerValue(text, 'Last modified');
      const st = fs.statSync(abs);

      src.lists.push({
        ...spec, title,
        url: mirrors[spec.file] || '',
        version, modified,
        network: r.network, cosmetic: r.cosmetic, rules: r.network + r.cosmetic,
        skipped: r.skipped,
        bytes: st.size,
        updatedAt: st.mtime.toISOString()
      });
      src.counts.network += r.network;
      src.counts.cosmetic += r.cosmetic;
      src.counts.exceptions += r.exceptions;
      src.counts.skipped += r.skipped;
    }
  }

  /** 从文件导入用户自备清单，记到 builtin 源下（用户清单） */
  importFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = parseList(text);
    const r = this.addRules(lines, 'builtin');
    const src = this.sources.get('builtin');
    src.lists.push({
      file: filePath, title: path.basename(filePath), url: '',
      network: r.network, cosmetic: r.cosmetic, rules: r.network + r.cosmetic,
      skipped: r.skipped, user: true, updatedAt: new Date().toISOString()
    });
    src.counts.network += r.network;
    src.counts.cosmetic += r.cosmetic;
    src.counts.exceptions += r.exceptions;
    this._cssCache.clear();
    return lines.length;
  }

  /**
   * 装载规则并同时建立索引。
   * @returns {{network:number, cosmetic:number, exceptions:number, skipped:number}}
   */
  addRules(lines, sourceId) {
    const out = { network: 0, cosmetic: 0, exceptions: 0, skipped: 0 };

    for (const line of lines) {
      if (PREPROCESSOR.test(line)) { out.skipped += 1; continue; }

      // --- 元素隐藏 ---
      const cos = cosmeticKind(line);
      if (cos) {
        if (UNSUPPORTED_SELECTOR.test(line.slice(cos.idx + cos.marker.length))) { out.skipped += 1; continue; }
        const rule = new CosmeticRule(line, sourceId, cos.kind, cos.idx, cos.marker);
        if (!rule.selector) { out.skipped += 1; continue; }
        this._indexCosmetic(rule);
        out.cosmetic += 1;
        continue;
      }

      // --- 网络规则 ---
      if (line.includes('##') || line.includes('#@#') || line.includes('#?#')) { out.skipped += 1; continue; }
      if (hasUnsupportedOption(line)) { out.skipped += 1; continue; }

      let rule;
      try {
        rule = new NetworkRule(line, sourceId);
      } catch {
        out.skipped += 1;
        continue;
      }
      this._indexNetwork(rule);
      if (rule.isException) out.exceptions += 1;
      else out.network += 1;
    }
    return out;
  }

  _indexNetwork(rule) {
    this._indexRule(rule, rule.isException ? this.ex : this.net);
    if (rule.isException) this._counts.exceptions += 1;
    else this._counts.network += 1;
  }

  /** 把规则放进最合适的一层索引 */
  _indexRule(rule, idx) {
    if (rule.domainAnchor) {
      pushRule(idx.domain, rule.domainAnchor, rule);
      return;
    }
    const L = rule.literal.length;
    if (L >= 12) pushRule(idx.t12, rule.literal.slice(0, 12), rule);
    else if (L >= 8) pushRule(idx.t8, rule.literal.slice(0, 8), rule);
    else if (L >= 4) pushRule(idx.t4, rule.literal.slice(0, 4), rule);
    else idx.generic.push(rule);
  }

  _indexCosmetic(rule) {
    if (rule.isUniversal) {
      if (rule.isException) this.cosmeticUniversalExceptions.add(rule.selector);
      else this.cosmeticUniversal.push(rule);
      return;
    }
    const map = rule.isException ? this.cosmeticDomainExceptions : this.cosmeticByDomain;
    for (const d of rule.include) {
      let arr = map.get(d);
      if (!arr) { arr = []; map.set(d, arr); }
      arr.push(rule);
    }
  }

  configure(opts = {}) {
    if (typeof opts.enabled === 'boolean') this.enabled = opts.enabled;
    if (typeof opts.cosmetic === 'boolean') this.cosmeticEnabled = opts.cosmetic;
    if (opts.level) this.level = opts.level;
    if (Array.isArray(opts.allowlist)) this.allowlist = new Set(opts.allowlist);
    if (opts.sources && typeof opts.sources === 'object') {
      for (const [id, on] of Object.entries(opts.sources)) {
        const s = this.sources.get(id);
        if (s) s.enabled = !!on;
      }
    }
  }

  setSourceEnabled(id, on) {
    const s = this.sources.get(id);
    if (!s) return false;
    s.enabled = !!on;
    this._rebuildActiveCosmetic();
    this.onChange(this.statsSnapshot());
    return true;
  }

  isAllowlisted(hostname) {
    const h = (hostname || '').toLowerCase();
    for (const entry of this.allowlist) {
      if (h === entry || h.endsWith('.' + entry)) return true;
    }
    return false;
  }

  /**
   * 在给定索引里找出第一条命中规则。
   * 顺序：域名锚 → 12-gram → 8-gram → 4-gram → 回退全扫。
   * 桶内规则用 _mark 戳记去重，同一请求内每条规则最多判一次。
   */
  _scan(ctx, seq, idx) {
    const { hostname, urlLower } = ctx;

    // 1) 域名锚：沿后缀链 a.b.c → a.b.c, b.c, c
    let h = hostname;
    while (h) {
      const arr = idx.domain.get(h);
      if (arr && this._scanBucket(arr, ctx, seq, idx)) return true;
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
    }

    // 2) token：一次遍历同时喂三层 gram
    const L = urlLower.length;
    for (let i = 0; i + GRAM <= L; i++) {
      const a4 = idx.t4.get(urlLower.slice(i, i + GRAM));
      if (a4 && this._scanBucket(a4, ctx, seq, idx)) return true;
      if (i + 8 <= L) {
        const a8 = idx.t8.get(urlLower.slice(i, i + 8));
        if (a8 && this._scanBucket(a8, ctx, seq, idx)) return true;
      }
      if (i + 12 <= L) {
        const a12 = idx.t12.get(urlLower.slice(i, i + 12));
        if (a12 && this._scanBucket(a12, ctx, seq, idx)) return true;
      }
    }

    // 3) 回退
    return idx.generic.length > 0 && this._scanBucket(idx.generic, ctx, seq, idx);
  }

  _scanBucket(arr, ctx, seq, idx) {
    for (let k = 0; k < arr.length; k++) {
      const rule = arr[k];
      if (rule._mark === seq) continue;
      rule._mark = seq;

      const src = this.sources.get(rule.sourceId);
      if (!src || !src.enabled) continue;

      // 标准档不拦第一方资源，避免误伤站点自身脚本；例外规则不受此限
      if (idx.applyLevel && this.level === 'standard' && ctx.docHostname
          && sameSite(ctx.hostname, ctx.docHostname)) continue;

      if (rule.matches(ctx)) return true;
    }
    return false;
  }

  /** 核心判定：返回 null（放行）或命中的规则 */
  check(url, resourceType, docHostname) {
    if (!this.enabled) return null;
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { return null; }
    if (this.isAllowlisted(docHostname || hostname)) return null;

    const ctx = { url, urlLower: url.toLowerCase(), hostname, resourceType, docHostname };

    // 1) 例外优先 —— 同样走索引，不再全扫
    if (this._scan(ctx, ++this._markSeq, this.ex)) return null;

    // 2) 拦截
    const seq = ++this._markSeq;
    const candidates = this._collect(this.net, ctx, seq);
    for (let i = 0; i < candidates.length; i++) {
      const rule = candidates[i];
      if (!rule.matches(ctx)) continue;
      this.stats.blocked += 1;
      this.stats.byHost.set(hostname, (this.stats.byHost.get(hostname) || 0) + 1);
      this.stats.byRule.set(rule.raw, (this.stats.byRule.get(rule.raw) || 0) + 1);
      this.stats.bySource.set(rule.sourceId, (this.stats.bySource.get(rule.sourceId) || 0) + 1);
      const src = this.sources.get(rule.sourceId);
      if (src) src.blocked += 1;
      return rule;
    }
    return null;
  }

  /** 收集候选规则（已做源开关与强度过滤），供 check 逐条做完整匹配 */
  _collect(idx, ctx, seq) {
    const out = [];
    const take = (arr) => {
      for (let k = 0; k < arr.length; k++) {
        const rule = arr[k];
        if (rule._mark === seq) continue;
        rule._mark = seq;
        const src = this.sources.get(rule.sourceId);
        if (!src || !src.enabled) continue;
        if (this.level === 'standard' && ctx.docHostname
            && sameSite(ctx.hostname, ctx.docHostname)) continue;
        out.push(rule);
      }
    };

    const { hostname, urlLower } = ctx;
    let h = hostname;
    while (h) {
      const arr = idx.domain.get(h);
      if (arr) take(arr);
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
    }

    const L = urlLower.length;
    for (let i = 0; i + GRAM <= L; i++) {
      const a4 = idx.t4.get(urlLower.slice(i, i + GRAM));
      if (a4) take(a4);
      if (i + 8 <= L) {
        const a8 = idx.t8.get(urlLower.slice(i, i + 8));
        if (a8) take(a8);
      }
      if (i + 12 <= L) {
        const a12 = idx.t12.get(urlLower.slice(i, i + 12));
        if (a12) take(a12);
      }
    }
    if (idx.generic.length) take(idx.generic);
    return out;
  }

  /** 源开关变化后重建「启用源的通用隐藏规则」快照 —— 免得每次生成 CSS 都遍历三万条 */
  _rebuildActiveCosmetic() {
    const seen = new Set();
    const out = [];
    for (const r of this.cosmeticUniversal) {
      const src = this.sources.get(r.sourceId);
      if (!src || !src.enabled) continue;
      if (seen.has(r.selector)) continue;
      seen.add(r.selector);
      out.push(r);
    }
    this._activeUniversal = out;
    this._universalBytes = out.reduce((n, r) => n + r.selector.length + 1, 0);
    this._cssCache.clear();
  }

  /** 生成该站点的隐藏样式（按 hostname 缓存） */
  cosmeticCss(hostname) {
    if (!this.cosmeticEnabled || !this.enabled) return '';
    const h = (hostname || '').toLowerCase();
    if (this.isAllowlisted(h)) return '';
    if (this._cssCache.has(h)) return this._cssCache.get(h);

    const excluded = new Set(this.cosmeticUniversalExceptions);
    // 域名例外：沿后缀链查
    let p = h;
    while (p) {
      const arr = this.cosmeticDomainExceptions.get(p);
      if (arr) for (const r of arr) excluded.add(r.selector);
      const i = p.indexOf('.');
      if (i < 0) break;
      p = p.slice(i + 1);
    }

    const sel = [];
    const seen = new Set();

    for (const r of this._activeUniversal) {
      if (excluded.has(r.selector) || seen.has(r.selector)) continue;
      seen.add(r.selector);
      sel.push(r.selector);
    }

    p = h;
    while (p) {
      const arr = this.cosmeticByDomain.get(p);
      if (arr) {
        for (const r of arr) {
          const src = this.sources.get(r.sourceId);
          if (!src || !src.enabled) continue;
          if (!r.appliesTo(h)) continue;
          if (excluded.has(r.selector) || seen.has(r.selector)) continue;
          seen.add(r.selector);
          sel.push(r.selector);
        }
      }
      const i = p.indexOf('.');
      if (i < 0) break;
      p = p.slice(i + 1);
    }

    const css = sel.length ? sel.join(',') + '{display:none!important}' : '';
    this._cssCache.set(h, css);
    if (this._cssCache.size > 200) this._cssCache.clear();
    return css;
  }

  statsSnapshot() {
    const top = [...this.stats.byHost.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([host, count]) => ({ host, count }));

    const topRules = [...this.stats.byRule.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([rule, count]) => ({ rule, count }));

    const sources = [...this.sources.values()].map((s) => ({
      id: s.def.id,
      name: s.def.name,
      vendor: s.def.vendor,
      homepage: s.def.homepage,
      kind: s.def.kind,
      note: s.def.note,
      enabled: s.enabled,
      loaded: s.loaded,
      error: s.error,
      counts: s.counts,
      blocked: this.stats.bySource.get(s.def.id) || 0,
      lists: s.lists
    }));

    return {
      blocked: this.stats.blocked,
      enabled: this.enabled,
      cosmetic: this.cosmeticEnabled,
      level: this.level,
      rules: {
        network: this._counts.network,
        cosmetic: this.cosmeticUniversal.length
          + [...this.cosmeticByDomain.values()].reduce((a, b) => a + b.length, 0),
        exceptions: this._counts.exceptions,
        generic: this.net.generic.length + this.ex.generic.length,
        indexedDomains: this.net.domain.size,
        indexedTokens: this.net.t4.size + this.net.t8.size + this.net.t12.size,
        universal: this._activeUniversal.length,
        universalCssBytes: this._universalBytes
      },
      sources,
      top,
      topRules
    };
  }

  resetStats() {
    this.stats = { blocked: 0, byHost: new Map(), byRule: new Map(), bySource: new Map() };
    for (const s of this.sources.values()) s.blocked = 0;
    this.onChange(this.statsSnapshot());
  }
}

/* ------------------------------------------------------------------ *
 * 7. 辅助
 * ------------------------------------------------------------------ */

/** 去掉注释行与空行（保留 [Adblock Plus 2.0] 这类头部由 headerValue 读） */
function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('!') && !l.startsWith('['));
}

/** 读规则文件头部 `! Title: xxx` 之类的元信息 */
function headerValue(text, key) {
  const re = new RegExp('^!\\s*' + key + '\\s*:\\s*(.+)$', 'im');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/** 读 bash 抓取器记录的「实际命中镜像」 */
function readMirrors() {
  const map = {};
  try {
    const txt = fs.readFileSync(MIRROR_LOG, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const [file, url] = line.split('\t');
      if (file && url) map[file.trim()] = url.trim();
    }
  } catch { /* 无记录则留空 */ }
  return map;
}

const adblock = new AdBlocker();

module.exports = {
  AdBlocker, adblock, NetworkRule, CosmeticRule,
  abpToRegex, sameSite, longestLiteral, domainAnchorOf, parseList, cosmeticKind,
  SOURCE_DEFS, FILTER_DIR
};
