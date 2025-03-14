
const express = require('express');
const puppeteer = require('puppeteer');
const NodeCache = require('node-cache');
const app = express();
const port = 3000;

// 常量定义
const CACHE_TTL = 3600; // 缓存有效期，单位：秒
const MAX_COMMENTS = 100; // 最大评论数量，设为更大值
const MAX_RETRIES = 2; // 最大重试次数
const RETRY_DELAY = 2000; // 重试间隔基础时间（毫秒）
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

app.get('/version', (req, res) => {
  res.json({ 
    version: '1.1.0',
    features: [
      '使用Chrome最新版本模拟浏览器',
      '增强反爬虫措施',
      '支持PC版抖音网站',
      '支持缓存减轻服务器负担',
      '多种评论区选择器自动适配',
      '自动重试机制',
      '自动处理移动版URL'
    ],
    updated: new Date().toISOString()
  });
});

const recentLogs = [];
const MAX_LOGS = 100;
function addLog(type, message, data = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    data
  };
  
  recentLogs.unshift(logEntry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.pop();
  }
  
  if (type === 'error') {
    console.error(`[${type.toUpperCase()}] ${message}`);
  } else {
    console.log(`[${type.toUpperCase()}] ${message}`);
  }
}

app.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const filtered = recentLogs.filter(log => {
    if (req.query.type && log.type !== req.query.type) return false;
    return true;
  }).slice(0, limit);
  
  res.json({
    logs: filtered,
    total: recentLogs.length,
    returned: filtered.length
  });
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
        '.video-action-item:nth-child(2)', // 视频操作区第二个按钮通常是评论
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

