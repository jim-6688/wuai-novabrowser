'use strict';

/**
 * 内置广告 / 追踪拦截清单（EasyList / Adblock Plus 语法子集）
 * 这是一份「开箱即用」的基础清单，覆盖主流广告联盟、统计脚本、常见广告容器。
 * 用户可在「广告拦截 → 订阅」里导入完整 EasyList / EasyPrivacy / CJX 列表。
 */

const NETWORK = `
! ---- 广告联盟 / 广告交换 ----
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||adservice.google.com^
||pagead2.googlesyndication.com^
||partner.googleadservices.com^
||pubads.g.doubleclick.net^
||securepubads.g.doubleclick.net^
||adnxs.com^
||adnexus.net^
||adsrvr.org^
||advertising.com^
||adcolony.com^
||applovin.com^
||chartboost.com^
||inmobi.com^
||mopub.com^
||unityads.unity3d.com^
||vungle.com^
||ironsrc.com^
||supersonicads.com^
||tapjoy.com^
||criteo.com^
||criteo.net^
||outbrain.com^
||taboola.com^
||revcontent.com^
||mgid.com^
||zergnet.com^
||smartadserver.com^
||teads.tv^
||openx.net^
||rubiconproject.com^
||pubmatic.com^
||indexww.com^
||casalemedia.com^
||sharethrough.com^
||sovrn.com^
||triplelift.com^
||yieldmo.com^
||media.net^
||bidswitch.net^
||districtm.io^
||amazon-adsystem.com^
||ads.yahoo.com^
||adtech.de^
||adform.net^
||adition.com^
||adroll.com^
||adsafeprotected.com^
||adskeeper.com^
||adspirit.de^
||adswizz.com^
||adzerk.net^
||exponential.com^
||flashtalking.com^
||gumgum.com^
||improvedigital.com^
||infolinks.com^
||lijit.com^
||loopme.me^
||nativeads.com^
||onetag.com^
||propellerads.com^
||popads.net^
||popcash.net^
||adbrite.com^
||adbutler.com^
||buysellads.com^
||carbonads.com^
||zedo.com^
||tribalfusion.com^
||undertone.com^
||yieldlab.net^
||adnium.com^
||adcomplete.com^
||adblade.com^
||adcash.com^
||clickadu.com^
||hilltopads.net^
||trafficjunky.net^
||juicyads.com^

! ---- 中国大陆常见广告 / 推广 ----
||cpro.baidu.com^
||cbjs.baidu.com^
||pos.baidu.com^
||dup.baidustatic.com^
||hm.baidu.com^$third-party
||tn.symcb.com^
||gdt.qq.com^
||e.qq.com^$third-party
||pingjs.qq.com^$third-party
||ad.qq.com^
||adsview.qq.com^
||adsgroup.qq.com^
||ta.qq.com^$third-party
||umeng.com^$third-party
||cnzz.com^$third-party
||zz.bdstatic.com^$third-party
||union.bdstatic.com^
||aliunion.cn.yahoo.com^
||tanx.com^
||alimama.cn^
||mgid.cn^
||adx.360.cn^
||cb.ad.360.cn^
||s.360.cn^$third-party
||union.360.cn^
||admaster.com.cn^
||miaozhen.com^
||iresearch.com.cn^$third-party
||talkingdata.com^$third-party
||growingio.com^$third-party
||sensorsdata.cn^$third-party
||58.com/ad^
||union.sogou.com^
||sogou.com/ad^
||ife.baidu.com^
||dsp.adwangmai.com^
||cdn.admaster.com.cn^
||u.alicdn.com^$third-party

! ---- 统计 / 埋点（standard 档仅在第三方场景拦截）----
||google-analytics.com^$third-party
||googletagmanager.com^$third-party
||googletagservices.com^
||scorecardresearch.com^$third-party
||quantserve.com^$third-party
||hotjar.com^$third-party
||mixpanel.com^$third-party
||segment.io^$third-party
||amplitude.com^$third-party
||fullstory.com^$third-party
||mouseflow.com^$third-party
||clicktale.net^$third-party
||crazyegg.com^$third-party
||statcounter.com^$third-party
||histats.com^$third-party
||matomo.cloud^$third-party
||newrelic.com/rum^
||bugsnag.com^$third-party
||sentry.io^$third-party

! ---- 常见 URL 特征 ----
/adserver/*
/adserver2/*
/adframe/*
/adframe.
/adsense/*
/adsense2/*
/adsbygoogle.
/adclick/*
/adclick.php
/adbanner/*
/adbanner.
/advert/*
/adverts/*
/advertisement/*
/advertisements/*
/advertising/*
/ads/*
/ad_js/*
/ads.js
/ads.min.js
/ad2.js
/ad3.js
/popunder.
/popunder.js
/popupads.
/interstitial/*
/prebid.
/prebid.js
/ads/ga-audiences
/pagead/*
/beacon?*$third-party
/tracking?*$third-party
/pixel.gif?*$third-party
/analytics.js$third-party
/gtag/js$third-party
/gtm.js$third-party
/sponsor/*
/sponsored/*
/promoted/*
/sidebar-ad.
/banner-ad.
/float-ad.
/floating-ad.
/ads-banner.
/affiliate?*$third-party
/ad-delivery/*
/adServer/*
/adContent/*
/advertisement.js
/advertising.js

! ---- 挖矿 / 恶意脚本 ----
||coinhive.com^
||authedmine.com^
||crypto-loot.com^
||coin-hive.com^
||jsecoin.com^
||webminepool.com^
||minero.cc^

! ---- 常见弹窗 / 诱导 ----
/clickads/*
/click-ad.
/clicktrack/*
/exitpop.
/ontopop.
/underpop.
/popunder.
/pop.js?*$third-party
/topad.
/floatad.
/ads_flash.
`.trim();

