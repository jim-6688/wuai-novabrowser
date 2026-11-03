'use strict';

/**
 * 语言与地区
 * ---------------------------------------------------------------------------
 * 站点的语言通常按两样东西决定：请求头 `Accept-Language`，以及 JS 里的
 * `navigator.language(s)`。Electron 默认这两样都跟着**系统**走 ——
 * 系统是英文、或者系统区域设成了「英语（美国）」，即便人在国内，
 * 打开的也会是英文页面。
 *
 * 这里给它一个可配置的出口：
 *   locale = 'auto'   跟随系统（默认，行为与以前一致）
 *   locale = 'zh-CN'  强制按简体中文要页面
 *   ……其余见 OPTIONS
 *
 * 两条生效链路：
 *   1. 启动时 `--lang` / `--accept-lang` 开关 → 影响 navigator.language(s)
 *      与 Chromium 自己的默认请求头（**需要重启生效**）
 *   2. engines.js 的 applyHeaders 在每个请求上写 Accept-Language →
 *      改完立刻生效，不用重启
 *
 * 这个文件是纯逻辑，不 require electron，便于单测。
 */

/**
 * 可选语言。
 *
 * `label` 用该语言自己的写法（中文写「简体中文」、日语写「日本語」）——
 * 用户看不懂界面语言时，至少还能在自己的语言里认出那一行。
 */
const OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'es-ES', label: 'Español' },
  { value: 'pt-BR', label: 'Português' }
];

const VALUES = OPTIONS.map((o) => o.value);
const FALLBACK = 'zh-CN';

/**
 * 每种语言的 q 权重串。
 *
 * 规则：首选语言 q=1（省略），同一主语言的其它变体 0.9，英语 0.8 兜底
 * （绝大多数站点都有英文页，留一条英文比只报中文更容易拿到内容）。
 */
const ACCEPT = {
  'zh-CN': 'zh-CN,zh;q=0.9,en;q=0.8',
  'zh-TW': 'zh-TW,zh;q=0.9,en;q=0.8',
  'en-US': 'en-US,en;q=0.9,zh;q=0.6',
  'ja-JP': 'ja-JP,ja;q=0.9,en;q=0.8',
  'ko-KR': 'ko-KR,ko;q=0.9,en;q=0.8',
  'ru-RU': 'ru-RU,ru;q=0.9,en;q=0.8',
  'de-DE': 'de-DE,de;q=0.9,en;q=0.8',
  'fr-FR': 'fr-FR,fr;q=0.9,en;q=0.8',
  'es-ES': 'es-ES,es;q=0.9,en;q=0.8',
  'pt-BR': 'pt-BR,pt;q=0.9,en;q=0.8'
};

/** 主语言 → 该语言下我们支持的默认地区。 */
const PRIMARY = {
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  ru: 'ru-RU',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  pt: 'pt-BR'
};

/** 只接受选项表里的值，其余一律当「跟随系统」。 */
function normalizeLocale(value) {
  const v = String(value || '').trim();
  return VALUES.indexOf(v) >= 0 ? v : 'auto';
}

/** 选项表（给设置页画下拉用）。 */
function options() {
  return OPTIONS.slice();
}

/**
 * 把 Electron 的 `app.getLocale()` 归一到我们支持的标签。
 *
 * <p>真实取值五花八门：`zh-CN`、`zh-Hans-CN`、`zh_CN`、`en-GB`、`ja`。
 * 先做大小写/分隔符归一，再看主语言；都不认识就退回中文
 * —— 这个产品的主要用户在国内，认不出时给中文比给英文更合理。
 */
function normalizeSystemLocale(raw) {
  const s = String(raw || '').trim().replace(/_/g, '-');
  if (!s) return FALLBACK;

  // 已是受支持的值（大小写可能不对）
  const hit = VALUES.find((v) => v.toLowerCase() === s.toLowerCase());
  if (hit) return hit;

  const parts = s.split('-');
  const primary = parts[0].toLowerCase();
  const script = (parts[1] || '').toLowerCase();
  const region = (parts[1] || '').toUpperCase();

  // 中文要分简繁：zh-Hant / zh-TW / zh-HK / zh-MO 都是繁体
  if (primary === 'zh') {
    if (script === 'hant' || /^(TW|HK|MO)$/.test(region)) return 'zh-TW';
    return 'zh-CN';
  }
  if (PRIMARY[primary]) return PRIMARY[primary];
  return FALLBACK;
}

/**
 * 最终生效的语言标签。
 *
 * @param {string} setting     设置里的值（'auto' 或具体标签）
 * @param {string} systemLocale app.getLocale()
 */
function resolveLocale(setting, systemLocale) {
  const s = normalizeLocale(setting);
  if (s !== 'auto') return s;
  return normalizeSystemLocale(systemLocale);
}

/** 该语言的 Accept-Language 权重串。 */
function acceptLanguageFor(tag) {
  const t = normalizeSystemLocale(tag);
  if (ACCEPT[t]) return ACCEPT[t];
  // 兜底：主语言 + 自身 + 英文
  const primary = String(t).split('-')[0];
  return `${t},${primary};q=0.9,en;q=0.8`;
}

/* -------------------------------------------------------------------------- *
 * 运行时状态
 *
 * main.js 启动时 setActive() 一次；engines.js 的 applyHeaders 在每个请求上
 * 读 activeAccept()，所以设置改完下一次请求就是新语言，不用重启。
 * -------------------------------------------------------------------------- */

let activeTag = FALLBACK;

function setActive(tag) {
  activeTag = normalizeSystemLocale(tag);
  return activeTag;
}

function activeLocale() {
  return activeTag;
}

function activeAccept() {
  return acceptLanguageFor(activeTag);
}

module.exports = {
  OPTIONS,
  FALLBACK,
  normalizeLocale,
  normalizeSystemLocale,
  resolveLocale,
  acceptLanguageFor,
  options,
  setActive,
  activeLocale,
  activeAccept
};