// 添加自动重试函数
async function withRetry(fn, maxRetries = MAX_RETRIES, retryDelay = RETRY_DELAY) {
  let retryCount = 0;
  let lastError = null;
  
  while (retryCount <= maxRetries) {
    try {
      if (retryCount > 0) {
        console.log(`第${retryCount}次重试...`);
      }
      
      return await fn();
    } catch (error) {
      lastError = error;
      console.error(`尝试失败 (${retryCount}/${maxRetries}): ${error.message}`);
      
      if (retryCount >= maxRetries) {
        break;
      }
      
      retryCount++;
      // 添加随机抖动，避免同步重试
      const jitter = Math.floor(Math.random() * 1000);
      const delay = retryDelay + jitter;
      console.log(`等待${delay}ms后重试...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

// 评论爬取API
app.get('/api/comments', async (req, res) => {
  let url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ 
      success: false,
      error: '必须提供url参数' 
    });
  }
  
  // 修复双重https://错误
  url = url.replace(/https?:\/\/https?:\/\//, 'https://');
  // 确保使用PC版域名
  url = url.replace(/m\.douyin\.com|v\.douyin\.com/, 'www.douyin.com');
  
  // 检查缓存
  const cacheKey = `comments:${url}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    console.log('从缓存返回评论数据:', url);
    return res.json(cachedResult);
  }
  
  try {
    console.log(`开始爬取评论: ${url}`);
    
    // 使用重试机制包装爬取过程
    const result = await withRetry(async () => {
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
          '--window-size=1920,1080',
          '--hide-scrollbars',
          '--no-zygote',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking'
        ],
        defaultViewport: {
          width: 1920,
          height: 1080
        }
      });
      
      try {
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
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
        });
        
        // 修改浏览器指纹，避免被检测为爬虫 - 增强版
        await page.evaluateOnNewDocument(() => {
          // 伪造插件信息，类似Chrome浏览器默认插件
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              const chromePlugins = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 }
              ];
              return Object.setPrototypeOf(chromePlugins, { 
                item: (i) => chromePlugins[i] || null,
                namedItem: (name) => chromePlugins.find(p => p.name === name) || null,
                refresh: () => {},
                length: chromePlugins.length
              });
            },
          });
          
          // 伪造mimeTypes
          Object.defineProperty(navigator, 'mimeTypes', {
            get: () => {
              const mimeTypes = [
                { type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: { name: 'Chrome PDF Plugin' } },
                { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: { name: 'Chrome PDF Viewer' } },
                { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable', enabledPlugin: { name: 'Native Client' } }
              ];
              return Object.setPrototypeOf(mimeTypes, {
                item: (i) => mimeTypes[i] || null,
                namedItem: (name) => mimeTypes.find(mt => mt.type === name) || null,
                length: mimeTypes.length
              });
            }
          });
          
          // 伪造语言信息，类似中文Chrome浏览器
          Object.defineProperty(navigator, 'languages', {
            get: () => ['zh-CN', 'zh', 'en-US', 'en'],
          });
          
          // 伪造更多导航器属性
          const navigatorProps = {
            deviceMemory: 8,
            hardwareConcurrency: 8,
            vendor: 'Google Inc.',
            vendorSub: '',
            doNotTrack: null,
            maxTouchPoints: 0,
            platform: 'Win32',
            appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }
          };
          
          for (const [key, value] of Object.entries(navigatorProps)) {
            try {
              Object.defineProperty(navigator, key, { get: () => value });
            } catch (e) {}
          }
          
          // 修复permissions API
          if (navigator.permissions) {
            const originalQuery = navigator.permissions.query;
            navigator.permissions.query = (parameters) => {
              if (parameters.name === 'notifications' || 
                  parameters.name === 'midi' || 
                  parameters.name === 'camera' || 
                  parameters.name === 'microphone') {
                return Promise.resolve({ state: 'prompt', onchange: null });
              }
              return originalQuery(parameters);
            };
          }
          
          // 伪造WebGL信息
          const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            // UNMASKED_VENDOR_WEBGL
            if (parameter === 37445) {
              return 'Intel Inc.';
            }
            // UNMASKED_RENDERER_WEBGL
            if (parameter === 37446) {
              return 'Intel Iris OpenGL Engine';
            }
            return originalGetParameter.call(this, parameter);
          };
          
          // 伪造Canvas指纹
          const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
            if (this.width === 0 && this.height === 0) {
              return originalToDataURL.call(this, type, quality);
            }
            
            // 添加轻微噪点，避免被识别出固定指纹
            const ctx = this.getContext('2d');
            if (ctx) {
              const imageData = ctx.getImageData(0, 0, this.width, this.height);
              const data = imageData.data;
              
              // 只处理实际绘制了内容的Canvas
              let hasContent = false;
              for (let i = 0; i < data.length; i += 4) {
                if (data[i+3] > 0) { // 有透明度的像素
                  hasContent = true;
                  break;
                }
              }
              
              if (hasContent) {
                for (let i = 0; i < data.length; i += 4) {
                  if (data[i+3] > 0) { // 只修改有内容的像素
                    // 随机微调RGB值
                    data[i] = Math.max(0, Math.min(255, data[i] + Math.floor(Math.random() * 3) - 1));
                    data[i+1] = Math.max(0, Math.min(255, data[i+1] + Math.floor(Math.random() * 3) - 1));
                    data[i+2] = Math.max(0, Math.min(255, data[i+2] + Math.floor(Math.random() * 3) - 1));
                  }
                }
                ctx.putImageData(imageData, 0, 0);
              }
            }
            
            return originalToDataURL.call(this, type, quality);
          };
          
          // 伪造更完整的Chrome特有功能
          window.chrome = {
            runtime: {
              id: undefined,
              connect: () => {},
              sendMessage: () => {}
            },
            loadTimes: () => ({
              firstPaintTime: 0,
              firstPaintAfterLoadTime: 0,
              requestTime: Date.now() / 1000,
              startLoadTime: Date.now() / 1000,
              commitLoadTime: Date.now() / 1000,
              finishDocumentLoadTime: Date.now() / 1000,
              finishLoadTime: Date.now() / 1000,
              navigationType: "Other",
            }),
            csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 9000, tran: 15 }),
            app: { isInstalled: false, getDetails: () => {}, getIsInstalled: () => false },
            webstore: { onInstallStageChanged: {}, onDownloadProgress: {} }
          };
          
          // 屏蔽Puppeteer特有的navigator.webdriver
          Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
          });
          
          // 伪造日期和性能指标
          const originalPerformance = window.performance;
          const originalGetEntries = window.performance.getEntries;
          window.performance.getEntries = function() {
            const result = originalGetEntries.apply(this, arguments);
            return result.filter(entry => !entry.name.includes('puppeteer'));
          };
          
          // 添加浏览器指纹中常用的一些函数
          window.innerWidth = 1920;
          window.innerHeight = 1080;
          window.outerWidth = 1920;
          window.outerHeight = 1080;
          window.screenX = Math.floor(Math.random() * 20);
          window.screenY = Math.floor(Math.random() * 20);
          
          // 重写toString方法，隐藏伪造痕迹
          const nativeToString = Function.prototype.toString;
          Function.prototype.toString = function() {
            if (this === Function.prototype.toString) return nativeToString.call(nativeToString);
            if (this === Object.defineProperty) return 'function defineProperty() { [native code] }';
            
            // 对已修改的函数特殊处理
            if (this === HTMLCanvasElement.prototype.toDataURL || 
                this === WebGLRenderingContext.prototype.getParameter ||
                this === navigator.permissions?.query) {
              return `function ${this.name || ''}() { [native code] }`;
            }
            
            return nativeToString.call(this);
          };
          
          // 一些检测函数已被伪装
          delete window.webdriver;
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
            // 更新的评论按钮选择器 - 最新PC版抖音 - 2024年版本
            const commentBtnSelectors = [
              // 最新版本选择器优先尝试
              '.O_IK7XKB', // 2024版评论按钮
              '.comment-public-container', // 新版评论容器
              '.video-info-detail .comment-count', // 视频详情评论数
              '.xcx-video-comment', // 小程序视频评论
              '.Akq9Uybc > span:nth-child(3)', // 操作栏第3个元素通常是评论
              
              // 通用选择器
              '.xgplayer-comment', // 播放器中的评论按钮
              '.UwR4pj2z', // 视频操作区评论按钮
              '.pzPe9k2f', // 数据统计中的评论项
              '.comment-icon', // 评论图标
              '[data-e2e="comment-icon"]', // 评论数据属性
              '[data-e2e="comment-count"]', // 评论数字
              '.video-action-item:nth-child(2)', // 视频操作区第二个按钮通常是评论
              '.aD0LGY4T', // 评论数字
              '.bar-container svg:nth-child(2)', // 工具栏中的第二个图标通常是评论
              '.yNI69HcY' // 新版视频操作栏
            ];
            
            // 记录页面中的所有评论相关元素，帮助调试
            const allCommentElements = Array.from(document.querySelectorAll('*')).filter(el => {
              const text = el.innerText || '';
              const classes = el.className || '';
              return (text.includes('评论') || text.includes('留言') || 
                     text.includes('条评论') || classes.includes('comment')) && 
                     el.offsetWidth > 0 && el.offsetHeight > 0;
            });
            
            console.log('找到的所有评论相关元素:', allCommentElements.map(el => ({
              text: el.innerText,
              tag: el.tagName,
              className: typeof el.className === 'string' ? el.className : (el.classList ? Array.from(el.classList).join(' ') : '')
            })));
            
            // 遍历选择器找评论按钮
            for (const selector of commentBtnSelectors) {
              const btns = document.querySelectorAll(selector);
              if (btns.length > 0) {
                console.log(`找到评论按钮: ${selector}, 数量: ${btns.length}`);
                for (const btn of btns) {
                  try {
                    console.log(`尝试点击评论按钮: ${selector}, 内容: ${btn.innerText || '无文本'}`);
                    
                    // 先触发鼠标悬停事件，模拟真实用户行为
                    const mouseoverEvent = new MouseEvent('mouseover', {
                      view: window,
                      bubbles: true,
                      cancelable: true
                    });
                    btn.dispatchEvent(mouseoverEvent);
                    
                    // 短暂等待模拟真实用户行为
                    let startTime = Date.now();
                    while(Date.now() - startTime < 150) {}
                    
                    // 触发更完整的鼠标事件序列
                    const events = ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'];
                    for (const eventType of events) {
                      const event = new MouseEvent(eventType, {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                        buttons: 1
                      });
                      btn.dispatchEvent(event);
                      // 小延迟使事件更自然 - 同样使用同步延迟
                      startTime = Date.now();
                      while(Date.now() - startTime < 50) {}
                    }
                    
                    console.log(`已点击评论按钮: ${selector}`);
                    return {success: true, selector};
                  } catch (err) {
                    console.error(`点击评论按钮失败: ${err.message}`);
                  }
                }
              }
            }
            
            return {success: false, message: '未找到评论按钮'};
          });
          
          console.log('点击评论按钮结果:', commentBtnClicked);
          
          // 如果第一次尝试未成功，尝试第二种方法：根据文本内容查找并点击
          if (!commentBtnClicked || !commentBtnClicked.success) {
            console.log('尝试第二种方法查找评论按钮...');
            
            const commentTextBtnClicked = await page.evaluate(() => {
              // 尝试寻找包含"评论"文字的任何元素 - 优先选择更可能的点击目标
              const commentTexts = ['评论', '条评论', '查看评论', '留言', '条留言'];
              
              for (const text of commentTexts) {
                // 获取所有元素
                const elements = Array.from(document.querySelectorAll('*'));
                
                // 筛选出包含特定文本且可见、可能可点击的元素
                const matchingElements = elements.filter(el => {
                  const hasText = el.innerText && el.innerText.includes(text);
                  const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
                  const isPossiblyClickable = 
                    el.tagName === 'BUTTON' || 
                    el.tagName === 'A' || 
                    el.getAttribute('role') === 'button' || 
                    el.onclick || 
                    (typeof el.className === 'string' && 
                      (el.className.includes('btn') || 
                       el.className.includes('button') || 
                       el.className.includes('click')));
                  return hasText && isVisible && isPossiblyClickable;
                });
                
                if (matchingElements.length > 0) {
                  console.log(`找到包含"${text}"的可点击元素:`, matchingElements.map(e => ({
                    tag: e.tagName,
                    text: e.innerText,
                    class: typeof e.className === 'string' ? e.className : (e.classList ? Array.from(e.classList).join(' ') : '')
                  })));
                  
                  try {
                    // 模拟真实用户点击
                    const element = matchingElements[0];
                    
                    // 先模拟鼠标悬停
                    const mouseoverEvent = new MouseEvent('mouseover', {
                      view: window,
                      bubbles: true,
                      cancelable: true
                    });
                    element.dispatchEvent(mouseoverEvent);
                    
                    // 短暂等待
                    let startWait = Date.now();
                    while(Date.now() - startWait < 200) {}
                    
                    // 执行点击
                    element.click();
                    console.log(`已点击包含"${text}"的元素`);
                    return {success: true, text: text};
                  } catch (err) {
                    console.error(`点击包含"${text}"的元素失败:`, err);
                  }
                }
              }
              
              // 第三种方法：尝试点击视频区域，这有时会触发评论面板
              try {
                console.log('尝试点击视频区域...');
                
                // 查找视频相关元素
                const videoElements = document.querySelectorAll('video, .xgplayer-video, .video-player, [data-e2e="video-player"]');
                if (videoElements.length > 0) {
                  const videoElement = videoElements[0];
                  videoElement.click();
                  console.log('已点击视频元素');
                  
                  // 短暂等待
                  let videoClickWait = Date.now();
                  while(Date.now() - videoClickWait < 500) {}
                  
                  // 点击视频下方区域，可能触发评论显示
                  document.elementFromPoint(
                    window.innerWidth / 2,
                    videoElement.getBoundingClientRect().bottom + 50
                  )?.click();
                  
                  return {success: true, method: 'video-area-click'};
                }
              } catch (err) {
                console.error('点击视频区域失败:', err);
              }
              
              return {success: false, message: '所有方法都未找到可点击的评论按钮'};
            });
            
            console.log('第二次尝试结果:', commentTextBtnClicked);
          }
          
          // 等待评论区加载 - 增加等待时间
          await page.waitForTimeout(8000); // 增加到8秒
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
              // 2024年最新版抖音评论项选择器
              '.comment-mainContent-item', // 主评论项
              '.VlUSW36j',  // 新版评论项基类
              '.Y0zLXVVj',  // 新版视频评论列表项
              '.n46QrfWK',  // 新版评论项容器
              '.comment-item-v2', // 新版评论项v2
              '[data-e2e="comment-list-item"]', // 评论列表项
              '.comment-item-container', // 评论项容器
              '.Qu86aRTU', // 新版评论内容
              
              // 通用备选评论项选择器
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
              const containerSelectors = [
                // 2024年最新版抖音评论容器
                '.comment-mainContent', // 主评论内容区
                '.CMU_z1Vn', // 新版评论列表容器 
                '.comment-public-container', // 新版公共评论容器
                '.lVaCGvQq', // 新版评论面板
                '#commentArea', // 评论区ID
                '[data-e2e="comment-list"]', // 官方评论列表标记
                '.comment-container', // 标准评论容器
                
                // 通用备选评论容器
                '.comment-list',
                '.comments-list',
                '.ReplyList',
                '.BbQpYS1P',
                '.comment-panel',
                '.ESlRXJ16',
                '.comment-area',
                '[class*="CommentList"]',
                '[class*="commentList"]',
                '.modal-comment-list',
                '.modal-comments',
                '.EqzT2C1r',
                '.commentWraper',
                '.video-comment-container',
                '.comment-list-container'
              ];
              
              // 改进的评论容器查找逻辑 - 使用数组连接而不是字符串
              const containers = document.querySelectorAll(containerSelectors.join(','));
              
              console.log(`找到 ${containers.length} 个评论容器`);
              
              if (containers.length > 0) {
                // 记录找到的容器信息
                console.log('评论容器详情:', Array.from(containers).map(c => ({
                  className: typeof c.className === 'string' ? c.className : (c.classList ? Array.from(c.classList).join(' ') : ''),
                  id: c.id,
                  children: c.children.length,
                  visible: c.offsetWidth > 0 && c.offsetHeight > 0
                })));
              }
              
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
              
              // 尝试更多方法激活评论区
              if (attempts % 5 === 0) { // 每5次尝试一次额外激活方法
                try {
                  // 点击评论区附近区域
                  const rect = document.body.getBoundingClientRect();
                  const centerX = rect.width / 2;
                  const bottomY = Math.min(rect.height - 200, window.innerHeight - 200);
                  document.elementFromPoint(centerX, bottomY)?.click();
                  
                  // 随机滚动以触发加载
                  window.scrollBy(0, Math.random() * 100 - 50);
                } catch (err) {
                  console.error('尝试额外激活评论区失败:', err);
                }
              }
              
              // 尝试滚动加载更多评论
              const commentContainers = document.querySelectorAll(containerSelectors.join(','));
              if (commentContainers.length > 0) {
                commentContainers.forEach(container => {
                  try {
                    container.scrollTop = container.scrollHeight;
                    console.log(`已滚动评论容器到底部: ${container.className || container.id}`);
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
            
            // 2024年最新PC版抖音评论选择器
            const selectors = {
              commentItem: [
                // 最新版首选选择器
                '.comment-mainContent-item', // 主评论项
                '.VlUSW36j',  // 新版评论项基类
                '.Y0zLXVVj',  // 新版视频评论列表项
                '.n46QrfWK',  // 新版评论项容器
                '.comment-item-v2', // 新版评论项v2
                '[data-e2e="comment-list-item"]', // 评论列表项
                '.comment-item-container', // 评论项容器
                
                // 通用备选选择器
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
                '.WM0DtUw9',
                '.comment-list-item',
                '.AiLUjvzO'
              ],
              username: [
                // 最新版首选选择器
                '.iCbgYSqA', // 2024用户名选择器
                '.FbQxz6vC', // 新版用户名
                '.user-name', // 标准用户名
                '[data-e2e="comment-user-name"]', // 官方用户名标记
                '.comment-user-name', // 评论用户名
                '.JYcxTg2t', // 新版用户名选择器
                '.r5Ole23P', // 另一个用户名样式
                '.M0rK4QlG', // 另一个用户名类
                
                // 通用备选选择器
                '.nickname',
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
                '.iUCrKsbK',
                '.user-info .Avq4cm4k',
                '.comment-item-v2 .user span'
              ],
              content: [
                // 最新版首选选择器
                '.Qu86aRTU', // 新版评论内容
                '.X2jHbVhh', // 评论文本
                '.comment-content', // 标准评论内容
                '[data-e2e="comment-content"]', // 官方评论内容标记
                '.content-text', // 内容文本
                
                // 通用备选选择器
                '.content', 
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
                '.comment-item-v2 .content',
                '.WM0DtUw9 p',
                '.AiLUjvzO .content'
              ],
              time: [
                // 最新版首选选择器
                '.TYGfQcFR', // 新版时间戳
                '.kqzEMvnb', // 另一个时间选择器
                '.comment-time', // 标准评论时间
                '.time-info', // 时间信息
                
                // 通用备选选择器
                '.time', 
                '.date',
                '.comment-date',
                '.publish-time',
                '.timestamp',
                '.created-at',
                '.posted-time',
                '.create-time',
                '.msg-create-time',
                '.gkA8hAR1',
                '.Uehud6Vf',
                '.comment-item-v2 .time',
                '.WM0DtUw9 .time',
                '.AiLUjvzO .time'
              ],
              likeCount: [
                // 最新版首选选择器
                '.gRi_qw_5', // 新版点赞计数
                '.digg-count', // 赞数量
                '.like-btn .count', // 赞按钮数量
                '.like-count-wrapper', // 点赞计数包装器
                '.praise-count', // 点赞数
                
                // 通用备选选择器
                '.like-count', 
                '.thumb-count',
                '.like-num',
                '.like',
                '.digg',
                '.comment-like',
                '.like span',
                '.digg span',
                '.praise-num',
                '.mT0SUjcw span',
                '.digg-btn span',
                '.comment-item-v2 .digg-count',
                '.WM0DtUw9 .digg',
                '.AiLUjvzO .like-count'
              ]
            };
            
            // 改进的查找元素内容函数
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
                    // 记录找到的元素，帮助调试
                    console.log(`找到内容，使用选择器: ${selector}，内容: ${visibleElements[0].innerText.trim().substring(0, 20)}${visibleElements[0].innerText.trim().length > 20 ? '...' : ''}`);
                    return visibleElements[0].innerText.trim();
                  }
                } catch (e) {
                  console.error(`选择器 "${selector}" 出错:`, e);
                }
              }
              
              // 如果没有找到，尝试查找任何文本节点
              try {
                const walkTextNodes = (el) => {
                  let text = '';
                  if (el.childNodes.length === 0 && el.textContent && el.textContent.trim()) {
                    return el.textContent.trim();
                  }
                  
                  for (const child of el.childNodes) {
                    if (child.nodeType === 3 && child.textContent && child.textContent.trim()) { // 文本节点
                      text += ' ' + child.textContent.trim();
                    } else if (child.nodeType === 1) { // 元素节点
                      text += ' ' + walkTextNodes(child);
                    }
                  }
                  return text.trim();
                };
                
                const text = walkTextNodes(element);
                if (text) {
                  console.log(`通过文本节点搜索找到内容: ${text.substring(0, 20)}${text.length > 20 ? '...' : ''}`);
                  return text;
                }
              } catch (e) {
                console.error('查找文本节点时出错:', e);
              }
              
              return '';
            };
            
            // 寻找评论项 - 遍历多个容器选择器
            const containerSelectors = [
              // 2024年最新版抖音评论容器
              '.comment-mainContent', // 主评论内容区
              '.CMU_z1Vn', // 新版评论列表容器 
              '.comment-public-container', // 新版公共评论容器
              '.lVaCGvQq', // 新版评论面板
              '#commentArea', // 评论区ID
              '[data-e2e="comment-list"]', // 官方评论列表标记
              '.comment-container', // 标准评论容器
              
              // 通用备选容器
              '.comment-list',
              '.comments-list',
              '.ReplyList',
              '.BbQpYS1P',
              '.comment-panel',
              '.ESlRXJ16',
              '.comment-area',
              '[class*="CommentList"]',
              '[class*="commentList"]',
              '.modal-comment-list',
              '.modal-comments',
              '.EqzT2C1r',
              '.commentWraper',
              '.video-comment-container',
              '.comment-list-container'
            ];
            
            // 首先尝试在容器中寻找评论
            let commentItems = [];
            
            for (const containerSelector of containerSelectors) {
              const containers = document.querySelectorAll(containerSelector);
              if (containers.length > 0) {
                console.log(`找到评论容器: ${containers.length}个, 使用选择器: ${containerSelector}`);
                
                // 遍历容器尝试找评论项
                for (const container of containers) {
                  for (const selector of selectors.commentItem) {
                    const items = container.querySelectorAll(selector);
                    if (items.length > 0) {
                      console.log(`在容器中找到评论项: ${items.length}个, 使用选择器: ${selector}`);
                      commentItems = Array.from(items);
                      break;
                    }
                  }
                  if (commentItems.length > 0) break;
                }
              }
              if (commentItems.length > 0) break;
            }
            
            // 如果在容器中没找到，尝试直接在整个页面中查找
            if (commentItems.length === 0) {
              for (const selector of selectors.commentItem) {
                const items = document.querySelectorAll(selector);
                if (items.length > 0) {
                  console.log(`直接在页面中找到评论项: ${items.length}个，使用选择器: ${selector}`);
                  commentItems = Array.from(items);
                  break;
                }
              }
            }
            
            console.log(`共找到 ${commentItems.length} 个评论项`);
            
            // 提取每条评论的数据
            const extractedComments = Array.from(commentItems).slice(0, MAX_COMMENTS).map((item, index) => {
              try {
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
              } catch (err) {
                console.error(`提取评论 ${index + 1} 时出错:`, err);
                return {
                  username: '提取失败',
                  content: '提取过程中出错',
                  time: '',
                  likeCount: '0'
                };
              }
            });
            
            console.log(`成功提取 ${extractedComments.length} 条评论`);
            return extractedComments;
          } catch (error) {
            console.error('提取评论失败:', error);
            throw error; // 让错误向上传递，以便更好地处理
          }
        });
        
        await browser.close();
        
        if (comments.length === 0) {
          throw new Error('未找到评论，请确保网页中评论区已加载');
        }
        
        // 返回评论数据
        return {
          comments: comments.map(comment => ({
            username: comment.username,
            text: comment.content, // 将content字段映射为text
            likes: parseLikes(comment.likeCount), // 解析点赞数
            time: comment.time
          })),
          count: comments.length,
          url: url
        };
      } catch (err) {
        // 确保关闭浏览器防止内存泄漏
        await browser.close();
        throw err;
      }
    });
    
    // 构造成功响应
    const response = {
      success: true,
      data: {
        ...result,
        url: url
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

    
    
