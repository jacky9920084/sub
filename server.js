ssh root@120.55.41.230 "cat > /root/douyin-comments-api/server.js << 'EOF'
const express = require('express');
const puppeteer = require('puppeteer');
const NodeCache = require('node-cache');
const app = express();
const port = 3000;

// 常量定义
const CACHE_TTL = 3600; // 缓存有效期，单位：秒
const MAX_COMMENTS = 100; // 最大评论数量，设为更大值
const DEBUG_MODE = true; // 调试模式，打印更多日志

// 设置日志函数
const logger = {
  info: (msg, ...args) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, ...args),
  debug: (msg, ...args) => DEBUG_MODE ? console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, ...args) : null
};

// 缓存设置
const cache = new NodeCache({ stdTTL: CACHE_TTL });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/page-debug', async (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ error: '请提供抖音视频URL' });
  }
  
  try {
    console.log(`开始分析页面: ${url}`);
    
    // 确保使用PC版URL
    const pcUrl = url.replace('m.douyin.com', 'www.douyin.com');
    console.log(`转换为PC版URL: ${pcUrl}`);
    
    // 启动浏览器
    const browser = await puppeteer.launch({
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process'
      ],
      headless: true
    });
    
    const page = await browser.newPage();
    
    // 设置桌面浏览器用户代理 - 使用Chrome最新版本
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    // 增强浏览器伪装，防止被检测为机器人
    await page.evaluateOnNewDocument(() => {
      // 覆盖WebDriver检测
      Object.defineProperty(navigator, 'webdriver', {get: () => false});
      // 模拟Chrome浏览器特有属性
      window.chrome = {runtime: {}};
      window.navigator.chrome = {runtime: {}};
      // 覆盖permissions API
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({state: Notification.permission}) :
          originalQuery(parameters)
      );
    });
    
    // 启用页面控制台消息捕获
    page.on('console', msg => console.log('页面控制台:', msg.text()));
    
    console.log('正在访问URL:', pcUrl);
    await page.goto(pcUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('页面已加载');
    
    // 截图
    await page.screenshot({ path: '/root/douyin-comments-api/screenshot1.png' });
    console.log('已保存初始页面截图');
    
    // 等待页面加载
    await page.waitForTimeout(3000);
    
    // 调试信息：搜索登录弹窗和各种按钮
    const pageDebugInfo = await page.evaluate(() => {
      const debugInfo = {
        url: window.location.href,
        title: document.title,
        buttons: [],
        loginElements: [],
        commentElements: [],
        possibleSelectors: {}
      };
      
      // 查找所有按钮元素
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.button, .login-button, [class*="login"], [class*="button"]'));
      debugInfo.buttons = buttons.map(btn => {
        return {
          text: btn.innerText.trim(),
          classes: typeof btn.className === 'string' ? btn.className : (btn.classList ? Array.from(btn.classList).join(' ') : ''),
          id: btn.id,
          role: btn.getAttribute('role'),
          tag: btn.tagName
        };
      });
      
      // 查找所有包含"登录"、"注册"、"暂不"等文字的元素
      const loginTexts = ['登录', '注册', '暂不', '取消', '关闭', '稍后', '继续浏览'];
      const allElements = Array.from(document.querySelectorAll('*'));
      
      loginTexts.forEach(text => {
        const elements = allElements.filter(el => 
          el.innerText && el.innerText.includes(text) && 
          el.offsetWidth > 0 && el.offsetHeight > 0
        );
        
        debugInfo.loginElements.push({
          searchText: text,
          elements: elements.map(el => ({
            text: el.innerText.trim(),
            tag: el.tagName,
            classes: typeof el.className === 'string' ? el.className : (el.classList ? Array.from(el.classList).join(' ') : ''),
            id: el.id,
            isVisible: (el.offsetWidth > 0 && el.offsetHeight > 0)
          }))
        });
      });
      
      // 查找所有包含"评论"文字的元素
      const commentElements = allElements.filter(el => 
        el.innerText && el.innerText.includes('评论') && 
        el.offsetWidth > 0 && el.offsetHeight > 0
      );
      
      debugInfo.commentElements = commentElements.map(el => ({
        text: el.innerText.trim(),
        tag: el.tagName,
        classes: typeof el.className === 'string' ? el.className : (el.classList ? Array.from(el.classList).join(' ') : ''),
        id: el.id,
        isVisible: (el.offsetWidth > 0 && el.offsetHeight > 0)
      }));
      
      // 尝试常见选择器
      const selectorCategories = {
        'loginDialog': ['.login-dialog', '.login-modal', '[class*="login-dialog"]', '[class*="loginDialog"]', '[class*="LoginDialog"]'],
        'skipLoginButton': ['.skip-login', '.cancel-login', '[class*="skip"]', '[class*="cancel"]', '[data-e2e*="login"]'],
        'commentArea': ['.comment-list', '.comment-area', '[class*="comment"]', '[data-e2e*="comment"]'],
        'commentItems': ['.comment-item', '.UuCzPLbi', '[data-e2e="comment-item"]', '[class*="commentItem"]'],
      };
      
      for (const [category, selectors] of Object.entries(selectorCategories)) {
        debugInfo.possibleSelectors[category] = [];
        
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            debugInfo.possibleSelectors[category].push({
              selector,
              count: elements.length,
              firstElementHTML: elements[0].outerHTML.substring(0, 200) + '...',
              firstElementText: elements[0].innerText.substring(0, 100) + '...'
            });
          }
        }
      }
      
      return debugInfo;
    });
    
    console.log('页面调试信息:', JSON.stringify(pageDebugInfo, null, 2));
    
    // 尝试点击"暂不登录"按钮
    const skipLoginButtonClicked = await page.evaluate(() => {
      // 常见的"暂不登录"按钮选择器
      const possibleSelectors = [
        // 精确文本匹配
        'button:contains("暂不登录")',
        'a:contains("暂不登录")',
        'div:contains("暂不登录")',
        'span:contains("暂不登录")',
        // 模糊匹配
        '[class*="login"] button, [class*="login"] a',
        '[class*="auth"] button, [class*="auth"] a',
        '[class*="modal"] button, [class*="modal"] a',
        '[class*="dialog"] button, [class*="dialog"] a',
        // 按文本内容查找
        'button, a, div, span'
      ];
      
      // 通用方法找到所有包含"暂不"、"取消"、"关闭"等文字的可点击元素
      const texts = ['暂不登录', '稍后再说', '暂不', '取消', '关闭', '稍后', '继续浏览'];
      
      // 查找包含特定文本的元素
      for (const text of texts) {
        // 获取所有元素
        const elements = Array.from(document.querySelectorAll('*'));
        
        // 筛选出包含特定文本且可见的元素
        const matchingElements = elements.filter(el => {
          const hasText = el.innerText && el.innerText.includes(text);
          const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
          const isClickable = el.tagName === 'BUTTON' || el.tagName === 'A' || 
                             el.role === 'button' || (typeof el.className === 'string' && el.className.includes('button')) || (el.classList && el.classList.contains('button'));
          return hasText && isVisible && (isClickable || el.onclick);
        });
        
        if (matchingElements.length > 0) {
          console.log(`找到包含"${text}"的可点击元素:`, 
            matchingElements.map(e => ({
              tag: e.tagName,
              text: e.innerText,
              class: typeof e.className === 'string' ? e.className : (e.classList ? Array.from(e.classList).join(' ') : '')
            }))
          );
          
          // 点击第一个匹配的元素
          try {
            matchingElements[0].click();
            console.log(`已点击包含"${text}"的元素`);
            return {success: true, text: text, element: matchingElements[0].outerHTML};
          } catch (error) {
            console.error(`点击包含"${text}"的元素失败:`, error);
          }
        }
      }
      
      return {success: false, message: '未找到"暂不登录"等按钮'};
    });
    
    console.log('点击"暂不登录"按钮结果:', skipLoginButtonClicked);
    
    // 等待页面反应
    await page.waitForTimeout(3000);
    
    // 再次截图
    await page.screenshot({ path: '/root/douyin-comments-api/screenshot2.png' });
    console.log('已保存点击后页面截图');
    
    // 滚动到页面底部查找评论区
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 2);
    });
    
    await page.waitForTimeout(3000);
    
    // 截图
    await page.screenshot({ path: '/root/douyin-comments-api/screenshot3.png' });
    console.log('已保存滚动后页面截图');
    
    // 查找评论按钮并尝试点击
    const commentButtonInfo = await page.evaluate(() => {
      // 获取所有元素
      const elements = Array.from(document.querySelectorAll('*'));
      
      // 筛选出包含"评论"文字且可见的元素
      const commentElements = elements.filter(el => {
        const hasText = el.innerText && (
          el.innerText.includes('评论') || 
          el.innerText.includes('留言') || 
          el.innerText.includes('查看评论')
        );
        const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
        return hasText && isVisible;
      });
      
      // 评论数字按钮的选择器 - PC版抖音
      const commentCountSelectors = [
        '.xgplayer-comment .xgplayer-comment-count',  // 新版播放器评论图标
        '.aD0LGY4T',  // 播放器区域评论数字
        '[data-e2e="comment-count"]', // 数据属性选择器
        '.video-info-detail .comment-count', // 视频详情区评论数
        '.video-action-item:nth-child(2)', // 评论动作按钮
        '.video-info span[class*="count"]', // 视频信息中的评论计数
        '.tt-badge' // 带数字徽章的元素（通常包含评论数）
      ];
      
      // 先尝试找精确的评论按钮
      for (const selector of commentCountSelectors) {
        const commentBtns = document.querySelectorAll(selector);
        if (commentBtns.length > 0) {
          for (const btn of commentBtns) {
            try {
              commentElements.push(btn); // 添加到候选点击元素
              console.log(`找到评论按钮: ${selector}`);
            } catch (err) {
              console.error(`处理评论按钮失败: ${err.message}`);
            }
          }
        }
      }
      
      const result = {
        found: commentElements.length > 0,
        elements: commentElements.map(e => ({
          tag: e.tagName,
          text: e.innerText,
          class: typeof e.className === 'string' ? e.className : (e.classList ? Array.from(e.classList).join(' ') : '')
        }))
      };
      
      // 尝试点击第一个评论元素
      if (commentElements.length > 0) {
        try {
          // 先尝试模拟用户鼠标悬停
          const element = commentElements[0];
          const mouseoverEvent = new MouseEvent('mouseover', {
            view: window,
            bubbles: true,
            cancelable: true
          });
          element.dispatchEvent(mouseoverEvent);
          
          // 等待50ms再点击，更像真实用户
          setTimeout(() => {}, 50);
          
          // 真正点击
          commentElements[0].click();
          result.clicked = true;
          result.clickedElement = commentElements[0].outerHTML;
        } catch (error) {
          result.clicked = false;
          result.error = error.toString();
        }
      }
      
      return result;
    });
    
    console.log('评论按钮信息:', commentButtonInfo);
    
    // 等待评论区加载 - 增加等待时间到5秒
    await page.waitForTimeout(5000);
    
    // 最后截图
    await page.screenshot({ path: '/root/douyin-comments-api/screenshot4.png' });
    console.log('已保存最终页面截图');
    
    // 分析页面上的所有可能评论元素
    const commentElementsAnalysis = await page.evaluate(() => {
      // 可能的评论选择器
      const possibleSelectors = [
        '.UuCzPLbi',
        '[data-e2e="comment-item"]',
        '.comment-item',
        '.CommentItem',
        '.comment-card',
        '.BbQpYS1P',
        '.comment-wrapper',
        '.ESlRXJ16',
        'div[class*="CommentItem"]',
        'div[class*="comment-item"]',
        'div[class*="commentItem"]',
        '.comment-content-item'
      ];
      
      const results = {};
      
      for (const selector of possibleSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          results[selector] = {
            count: elements.length,
            samples: Array.from(elements).slice(0, 3).map(el => ({
              text: el.innerText.substring(0, 100),
              html: el.outerHTML.substring(0, 200),
              childrenCount: el.children.length
            }))
          };
        }
      }
      
      // 查找页面上任何可能的评论内容
      const potentialComments = [];
      const allElements = document.querySelectorAll('div, p, span');
      
      for (const el of allElements) {
        const text = el.innerText || "";
        // 评论通常不会太短，且有可能包含用户名和内容
        if (text.length > 10 && text.length < 500) {
          // 评论通常有多行
          if (text.includes('\n') || el.children.length > 1) {
            potentialComments.push({
              text: text.substring(0, 100),
              tag: el.tagName,
              classes: typeof el.className === 'string' ? el.className : (el.classList ? Array.from(el.classList).join(' ') : ''),
              children: el.children.length
            });
          }
        }
      }
      
      results.potentialComments = potentialComments.slice(0, 10);
      
      return results;
    });
    
    console.log('评论元素分析:', JSON.stringify(commentElementsAnalysis, null, 2));
    
    // 关闭浏览器
    await browser.close();
    
    // 返回所有收集到的调试信息
    const result = {
      url,
      pageDebugInfo,
      skipLoginButtonClicked,
      commentButtonInfo,
      commentElementsAnalysis,
      timestamp: new Date().toISOString(),
      screenshotsPaths: [
        '/root/douyin-comments-api/screenshot1.png',
        '/root/douyin-comments-api/screenshot2.png',
        '/root/douyin-comments-api/screenshot3.png',
        '/root/douyin-comments-api/screenshot4.png'
      ]
    };
    
    res.json(result);
    
  } catch (error) {
    console.error(`页面分析失败: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// 创建随机用户代理
function getRandomUserAgent() {
  const userAgents = [
    // Chrome最新版
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    // Edge最新版
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    // Firefox最新版
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
    // Safari最新版
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// 评论爬取API
app.get('/api/comments', async (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ 
      success: false,
      error: '必须提供url参数' 
    });
  }
  
  // 确保使用PC网页版URL，非常重要的一点
  if (url.includes('m.douyin.com')) {
    url = url.replace('m.douyin.com', 'www.douyin.com');
    console.log('已将移动版URL转换为PC版:', url);
  }
  
  // 检查缓存
  const cacheKey = `comments:${url}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    console.log('从缓存返回评论数据:', url);
    return res.json(cachedResult);
  }
  
  try {
    console.log(`开始爬取评论: ${url}`);
    
    // 启动浏览器，使用与扩展程序尽可能相似的环境
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080'
      ],
      defaultViewport: {
        width: 1920,
        height: 1080
      }
    });
    
    const page = await browser.newPage();
    
    // 设置随机用户代理
    const userAgent = getRandomUserAgent();
    console.log('使用随机用户代理:', userAgent);
    await page.setUserAgent(userAgent);
    
    // 设置额外的HTTP头部模拟真实浏览器
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Sec-Ch-Ua': '"Google Chrome";v="122", "Not(A:Brand";v="24", "Chromium";v="122"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    });
    
    // 修改浏览器指纹，避免被检测为爬虫
    await page.evaluateOnNewDocument(() => {
      // 伪造插件信息，类似Chrome浏览器默认插件
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const chromePlugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 }
          ];
          return Object.setPrototypeOf(chromePlugins, { item: () => {}, namedItem: () => {}});
        },
      });
      
      // 伪造语言信息，类似中文Chrome浏览器
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      });
      
      // 伪造WebGL信息
      const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) {
          return 'Intel Inc.';
        }
        if (parameter === 37446) {
          return 'Intel(R) Iris(TM) Plus Graphics';
        }
        return originalGetParameter.call(this, parameter);
      };
      
      // 伪造Chrome特有的功能
      window.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {},
      };
      
      // 屏蔽Puppeteer特有的navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      
      // 伪造日期、时区信息
      const originalDate = Date;
      Date = function(args) {
        return new originalDate(args);
      };
      Date.prototype = originalDate.prototype;
      
      // 重写toString方法，隐藏伪造痕迹
      const nativeToString = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === Function.prototype.toString) return nativeToString.call(nativeToString);
        if (this === Object.defineProperty) return 'function defineProperty() { [native code] }';
        return nativeToString.call(this);
      };
    });
    
    // 捕获页面console.log消息，便于调试
    page.on('console', msg => console.log('页面控制台:', msg.text()));
    
    console.log('正在访问URL:', url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('页面已加载');
    
    // 等待页面加载
    await page.waitForTimeout(5000);
    
    // 检查是否在视频页面
    const isVideoPage = await page.evaluate(() => {
      // 复用扩展程序的isVideoPage函数逻辑
      console.log('检查是否在视频页面...');
      
      // 检查URL是否包含视频标识
      const isVideoUrl = window.location.href.includes('/video/') || 
                        window.location.href.includes('modal_id=');
      console.log('URL检查结果:', isVideoUrl);

      // 检查是否存在视频相关元素
      const videoElements = [
        '.xgplayer-container',
        '.video-player',
        '[data-e2e="video-player"]',
        '.video-container',
        'video',
        '.swiper-slide-active',
        '.video-card-container',
        '.video-info-container',
        '.UwR4pj2m',
        '[data-e2e="video-container"]',
        '.player-container',
        '.swiper-wrapper',
        '.modal-video-player',
        '.modal-content-wrapper',
        '[class*="videoContainer"]',
        '[class*="player"]'
      ];

      const hasVideoElement = videoElements.some(selector => {
        const element = document.querySelector(selector);
        if (element) {
          console.log('找到视频元素:', selector);
          return true;
        }
        return false;
      });

      return isVideoUrl || hasVideoElement;
    });
    
    if (!isVideoPage) {
      await browser.close();
      throw new Error('请确保您在抖音视频页面');
    }
    
    console.log('视频页面检测通过');
    
    // 尝试点击"暂不登录"按钮，确保可以继续浏览
    await page.evaluate(() => {
      const texts = ['暂不登录', '稍后再说', '暂不', '取消', '关闭', '稍后', '继续浏览'];
      
      // 查找包含特定文本的元素
      for (const text of texts) {
        // 获取所有元素
        const elements = Array.from(document.querySelectorAll('*'));
        
        // 筛选出包含特定文本且可见的元素
        const matchingElements = elements.filter(el => {
          const hasText = el.innerText && el.innerText.includes(text);
          const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
          return hasText && isVisible;
        });
        
        if (matchingElements.length > 0) {
          console.log(`找到包含"${text}"的元素`);
          try {
            matchingElements[0].click();
            console.log(`已点击包含"${text}"的元素`);
            return true;
          } catch (error) {
            console.error(`点击包含"${text}"的元素失败:`, error);
          }
        }
      }
      
      return false;
    });
    
    // 检查评论区是否已打开，如果没有，需要点击打开
    const isCommentSectionOpen = await page.evaluate(() => {
      // 复用扩展程序的isCommentSectionOpen函数逻辑
      console.log('检查评论区是否已打开...');
      
      // 先确保加载后滚动一下，有些页面需要滚动才显示评论控件
      window.scrollBy(0, 300);
      
      // 检查评论区是否打开
      const commentSelectors = [
        '.comment-list',
        '.comments-list',
        '[data-e2e="comment-list"]',
        '.comment-container',
        '.ReplyList',
        '.comment-card-list',
        '.comment-mainContent',
        '.BbQpYS1P',
        '.comment-panel',
        '[data-e2e="comment-panel"]',
        '.comment-list-container',
        '.ESlRXJ16',
        '.comment-area',
        '.comment-box',
        '.comment-items',
        '[class*="CommentList"]',
        '[class*="commentList"]',
        '[class*="comment-wrapper"]',
        '.modal-comment-list',
        '.modal-comments',
        // PC版douyin特有的评论容器
        '.comment-container',
        '#commentArea',
        '.comment-mainContent',
        '[data-e2e="comment-mainContent"]',
        '.EqzT2C1r',
        '.commentWraper',
        '.video-comment-container'
      ];

      for (const selector of commentSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log('找到评论区元素:', selector, '数量:', elements.length);
          // 检查评论区是否可见
          const isVisible = Array.from(elements).some(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && 
                  (el.offsetWidth > 0 && el.offsetHeight > 0);
          });
          if (isVisible) {
            return true;
          }
        }
      }

      return false;
    });
    
    console.log('评论区是否已打开:', isCommentSectionOpen);
    
    // 如果评论区未打开，找到评论按钮并点击
    if (!isCommentSectionOpen) {
      console.log('评论区未打开，尝试点击评论按钮...');
      
      const commentBtnClicked = await page.evaluate(() => {
        // 常见的评论按钮选择器 - PC版
        const commentBtnSelectors = [
          '.xgplayer-comment', // 播放器中的评论按钮
          '.UwR4pj2z', // 视频操作区评论按钮
          '.pzPe9k2f', // 数据统计中的评论项  
          '.comment-icon', // 评论图标
          '[data-e2e="comment-icon"]', // 评论数据属性
          '[data-e2e="comment-count"]', // 评论数字
          '.video-action-item:nth-child(2)', // 视频操作区第二个按钮通常是评论
          '.aD0LGY4T', // 评论数字
          '.bar-container svg:nth-child(2)' // 工具栏中的第二个图标通常是评论
        ];
        
        // 遍历选择器找评论按钮
        for (const selector of commentBtnSelectors) {
          const btns = document.querySelectorAll(selector);
          if (btns.length > 0) {
            for (const btn of btns) {
              try {
                console.log(`尝试点击评论按钮: ${selector}`);
                
                // 触发鼠标事件以模拟真实点击行为
                ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(eventType => {
                  const event = new MouseEvent(eventType, {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    buttons: 1
                  });
                  btn.dispatchEvent(event);
                });
                
                console.log(`已点击评论按钮: ${selector}`);
                return {success: true, selector};
              } catch (err) {
                console.error(`点击评论按钮失败: ${err.message}`);
              }
            }
          }
        }
        
        // 尝试寻找包含"评论"文字的任何元素
        const commentTextElements = Array.from(document.querySelectorAll('*')).filter(el => 
          el.innerText && 
          (el.innerText.includes('评论') || el.innerText.includes('留言') || el.innerText.includes('条评论')) && 
          el.offsetWidth > 0 && 
          el.offsetHeight > 0
        );
        
        if (commentTextElements.length > 0) {
          try {
            console.log(`尝试点击包含"评论"文字的元素`);
            commentTextElements[0].click();
            console.log(`已点击包含"评论"文字的元素`);
            return {success: true, text: commentTextElements[0].innerText};
          } catch (err) {
            console.error(`点击包含"评论"文字的元素失败: ${err.message}`);
          }
        }
        
        // 最后尝试直接滚动页面，可能会触发评论区加载
        try {
          console.log('尝试滚动页面加载评论区');
          window.scrollBy(0, window.innerHeight / 2);
          return {success: false, scrolled: true, message: '未找到评论按钮，已尝试滚动页面'};
        } catch (err) {
          console.error(`滚动页面失败: ${err.message}`);
        }
        
        return {success: false, message: '未找到评论按钮'};
      });
      
      console.log('点击评论按钮结果:', commentBtnClicked);
      
      // 等待评论区加载，双倍等待时间
      await page.waitForTimeout(6000);
    }
    
    // 滚动并等待评论加载
    await page.evaluate(() => {
      // 确保滚动到评论区可见并尝试多种交互方式激活评论加载
      window.scrollBy(0, window.innerHeight / 2);
      
      // 尝试点击页面，有时这能触发评论加载
      document.body.click();
      
      // 模拟按下End键，尝试滚动到底部
      const endKeyEvent = new KeyboardEvent('keydown', {
        key: 'End',
        code: 'End',
        keyCode: 35,
        which: 35,
        bubbles: true
      });
      document.body.dispatchEvent(endKeyEvent);
    });
    
    // 再等待确保评论完全加载
    await page.waitForTimeout(2000);
    
    // 实现扩展程序的waitForComments逻辑
    await page.evaluate(() => {
      return new Promise((resolve, reject) => {
        const selectors = [
          '.comment-item',
          '.CommentItem',
          '[data-e2e="comment-item"]',
          '.comment-card',
          '.BbQpYS1P',
          '.comment-wrapper',
          '.ESlRXJ16',
          'div[class*="CommentItem"]',
          'div[class*="comment-item"]',
          'div[class*="commentItem"]',
          '.comment-content-item',
          '[class*="CommentWrapper"]',
          '[class*="commentWrapper"]',
          '[class*="comment-content"]',
          '[class*="commentContent"]',
          // PC版抖音特有的评论项选择器
          '.VlUSW36j',
          '.comment-mainContent-item',
          '[class*="comment-item-v2"]',
          '.WM0DtUw9',
          '.comment-list-item',
          '.AiLUjvzO'
        ];
        
        let attempts = 0;
        const maxAttempts = 40; // 增加最大检查次数
        
        const check = () => {
          attempts++;
          console.log(`检查评论加载状态... 第 ${attempts} 次`);
          
          // 遍历所有可能的评论容器
          const containers = document.querySelectorAll([
            '.comment-list',
            '.comments-list',
            '[data-e2e="comment-list"]',
            '.comment-container',
            '.ReplyList',
            '.BbQpYS1P',
            '.comment-panel',
            '.ESlRXJ16',
            '.comment-area',
            '[class*="CommentList"]',
            '[class*="commentList"]',
            '.modal-comment-list',
            '.modal-comments',
            // PC版抖音特有的评论容器
            '.EqzT2C1r',
            '#commentArea',
            '.comment-container',
            '.comment-mainContent',
            '[data-e2e="comment-content"]',
            '.comment-list-container',
            '.commentWraper',
            '.video-comment-container'
          ].join(','));
          
          console.log(`找到 ${containers.length} 个评论容器`);
          
          // 检查每个容器是否可见且包含评论
          for (const container of containers) {
            const style = window.getComputedStyle(container);
            if (style.display !== 'none' && style.visibility !== 'hidden' && 
                container.offsetWidth > 0 && container.offsetHeight > 0) {
              for (const selector of selectors) {
                const comments = container.querySelectorAll(selector);
                if (comments.length > 0) {
                  console.log(`在容器中找到 ${comments.length} 条评论，使用选择器: ${selector}`);
                  resolve();
                  return;
                }
              }
            }
          }
          
          // 尝试检查整个DOM中的评论项
          for (const selector of selectors) {
            const comments = document.querySelectorAll(selector);
            if (comments.length > 0) {
              const visibleComments = Array.from(comments).filter(el => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && 
                      el.offsetWidth > 0 && el.offsetHeight > 0;
              });
              
              if (visibleComments.length > 0) {
                console.log(`在整个页面中找到 ${visibleComments.length} 条可见评论，使用选择器: ${selector}`);
                resolve();
                return;
              }
            }
          }
          
          if (attempts >= maxAttempts) {
            console.error('评论加载超时，请确保评论区已展开并等待评论加载完成');
            resolve(); // 即使超时也继续执行，尝试获取评论
            return;
          }
          
          // 尝试滚动加载更多评论
          const commentContainers = document.querySelectorAll('.comment-list, .comments-list, [data-e2e="comment-list"], .comment-area, .comment-container, .EqzT2C1r, #commentArea');
          if (commentContainers.length > 0) {
            commentContainers.forEach(container => {
              try {
                container.scrollTop = container.scrollHeight;
                console.log(`已滚动评论容器到底部: ${container.className}`);
              } catch (err) {
                console.log(`滚动评论容器失败: ${err.message}`);
              }
            });
          } else {
            // 如果没有找到评论容器，尝试整体滚动页面
            window.scrollBy(0, 200);
          }
          
          setTimeout(check, 1000);
        };
        
        check();
      });
    });
    
    // 提取评论
    const comments = await page.evaluate(() => {
      try {
        console.log('开始提取评论...');
        
        // PC版抖音评论选择器
        const selectors = {
          commentItem: [
            '.comment-item',
            '.CommentItem',
            '[data-e2e="comment-item"]',
            '.comment-card',
            '.BbQpYS1P',
            '.comment-wrapper',
            '.ESlRXJ16',
            'div[class*="CommentItem"]',
            'div[class*="comment-item"]',
            'div[class*="commentItem"]',
            '.comment-content-item',
            '[class*="CommentWrapper"]',
            '[class*="commentWrapper"]',
            '[class*="comment-content"]',
            '[class*="commentContent"]',
            // PC版抖音特有的评论项选择器
            '.VlUSW36j',
            '.comment-mainContent-item',
            '[class*="comment-item-v2"]',
            '.WM0DtUw9',
            '.comment-list-item',
            '.AiLUjvzO'
          ],
          username: [
            '.nickname',
            '.user-name',
            '.user-nickname',
            '.author-name',
            '.user-info-name',
            '.username',
            '.user span',
            '.name',
            '.avatar-wrapper + span',
            '.avatar-wrapper + div',
            '.avatar + span',
            '.comment-user-nickname',
            '.user-info-wrapper .user-name',
            '.comment-item-v2 .user-name',
            // PC版抖音特有的用户名选择器
            '.JYcxTg2t',
            '.r5Ole23P',
            '.M0rK4QlG',
            '.iUCrKsbK',
            '.user-info .Avq4cm4k',
            '.comment-item-v2 .user span'
          ],
          content: [
            '.content', 
            '.comment-content', 
            '.text-content',
            '.comment-text',
            '.text',
            '.comment-item-text',
            '.comment p',
            '.comment-message',
            '.comment-info',
            '.message',
            '.comment div:not(.info):not(.user):not(.actions)',
            '.comment-wrapper div:not(.info):not(.avatar):not(.actions)',
            // PC版抖音特有的评论内容选择器
            '.X2jHbVhh',
            '.comment-item-v2 .content',
            '.WM0DtUw9 p',
            '.AiLUjvzO .content'
          ],
          time: [
            '.time', 
            '.date',
            '.comment-time',
            '.comment-date',
            '.publish-time',
            '.timestamp',
            '.created-at',
            '.posted-time',
            '.create-time',
            '.msg-create-time',
            // PC版抖音特有的时间选择器
            '.gkA8hAR1',
            '.Uehud6Vf',
            '.time-info',
            '.comment-item-v2 .time',
            '.WM0DtUw9 .time',
            '.AiLUjvzO .time'
          ],
          likeCount: [
            '.like-count', 
            '.digg-count',
            '.thumb-count',
            '.like-num',
            '.like',
            '.digg',
            '.comment-like',
            '.like span',
            '.digg span',
            '.praise-num',
            // PC版抖音特有的点赞数选择器
            '.mT0SUjcw span',
            '.digg-btn span',
            '.comment-item-v2 .digg-count',
            '.WM0DtUw9 .digg',
            '.AiLUjvzO .like-count'
          ]
        };
        
        const findWithSelectors = (element, selectorList) => {
          for (const selector of selectorList) {
            try {
              const elements = element.querySelectorAll(selector);
              const visibleElements = Array.from(elements).filter(el => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && 
                      el.offsetWidth > 0 && el.offsetHeight > 0;
              });
              
              if (visibleElements.length > 0) {
                return visibleElements[0].innerText.trim();
              }
            } catch (e) {
              console.error(`选择器 "${selector}" 出错:`, e);
            }
          }
          return '';
        };
        
        // 寻找评论项
        let commentItems = [];
        for (const selector of selectors.commentItem) {
          const items = document.querySelectorAll(selector);
          if (items.length > 0) {
            console.log(`找到评论项: ${items.length}个，使用选择器: ${selector}`);
            commentItems = items;
            break;
          }
        }
        
        if (commentItems.length === 0) {
          // 尝试寻找所有可能的评论容器
          const containers = document.querySelectorAll([
            '.comment-list',
            '.comments-list',
            '[data-e2e="comment-list"]',
            '.comment-container',
            '.ReplyList',
            '.BbQpYS1P',
            '.comment-panel',
            '.ESlRXJ16',
            '.comment-area',
            '[class*="CommentList"]',
            '[class*="commentList"]',
            '.modal-comment-list',
            '.modal-comments',
            // PC版抖音特有的评论容器
            '.EqzT2C1r',
            '#commentArea',
            '.comment-container',
            '.comment-mainContent',
            '[data-e2e="comment-content"]',
            '.comment-list-container', 
            '.commentWraper',
            '.video-comment-container'
          ].join(','));
          
          console.log(`找到 ${containers.length} 个评论容器`);
          
          // 对每个容器尝试所有评论项选择器
          for (const container of containers) {
            for (const selector of selectors.commentItem) {
              const items = container.querySelectorAll(selector);
              if (items.length > 0) {
                console.log(`在容器中找到评论项: ${items.length}个, 使用选择器: ${selector}`);
                commentItems = items;
                break;
              }
            }
            if (commentItems.length > 0) break;
          }
        }
        
        console.log(`共找到 ${commentItems.length} 个评论项`);
        
        // 提取每条评论的数据
        const extractedComments = Array.from(commentItems).slice(0, MAX_COMMENTS).map((item, index) => {
          // 提取每条评论的数据
          const username = findWithSelectors(item, selectors.username);
          const content = findWithSelectors(item, selectors.content);
          const timeStr = findWithSelectors(item, selectors.time);
          const likeCount = findWithSelectors(item, selectors.likeCount);
          
          // 记录日志
          console.log(`评论 ${index + 1}:`, {
            username: username || '未找到用户名',
            content: content ? (content.length > 20 ? content.substring(0, 20) + '...' : content) : '未找到内容',
            time: timeStr || '未找到时间',
            likeCount: likeCount || '未找到点赞数'
          });
          
          return {
            username: username || '未知用户',
            content: content || '无内容',
            time: timeStr || '',
            likeCount: likeCount || '0'
          };
        });
        
        console.log(`成功提取 ${extractedComments.length} 条评论`);
        return extractedComments;
      } catch (error) {
        console.error('提取评论失败:', error);
        return [];
      }
    });
    
    await browser.close();
    
    if (comments.length === 0) {
      throw new Error('未找到评论，请确保网页中评论区已加载');
    }
    
    // 返回评论数据
    const response = {
      success: true,
      data: {
        comments: comments.map(comment => ({
          username: comment.username,
          text: comment.content, // 将content字段映射为text
          likes: parseLikes(comment.likeCount), // 解析点赞数
          time: comment.time
        }))
      }
    };
    
    // 缓存结果
    cache.set(cacheKey, response, CACHE_TTL);
    res.json(response);
    
  } catch (error) {
    console.error('处理请求时出错:', error);
    console.error('错误详情:', error.stack);
    
    // 根据错误类型返回不同的状态码和信息
    let statusCode = 500;
    let errorMessage = '无法获取评论';
    
    if (error.message.includes('确保您在抖音视频页面')) {
      statusCode = 400;
      errorMessage = '无效的URL: ' + error.message;
    } else if (error.message.includes('未找到评论')) {
      statusCode = 404;
      errorMessage = '未找到评论: ' + error.message;
    } else if (error.message.includes('Navigation timeout')) {
      statusCode = 504;
      errorMessage = '页面加载超时: 请检查网络连接或目标网站是否可访问';
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      originalError: error.message
    });
  }
});

// 辅助函数：解析点赞数
function parseLikes(likesStr) {
  if (!likesStr) return 0;
  const str = likesStr.toString().toLowerCase().trim();
  
  try {
    // 处理带单位的数字
    if (str.includes('亿')) {
      const num = parseFloat(str.replace(/亿.*$/, ''));
      return Math.round(num * 100000000);
    }
    
    if (str.includes('w') || str.includes('万')) {
      const num = parseFloat(str.replace(/[万w].*$/, ''));
      return Math.round(num * 10000);
    }
    
    if (str.includes('k')) {
      const num = parseFloat(str.replace(/k.*$/, ''));
      return Math.round(num * 1000);
    }
    
    // 处理小数点
    if (str.includes('.')) {
      return Math.round(parseFloat(str.replace(/[^\d.]/g, '')));
    }
    
    // 处理普通数字
    const num = parseInt(str.replace(/[^\d]/g, ''));
    return isNaN(num) ? 0 : num;
  } catch (e) {
    console.error('解析点赞数出错:', likesStr, e);
    return 0;
  }
}

app.listen(port, '0.0.0.0', () => {
  console.log(`抖音评论API服务运行在 http://0.0.0.0:${port}`);
});

