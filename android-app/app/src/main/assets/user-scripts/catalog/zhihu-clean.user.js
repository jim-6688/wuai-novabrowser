// ==UserScript==
// @name         知乎增强：自动关闭登录弹窗、外链跳转与广告弹窗
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  自动关闭知乎登录弹窗，处理外链安全提示，关闭右下角广告弹窗，并恢复页面滚动。
// @author       Assistant
// @match        https://*.zhihu.com/*
// @match        http://*.zhihu.com/*
// @icon         https://static.zhihu.com/heifetz/favicon.ico
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // 配置区域：可根据需要调整
    const config = {
        // 重试次数
        maxRetries: 10,
        // 重试间隔（毫秒）
        retryInterval: 500,
        // 启用实验性功能（如点击背景关闭评论弹窗）
        experimentalFunction: false
    };

    let retryCount = 0;
    let checkInterval;

    /**
     * 主关闭函数
     */
    function mainCloser() {
        closeLoginModal();
        closeFixedAdPopup();  // 新增：关闭右下角固定广告弹窗
        restoreScroll();
        autoClickContinueVisit();

        // 如果达到最大重试次数，停止检查
        if (retryCount >= config.maxRetries) {
            clearInterval(checkInterval);
            console.log('知乎增强脚本：已达到最大重试次数，停止检查。');
            return;
        }
        retryCount++;
    }

    /**
     * 关闭登录弹窗
     */
    function closeLoginModal() {
        // 多种选择器策略，提高兼容性
        const selectors = [
            '.Modal-closeButton', // 主关闭按钮
            'button.Button.Modal-closeButton.Button--plain', // 带更多样式的关闭按钮
            'div.Modal-wrapper', // 直接操作弹窗容器
        ];

        for (let selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
                try {
                    if (selector === 'div.Modal-wrapper') {
                        // 直接移除弹窗容器
                        element.remove();
                        console.log('知乎增强脚本：通过移除弹窗容器方式关闭登录弹窗。');
                    } else {
                        // 模拟点击关闭按钮
                        element.click();
                        console.log('知乎增强脚本：通过点击关闭按钮方式关闭登录弹窗。');
                    }
                    // 成功找到并处理一个元素后即可返回
                    return;
                } catch (error) {
                    console.warn('知乎增强脚本：处理元素时发生错误：', error);
                }
            }
        }
    }

    /**
     * 关闭右下角固定位置广告弹窗（根据图片中的样式特征）
     */
    function closeFixedAdPopup() {
        // 多种选择器组合，以应对不同的实现方式
        const adSelectors = [
            // 根据样式特征选择
            'div[style*="position: fixed"][style*="bottom:"][style*="right:"]',
            'div[style*="position:fixed"][style*="bottom:"][style*="right:"]',
            
            // 尝试通用选择器
            '.Pc-card', // 知乎可能的广告卡片类名
            '.AdCard',  // 可能的广告卡片
            '.ad-container',
            '.ad-popup',
            '.fixed-ad',
            
            // 更具体的选择器，针对图片中显示的样式
            'div[style*="336px"]', // 宽度336px
            'div[style*="z-index: 2"]', // z-index为2
        ];

        for (let selector of adSelectors) {
            const elements = document.querySelectorAll(selector);
            elements.forEach(element => {
                try {
                    const style = window.getComputedStyle(element);
                    
                    // 检查元素是否符合图片中的特征
                    const isFixedAndPositioned = style.position === 'fixed' && 
                        (style.bottom === '50px' || parseInt(style.bottom) === 50) &&
                        (style.right === '64px' || parseInt(style.right) === 64);
                    
                    const hasCorrectSize = style.width === '336px' || 
                        parseInt(style.width) === 336;
                    
                    const hasWhiteBackground = style.backgroundColor === 'rgb(255, 255, 255)' ||
                                               style.backgroundColor === 'rgba(255, 255, 255, 1)';
                    
                    // 如果满足条件，则关闭/移除
                    if ((isFixedAndPositioned && hasWhiteBackground) || 
                        (isFixedAndPositioned && hasCorrectSize)) {
                        
                        console.log('知乎增强脚本：发现右下角固定广告弹窗，正在关闭...', element);
                        
                        // 先尝试查找关闭按钮
                        const closeButtons = element.querySelectorAll(
                            'button, .close, .modal-close, [aria-label*="关闭"], [aria-label*="close"], .CloseButton, .close-btn'
                        );
                        
                        if (closeButtons.length > 0) {
                            closeButtons[0].click();
                            console.log('知乎增强脚本：已点击关闭按钮');
                        } else {
                            // 如果没有找到关闭按钮，直接移除元素
                            element.style.display = 'none';
                            element.remove();
                            console.log('知乎增强脚本：已移除广告弹窗');
                        }
                        
                        // 同时检查并移除可能的遮罩层
                        const backdrops = document.querySelectorAll(
                            '.Modal-backdrop, .ad-backdrop, .popup-backdrop, [class*="backdrop"]'
                        );
                        backdrops.forEach(backdrop => {
                            backdrop.style.display = 'none';
                            backdrop.remove();
                        });
                    }
                } catch (error) {
                    console.warn('知乎增强脚本：处理广告弹窗时发生错误：', error);
                }
            });
        }
        
        // 额外的检查：通过更精确的样式匹配
        const allFixedElements = document.querySelectorAll('*');
        allFixedElements.forEach(element => {
            try {
                const style = window.getComputedStyle(element);
                if (style.position === 'fixed' && 
                    parseInt(style.bottom) === 50 && 
                    parseInt(style.right) === 64 &&
                    parseInt(style.width) === 336 &&
                    (style.backgroundColor === 'rgb(255, 255, 255)' || 
                     style.backgroundColor === 'rgba(255, 255, 255, 1)')) {
                    
                    console.log('知乎增强脚本：通过样式匹配找到广告弹窗，正在关闭...');
                    element.style.display = 'none';
                    element.remove();
                }
            } catch (error) {
                // 忽略可能的样式获取错误
            }
        });
    }

    /**
     * 恢复页面滚动（关闭弹窗后页面可能被锁定）
     */
    function restoreScroll() {
        if (document.documentElement.style.overflow === 'hidden') {
            document.documentElement.style.overflow = 'auto';
            document.body.style.overflow = 'auto';
        }
    }

    /**
     * 自动点击"继续访问"按钮（用于外链安全跳转提示）
     */
    function autoClickContinueVisit() {
        const continueButton = document.querySelector('a.button');
        if (continueButton && continueButton.innerText === "继续访问") {
            continueButton.click();
            console.log('知乎增强脚本：已自动点击"继续访问"按钮。');
        }
    }

    /**
     * 实验性功能：点击背景关闭评论等弹窗
     */
    function initExperimentalFunction() {
        if (!config.experimentalFunction) return;

        document.addEventListener('click', function(event) {
            const backdropSelectors = ['.Modal-backdrop', '.Modal-wrapper'];
            for (let selector of backdropSelectors) {
                if (event.target.matches(selector)) {
                    const closeBtn = event.target.querySelector('.Modal-closeButton');
                    if (closeBtn) closeBtn.click();
                }
            }
        });
    }

    // 初始执行一次
    mainCloser();
    initExperimentalFunction();

    // 使用间隔定期检查（应对动态加载的弹窗）
    checkInterval = setInterval(mainCloser, config.retryInterval);

    // 使用 MutationObserver 监控 DOM 变化（更高效地应对动态内容）
    const observer = new MutationObserver(function(mutations) {
        // 检查是否有新增的节点包含弹窗相关元素
        let shouldCheck = mutations.some(mutation => {
            return Array.from(mutation.addedNodes).some(node => {
                return node.nodeType === 1 && (
                    node.querySelector?.('.Modal-closeButton') ||
                    node.querySelector?.('a.button') ||
                    node.matches?.('div[style*="position: fixed"][style*="bottom:"][style*="right:"]') ||
                    node.matches?.('.Pc-card') ||
                    node.matches?.('.ad-container')
                );
            });
        });
        if (shouldCheck) {
            mainCloser();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 页面完全加载后再执行一次，确保处理所有弹窗
    window.addEventListener('load', function() {
        setTimeout(mainCloser, 1000);
        // 额外延迟检查一次广告弹窗
        setTimeout(closeFixedAdPopup, 2000);
    });

    // 监听滚动事件，某些广告会在滚动时出现
    window.addEventListener('scroll', function() {
        setTimeout(closeFixedAdPopup, 300);
    });

    console.log('知乎增强脚本已加载，新增右下角广告弹窗关闭功能！');
})();