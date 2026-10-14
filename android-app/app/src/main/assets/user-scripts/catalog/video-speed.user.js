// ==UserScript==
// @name         所有网站倍速播放
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  16倍速播放看全网视频，以及音频，要是播放不了，那我也没办法
// @author       呀嘻耶耶
// @match        *
// @icon         https://www.google.com/s2/favicons?sz=64&domain=zxx.edu.cn
// @require      https://greasyfork.org/scripts/425166-elegant-alert-%E5%BA%93/code/elegant%20alert()%E5%BA%93.js?version=922763
// @grant        none
// @run-at       document-end
// @license      MIT

// ==/UserScript==

(function () {
    //     'use strict';


    window.onload = function () {
        setInterval(() => {
            const video = document.querySelector('video')
            video.play();
            video.addEventListener('ratechange', function () {
                video.playbackRate = 16
            })
            video.playbackRate = 16

            var audio = document.querySelector('audio');
            audio.play();
            audio.addEventListener('ratechange', function () {
                audio.playbackRate = 16
            })
            audio.playbackRate = 16;
            
        }, 2000)
    }


})();