const COSMETIC = `
! ---- 通用广告容器 ----
##.adsbygoogle
##.ad-banner
##.ad-banners
##.ad-container
##.ad-wrapper
##.ad-slot
##.ad-unit
##.ad-placeholder
##.ad-leaderboard
##.ad-sidebar
##.ad-footer
##.ad-header
##.ad-inline
##.advert
##.advertisement
##.advertisements
##.advertising
##.sponsored
##.sponsored-content
##.sponsored-post
##.promoted
##.commercial-break
##.google-ad
##.google-ads
##.adsense
##.ads-container
##.banner-ads
##.banner_ad
##.textads
##.text-ad
##.native-ad
##.native-advertisement
##.affiliate-banner
##.popup-ad
##.float-ad
##.floating-ad
##.sticky-ad
##.overlay-ad
###ad-top
###ad-bottom
###ad-left
###ad-right
###ad-header
###ad-footer
###ads
###adsense
###advert
###advertisement
###banner-ad
###google-ads
###google_ads
###taboola
###outbrain
###ad_push
##[id^="div-gpt-ad"]
##[id^="google_ads_iframe"]
##[id^="aswift_"]
##[class^="ad-slot-"]
##[class^="ads-"]
##[data-ad-slot]
##[data-ad-client]
##[aria-label="Advertisement"]
##iframe[src*="doubleclick.net"]
##iframe[src*="googlesyndication.com"]
##iframe[src*="adservice.google.com"]
##iframe[src*="/adserver/"]
##iframe[src*="criteo"]
##iframe[src*="taboola"]
##iframe[src*="outbrain"]
##iframe[id^="google_ads_iframe"]
##ins.adsbygoogle

! ---- 站点专用（示例，可在订阅页扩充）----
zhihu.com##.Modal-ads
zhihu.com##.AdblockBanner
weibo.com##.woo-box-item-ad
weibo.com##.card9
bilibili.com##.ad-report
bilibili.com##.video-card-ad-small
bilibili.com##.bili-video-card__info--ad
csdn.net##.recommend-box
csdn.net##.programmer1Box
csdn.net##.toolbar-advert
jianshu.com##.advert
sohu.com##.float-ad
163.com##.post_top_ad
sina.com.cn##.advert
qq.com##.advert
iqiyi.com##.qy-player-ad
youku.com##.youku-ad
douban.com##.ad
`.trim();

/** 解析成纯规则数组（去掉注释与空行） */
function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('!') && !l.startsWith('['));
}

module.exports = {
  /** 完整内置清单文本（订阅页可直接展示 / 导出） */
  text: () => NETWORK + '\n' + COSMETIC,
  network: () => parseList(NETWORK),
  cosmetic: () => parseList(COSMETIC)
};
