const express = require('express');
const puppeteer = require('puppeteer');
const NodeCache = require('node-cache');
const app = express();
const port = 3000;
const fs = require('fs');
const path = require('path');

// 常量定义
const CACHE_TTL = 3600; // 缓存有效期，单位：秒
const MAX_COMMENTS = 250; // 最大评论数量，增加到250确保能收集到足够多评论
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

// 创建截图目录（如果不存在）
const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) {
  try {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log(`创建截图目录: ${screenshotDir}`);
  } catch (err) {
    console.error(`创建截图目录失败: ${err.message}`);
  }
}

// 添加静态文件服务中间件，用于访问截图
app.use('/screenshots', express.static(screenshotDir));
console.log(`已启用截图访问路径: http://localhost:${port}/screenshots/`);

// 设置请求日志中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

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
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    type,
    message,
    data
  };
  
  recentLogs.unshift(logEntry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.pop();
  }
  
  // 根据日志级别选择合适的输出方法
  if (type === 'error' || type === 'critical') {
    console.error(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
    // 对于严重错误，尝试写入文件
    try {
      fs.appendFileSync(
        path.join(__dirname, 'error.log'), 
        `[${timestamp}] [${type.toUpperCase()}] ${message}\n${JSON.stringify(data, null, 2)}\n\n`
      );
    } catch (e) {
      console.error('写入错误日志文件失败:', e);
    }
  } else if (type === 'warning') {
    console.warn(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
  } else {
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
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
    
    // 构造成功响应，添加更详细的信息和截图信息
    const response = {
      success: true,
      data: {
        ...result,
        url: url,
        summary: {
          extractedAt: new Date().toISOString(),
          processingTime: `${Date.now() - startTime}ms`,  // 添加处理时间
          source: "www.douyin.com",
          commentCount: result.count,
          hasLikes: result.comments.some(c => c.likes > 0),
          topLikeCount: Math.max(...result.comments.map(c => c.likes || 0))
        },
        debug: {
          rawData: result.raw_data,
          firstCommentDebug: result.comments[0]?.debug || null
        },
        screenshots: result.screenshots || []
      }
    };
    
    // 添加错误处理和日志
    console.log(`成功爬取 ${result.count} 条评论，按点赞数排序返回前 ${Math.min(result.count, 10)} 条`);
    if (result.count > 0) {
      console.log('排名第一的评论:', 
        result.comments[0] ? 
        `${result.comments[0].username.substring(0, 10)}...: ${result.comments[0].text.substring(0, 20)}...(${result.comments[0].likes}赞)` : 
        '无评论');
    }
    
    // 记录截图信息
    if (result.screenshots && result.screenshots.length > 0) {
      console.log('截图链接:');
      result.screenshots.forEach(screenshot => {
        console.log(`- ${screenshot.url}`);
      });
    }
    
    // 缓存结果
    cache.set(cacheKey, response, CACHE_TTL);
    res.json(response);
    
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

// 辅助函数：自动滚动页面加载更多评论
async function autoScroll(page) {
  console.log('开始自动滚动页面加载评论...');
  
  // 先往下滚动到评论区
  await page.evaluate(() => {
    window.scrollBy(0, window.innerHeight * 2);
  });
  await page.waitForTimeout(2000);
  
  // 处理登录提示
  await handleLoginPrompt(page);
  
  return page.evaluate(async (MAX_COMMENTS) => {
    // 设置最大滚动次数，增加到20次以加载更多评论
    const MAX_SCROLL_COUNT = 20;
    
    // 主评论列表选择器数组，兼容不同版本的抖音
    const commentContainerSelectors = [
      '.UJ3DpJTM', // 2025年版抖音评论区
      '.RzKJpP2S', // 2025年评论列表
      '.OxhJfHrE', // 公共评论区
      '.KzPVzIKf', // 评论面板
      '.comment-mainContent',
      '.CMU_z1Vn',
      '.comment-public-container',
      '.lVaCGvQq',
      '#commentArea',
      '[data-e2e="comment-list"]',
      '.comment-container',
      '.comment-list',
      '.comments-list',
      '.ReplyList',
      '.BbQpYS1P',
      '.comment-panel',
      '.ESlRXJ16'
    ];

    // 实现自动滚动逻辑
    let lastCommentCount = 0;
    let noChangeCount = 0;
    let allComments = [];

    for (let i = 0; i < MAX_SCROLL_COUNT; i++) {
      console.log(`正在滚动页面，第${i + 1}次`);
      
      // 滚动到页面底部
      window.scrollTo(0, document.body.scrollHeight);
      
      // 等待页面加载更多评论
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 尝试找到评论容器
      for (const selector of commentContainerSelectors) {
        const containers = document.querySelectorAll(selector);
        if (containers.length > 0) {
          console.log(`找到${containers.length}个评论容器，使用选择器: ${selector}`);
        }
      }
      
      // 获取当前评论数量（临时检查用）
      let currentComments = [];
      for (const selector of commentContainerSelectors) {
        const containers = document.querySelectorAll(selector);
        if (containers.length > 0) {
          // 找到评论容器，尝试获取所有评论
          for (const container of containers) {
            const commentItems = Array.from(container.querySelectorAll('*')).filter(el => 
              el.textContent && el.textContent.includes('分享') && el.textContent.includes('回复')
            );
            if (commentItems.length > 0) {
              console.log(`在容器中找到${commentItems.length}个可能的评论项`);
              currentComments.push(...commentItems);
            }
          }
        }
      }
      
      // 检查是否有新评论加载
      if (currentComments.length <= lastCommentCount) {
        noChangeCount++;
        if (noChangeCount >= 3) {
          console.log('连续3次没有新评论加载，停止滚动');
          break;
        }
      } else {
        noChangeCount = 0;
        lastCommentCount = currentComments.length;
        allComments = currentComments;
        
        // 如果已收集到200个以上评论，提前停止滚动
        if (currentComments.length >= 200) {
          console.log(`已收集到${currentComments.length}个评论，足够排序使用，停止滚动`);
          break;
        }
      }
    }
    
    console.log(`滚动完成，共找到 ${allComments.length} 个评论项`);
    
    // 只返回前MAX_COMMENTS条评论
    return allComments.slice(0, MAX_COMMENTS);
  }, MAX_COMMENTS);
}

// 处理登录提示的辅助函数
async function handleLoginPrompt(page) {
  try {
    console.log('检查并处理登录提示...');
    
    // 检查是否存在登录提示
    const hasLoginPrompt = await page.evaluate(() => {
      const loginTexts = ['登录后', '立即登录', '暂不登录'];
      for (const text of loginTexts) {
        const elements = Array.from(document.querySelectorAll('*')).filter(
          el => el.textContent && el.textContent.includes(text) && 
               el.offsetWidth > 0 && el.offsetHeight > 0
        );
        if (elements.length > 0) return true;
      }
      return false;
    });

    if (hasLoginPrompt) {
      console.log('检测到登录提示，点击"暂不登录"');
      await page.evaluate(() => {
        const skipButtons = Array.from(document.querySelectorAll('button, a, div'))
          .filter(el => el.textContent && el.textContent.includes('暂不登录'));
        if (skipButtons.length > 0) {
          console.log('找到"暂不登录"按钮，点击它');
          skipButtons[0].click();
        }
      });
      await page.waitForTimeout(1500);
    }
  } catch (err) {
    console.log('处理登录提示时出错:', err);
  }
}

// 辅助函数：解析点赞数
function parseLikes(likeText) {
  if (!likeText) return 0;
  
  try {
    // 如果接收到的是对象，检查是否有value属性
    if (typeof likeText === 'object' && likeText !== null) {
      if (likeText.value) {
        likeText = likeText.value;
      } else if (likeText.found === false) {
        return 0; // 如果标记为未找到，返回0
      } else {
        return 0; // 未找到有效数据
      }
    }
    
    // 清理输入文本，去除非数字、小数点和"万"以外的字符
    const cleanText = likeText.toString().replace(/[^\d\.万]/g, '');
    
    // 检查是否为空字符串
    if (!cleanText || cleanText === '') {
      return 0;
    }
    
    // 处理"万"单位
    if (cleanText.includes('万')) {
      // 提取数字部分
      const numMatch = cleanText.match(/([\d\.]+)万/);
      if (numMatch && numMatch[1]) {
        return Math.round(parseFloat(numMatch[1]) * 10000);
      } else {
        // 尝试另一种模式
        const altMatch = cleanText.match(/([\d\.]+)/);
        if (altMatch && altMatch[1]) {
          return Math.round(parseFloat(altMatch[1]) * 10000);
        }
      }
      return 10000; // 如果仅有"万"字但无法提取数字，默认为1万
    }
    
    // 处理可能的科学计数法
    if (cleanText.includes('e') || cleanText.includes('E')) {
      return Math.round(parseFloat(cleanText));
    }
    
    // 处理纯数字
    const num = parseInt(cleanText, 10);
    if (!isNaN(num)) {
      return num;
    }
    
    // 处理小数
    const floatNum = parseFloat(cleanText);
    if (!isNaN(floatNum)) {
      return Math.round(floatNum);
    }
    
    // 如果以上都失败，尝试提取任何数字
    const numMatch = cleanText.match(/\d+/);
    if (numMatch) {
      return parseInt(numMatch[0], 10);
    }
    
    return 0;
  } catch (err) {
    console.error('解析点赞数出错:', err, '原始文本:', likeText);
    return 0;
  }
}

// 提取评论中的点赞数的辅助函数
function extractLikeCount(commentElement) {
  const results = {
    found: false,
    value: '0',
    method: '',
    allAttempts: []
  };
  
  try {
    // 尝试多种方式提取点赞数
    
    // 1. 首先尝试查找常见的点赞数容器
    const likeSelectors = [
      // 2026年新增选择器
      '.L38CqmDW', // 新增-2026版点赞容器
      '.x_IwK3lT', // 新增-2026版点赞按钮
      '.u5_kfBzn', // 新增-2026版点赞计数
      // 2025年最新选择器
      '.UJliHmHF', // 新增-最新点赞数容器
      '.z8n8JKcz', // 新增-点赞计数器 
      '.VsAqHUEt', // 新增-点赞按钮
      // 2025新版选择器
      'svg + span', 
      '.VT7pNbtS', // 2025年点赞计数
      '.H7vvGdTQ', // 2025年点赞数容器
      '.Bc8CPX9M', // 2025年点赞按钮
      '.qzGBUiME', // 可能的新版点赞容器
      // 图片中看到的点赞数选择器（红色框内）
      'svg:nth-child(3) + span', // 评论内第三个SVG图标后的数字（可能是点赞）
      '.comment-action span', // 评论操作区的数字
      // 通用选择器
      '[class*="like-count"]',
      '[class*="digg"]', 
      '[class*="vote"]',
      '.like-count',
      '.digg-count',
      // 相邻元素选择器
      'svg[class*="like"] + span',
      'svg[class*="digg"] + span',
      '.like span',
      '.digg span',
      // 更多通用选择器
      '.action-number',
      '[class*="action"] span',
      '[class*="praise"] span',
      '[class*="thumb"] span',
      // 尝试使用更通用的属性选择器
      '[class*="like"]',
      '[class*="digg"]',
      '[class*="vote"]',
      '[class*="praise"]'
    ];
    
    for (const selector of likeSelectors) {
      try {
        const elements = commentElement.querySelectorAll(selector);
        
        // 记录尝试信息
        const attempt = {
          selector,
          count: elements.length,
          elements: Array.from(elements).slice(0, 3).map(el => ({
            text: el.textContent.trim(),
            html: el.outerHTML.substring(0, 100) + (el.outerHTML.length > 100 ? '...' : ''),
            className: el.className
          }))
        };
        
        results.allAttempts.push(attempt);
        
        for (const el of elements) {
          const text = el.textContent.trim();
          // 匹配数字和可能的"万"字
          const match = text.match(/(\d+(\.\d+)?)(万)?/);
          if (match) {
            console.log(`找到点赞数: ${match[0]}, 使用选择器: ${selector}`);
            results.found = true;
            results.value = match[0];
            results.method = `selector:${selector}`;
            return results;
          }
        }
      } catch (err) {
        console.error(`使用选择器 "${selector}" 提取点赞数时出错:`, err);
        results.allAttempts.push({
          selector,
          error: err.toString()
        });
      }
    }
    
    // 2. 尝试从评论文本中提取
    const commentText = commentElement.textContent;
    
    // 匹配常见模式
    const patterns = [
      /(\d+(\.\d+)?万?)\s*分享/, // "123 分享"或"1.2万 分享"
      /(\d+(\.\d+)?万?)\s*回复/, // "123 回复"或"1.2万 回复"
      /·[^·]*?(\d+(\.\d+)?万?)/, // 点号后的数字，通常是点赞数
      /赞\s*(\d+(\.\d+)?万?)/, // "赞 123"或"赞 1.2万"
      /(\d+(\.\d+)?万?)\s*赞/, // "123 赞"或"1.2万 赞"
      /[\d\.]+万?[^\d]*$/ // 评论末尾的数字
    ];
    
    for (const pattern of patterns) {
      try {
        const match = commentText.match(pattern);
        if (match && match[1]) {
          console.log(`从评论文本中使用模式 ${pattern} 提取到点赞数: ${match[1]}`);
          results.found = true;
          results.value = match[1];
          results.method = `pattern:${pattern}`;
          return results;
        }
      } catch (err) {
        console.error(`使用模式 "${pattern}" 提取点赞数时出错:`, err);
        results.allAttempts.push({
          pattern: pattern.toString(),
          error: err.toString()
        });
      }
    }
    
    // 3. 其他策略：查找只包含数字的短文本元素
    try {
      const textNodes = Array.from(commentElement.querySelectorAll('*'))
        .filter(el => {
          try {
            const text = el.textContent.trim();
            // 仅包含数字和可能的"万"字的短文本
            return text.length < 10 && /^(\d+(\.\d+)?(万)?)$/.test(text);
          } catch (err) {
            return false;
          }
        });
      
      if (textNodes.length > 0) {
        // 对于多个匹配，尝试找出最可能是点赞数的元素（通常位于评论底部区域）
        // 按元素在评论中的垂直位置排序，偏下方的更可能是点赞数
        textNodes.sort((a, b) => {
          try {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            return rectB.top - rectA.top; // 排序，底部元素优先
          } catch (err) {
            return 0;
          }
        });
        
        results.allAttempts.push({
          method: 'textNodeFilter',
          count: textNodes.length,
          nodes: textNodes.slice(0, 5).map(node => node.textContent) // 最多5个
        });
        
        console.log(`找到可能的点赞数元素: ${textNodes[0].textContent}`);
        results.found = true;
        results.value = textNodes[0].textContent;
        results.method = 'textNodePosition';
        return results;
      }
    } catch (err) {
      console.error('查找数字文本节点时出错:', err);
      results.allAttempts.push({
        method: 'textNodeFilter',
        error: err.toString()
      });
    }
    
    // 4. 尝试通过图片识别 - 记录图像元素的存在
    try {
      const images = commentElement.querySelectorAll('img, svg');
      if (images.length > 0) {
        results.allAttempts.push({
          method: 'images',
          count: images.length,
          types: Array.from(images).map(img => img.tagName)
        });
      }
    } catch (err) {
      console.error('检查图像元素时出错:', err);
    }
    
    return results;
  } catch (err) {
    console.error('提取点赞数主函数出错:', err);
    results.allAttempts.push({
      method: 'main',
      error: err.toString()
    });
    return results;
  }
}

// 改进safeIncludes函数实现，提高健壮性
function safeIncludes(obj, searchString) {
  // 检查类型并安全地调用includes方法
  if (!obj) return false;
  
  if (typeof obj === 'string') {
    return obj.includes(searchString);
  } else if (Array.isArray(obj)) {
    return obj.includes(searchString);
  } else if (obj && typeof obj.contains === 'function') {
    // DOM元素的classList对象
    return obj.contains(searchString);
  } else if (obj && typeof obj.toString === 'function') {
    // 处理其他可能的对象类型
    return obj.toString().includes(searchString);
  }
  return false;
}

// 增强的浏览器指纹伪装函数
async function setupBrowserEvasion(page) {
  await page.evaluateOnNewDocument(() => {
    // 修改Navigator属性
    const originalNavigator = window.navigator;
    
    // 伪装浏览器指纹信息
    Object.defineProperties(Navigator.prototype, {
      // 使用一致的设备信息 - 模拟Windows 10上的Chrome
      userAgent: {
        get: function() {
          return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        }
      },
      appVersion: {
        get: function() {
          return '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        }
      },
      platform: {
        get: function() {
          return 'Win32';
        }
      },
      hardwareConcurrency: {
        get: function() {
          return 8; // 大多数用户的CPU核心数在4-8之间
        }
      },
      deviceMemory: {
        get: function() {
          return 8; // 大多数用户的内存在8GB左右
        }
      },
      language: {
        get: function() {
          return 'zh-CN';
        }
      },
      languages: {
        get: function() {
          return ['zh-CN', 'zh', 'en-US', 'en'];
        }
      }
    });
    
    // 修改WebGL指纹
    const getParameterProxyHandler = {
      apply: function(target, ctx, args) {
        const param = args[0];
        
        // 伪装RENDERER和VENDOR信息
        if (param === 37445) { // RENDERER
          return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)';
        }
        
        if (param === 37446) { // VENDOR
          return 'Google Inc. (NVIDIA)';
        }
        
        return target.apply(ctx, args);
      }
    };
    
    // 如果WebGL可用，修改其参数
    try {
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = new Proxy(getParameter, getParameterProxyHandler);
    } catch (e) {
      console.log('WebGL 不可用或已被修改');
    }
    
    // 模拟插件
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        return [
          {
            0: {
              type: 'application/pdf',
              suffixes: 'pdf',
              description: 'Portable Document Format'
            },
            name: 'Chrome PDF Plugin',
            filename: 'internal-pdf-viewer',
            description: 'Portable Document Format',
            length: 1
          },
          {
            0: {
              type: 'application/pdf',
              suffixes: 'pdf',
              description: 'Portable Document Format'
            },
            name: 'Chrome PDF Viewer',
            filename: 'internal-pdf-viewer',
            description: 'Portable Document Format',
            length: 1
          },
          {
            0: {
              type: 'application/x-google-chrome-pdf',
              suffixes: 'pdf',
              description: 'Portable Document Format'
            },
            name: 'PDF Viewer',
            filename: 'internal-pdf-viewer',
            description: 'Portable Document Format',
            length: 1
          }
        ];
      }
    });
    
    // 删除Automation指纹
    delete window.navigator.webdriver;
    
    // 模拟常见的屏幕分辨率
    Object.defineProperty(window.screen, 'width', { get: () => 1920 });
    Object.defineProperty(window.screen, 'height', { get: () => 1080 });
    Object.defineProperty(window.screen, 'availWidth', { get: () => 1920 });
    Object.defineProperty(window.screen, 'availHeight', { get: () => 1040 });
    Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24 });
    
    console.log('浏览器指纹保护已启用');
  });
}

// 评论爬取API
app.get('/api/comments', async (req, res) => {
  let url = req.query.url;
  
  // 记录处理开始时间
  const startTime = Date.now();
  
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
      // 启动浏览器
      const browser = await puppeteer.launch({
        headless: 'new', // 使用新版无头模式
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
          '--hide-scrollbars',
          '--disable-notifications',
          '--disable-extensions',
          '--ignore-certificate-errors',
          '--disable-web-security'
        ],
        defaultViewport: {
          width: 1920,
          height: 1080
        }
      });
      
      try {
        // 打开新页面
        const page = await browser.newPage();
        
        // 应用指纹伪装
        await setupBrowserEvasion(page);
        
        // 设置请求拦截
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          // 拦截图片和字体请求以加速加载
          if (req.resourceType() === 'image' || req.resourceType() === 'font') {
            req.abort();
          } else {
            req.continue();
          }
        });
        
        // 设置额外的头信息
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'sec-ch-ua': '"Chromium";v="120", "Google Chrome";v="120", "Not-A.Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"'
        });
        
        // 设置随机用户代理
        const userAgent = getRandomUserAgent();
        console.log('使用随机用户代理:', userAgent);
        await page.setUserAgent(userAgent);
        
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
              try {
                const text = el.innerText || '';
                const classes = el.className || '';
                let classListArray = [];
                
                // 安全获取classList
                if (el.classList) {
                  try {
                    classListArray = Array.from(el.classList);
                  } catch (err) {
                    console.error('获取classList时出错:', err);
                  }
                }
                
                return (safeIncludes(text, '评论') || 
                        safeIncludes(text, '留言') || 
                        safeIncludes(text, '条评论') || 
                        safeIncludes(classes, 'comment') ||
                        classListArray.some(c => safeIncludes(c, 'comment'))) && 
                        el.offsetWidth > 0 && el.offsetHeight > 0;
              } catch (error) {
                console.error('过滤评论元素时出错:', error);
                return false;
              }
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
        
        // 如果comments仍然未定义，在这里捕获并处理
        let comments = [];
        try {
          // 实现扩展程序的waitForComments逻辑
          comments = await page.evaluate(async (MAX_COMMENTS) => {
            try {
              console.log('开始提取评论...');
              
              // 2025年最新PC版抖音评论选择器
              const selectors = {
                commentItem: [
                  // 2025最新版首选选择器 
                  '.ZrN9g8J3', // 2025版评论容器项
                  '.xPUO2JV5', // 2025版评论项
                  '.OipmUZLO', // 2025版评论内容容器
                  '.YvccbM1F', // 2025版评论项包装器
                  '.RHiEl2W9', // 2025版评论项新布局
                  // 以前版本的选择器（兼容性）
                  '.comment-mainContent-item', // 主评论项
                  '.VlUSW36j',  // 新版评论项基类
                  '.Y0zLXVVj',  // 新版视频评论列表项
                  '.n46QrfWK',  // 新版评论项容器
                  '.comment-item-v2', // 新版评论项v2
                  '[data-e2e="comment-list-item"]', // 评论列表项
                  '.comment-item-container', // 评论项容器
                  '.Qu86aRTU', // 新版评论内容
                  
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
                  // 2025最新选择器
                  '.ZH1HPMS7', // 2025年用户名选择器 
                  '.R9sH4NwP', // 2025年新版用户名
                  '.uHGrB1fP', // 2025年账号名称
                  // 以前版本的选择器
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
                  // 2025最新选择器
                  '.QT5MuNL7', // 2025年评论内容
                  '.TjxZ9KZY', // 2025年评论文本容器
                  '.PyZcBKFb', // 2025年评论文本
                  // 以前版本的选择器
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
                  // 2025最新选择器
                  '.LaB7V9HW', // 2025年时间戳
                  '.Hs8JdGWC', // 2025年时间信息
                  '.NxAbJMuK', // 2025年发布时间
                  // 以前版本的选择器
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
                  // 2025最新选择器
                  '.VT7pNbtS', // 2025年点赞计数
                  '.H7vvGdTQ', // 2025年点赞数容器
                  '.Bc8CPX9M', // 2025年点赞按钮
                  // 以前版本的选择器
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
                const results = { 
                  found: false, 
                  value: '', 
                  usedSelector: '',
                  allAttempts: [] 
                };
                
                for (const selector of selectorList) {
                  try {
                    const elements = element.querySelectorAll(selector);
                    const visibleElements = Array.from(elements).filter(el => {
                      const style = window.getComputedStyle(el);
                      return style.display !== 'none' && style.visibility !== 'hidden' && 
                            el.offsetWidth > 0 && el.offsetHeight > 0;
                    });
                    
                    const attempt = {
                      selector,
                      count: elements.length,
                      visibleCount: visibleElements.length,
                      content: visibleElements.length > 0 ? visibleElements[0].innerText.trim() : 'none'
                    };
                    
                    results.allAttempts.push(attempt);
                    
                    if (visibleElements.length > 0) {
                      // 记录找到的元素，帮助调试
                      console.log(`找到内容，使用选择器: ${selector}，内容: ${visibleElements[0].innerText.trim().substring(0, 20)}${visibleElements[0].innerText.trim().length > 20 ? '...' : ''}`);
                      results.found = true;
                      results.value = visibleElements[0].innerText.trim();
                      results.usedSelector = selector;
                      return results;
                    }
                  } catch (e) {
                    console.error(`选择器 "${selector}" 出错:`, e);
                    results.allAttempts.push({
                      selector,
                      error: e.toString()
                    });
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
                    results.found = true;
                    results.value = text;
                    results.usedSelector = 'textNode';
                    return results;
                  }
                } catch (e) {
                  console.error('查找文本节点时出错:', e);
                  results.allAttempts.push({
                    selector: 'textNode',
                    error: e.toString()
                  });
                }
                
                return results;
              };
              
              // 改进点赞数提取函数
              const extractLikeCount = (commentElement) => {
                const results = {
                  found: false,
                  value: '0',
                  method: '',
                  allAttempts: []
                };
                
                try {
                  // 尝试多种方式提取点赞数
                  
                  // 1. 首先尝试查找常见的点赞数容器
                  const likeSelectors = [
                    // 新增2025年最新选择器
                    '.UJliHmHF', // 新增-最新点赞数容器
                    '.z8n8JKcz', // 新增-点赞计数器 
                    '.VsAqHUEt', // 新增-点赞按钮
                    // 2025新版选择器
                    'svg + span', 
                    '.VT7pNbtS', // 2025年点赞计数
                    '.H7vvGdTQ', // 2025年点赞数容器
                    '.Bc8CPX9M', // 2025年点赞按钮
                    '.qzGBUiME', // 可能的新版点赞容器
                    // 图片中看到的点赞数选择器（红色框内）
                    'svg:nth-child(3) + span', // 评论内第三个SVG图标后的数字
                    '.comment-action span', // 评论操作区的数字
                    // 通用选择器
                    '[class*="like-count"]',
                    '[class*="digg"]', 
                    '[class*="vote"]',
                    '.like-count',
                    '.digg-count',
                    // 相邻元素选择器
                    'svg[class*="like"] + span',
                    'svg[class*="digg"] + span',
                    '.like span',
                    '.digg span',
                    // 更多通用选择器
                    '.action-number',
                    '[class*="action"] span',
                    '[class*="praise"] span',
                    '[class*="thumb"] span',
                    // 尝试使用更通用的属性选择器
                    '[class*="like"]',
                    '[class*="digg"]',
                    '[class*="vote"]',
                    '[class*="praise"]'
                  ];
                  
                  for (const selector of likeSelectors) {
                    try {
                      const elements = commentElement.querySelectorAll(selector);
                      const attempt = {
                        selector,
                        count: elements.length,
                        elements: Array.from(elements).map(el => ({
                          text: el.textContent.trim(),
                          html: el.outerHTML.substring(0, 100),
                          className: el.className
                        })).slice(0, 3) // 最多保存3个结果
                      };
                      
                      results.allAttempts.push(attempt);
                      
                      for (const el of elements) {
                        const text = el.textContent.trim();
                        // 匹配数字和可能的"万"字
                        const match = text.match(/(\d+(\.\d+)?)(万)?/);
                        if (match) {
                          console.log(`找到点赞数: ${match[0]}, 使用选择器: ${selector}`);
                          results.found = true;
                          results.value = match[0];
                          results.method = `selector:${selector}`;
                          return results;
                        }
                      }
                    } catch (err) {
                      console.error(`使用选择器 "${selector}" 提取点赞数时出错:`, err);
                      results.allAttempts.push({
                        selector,
                        error: err.toString()
                      });
                    }
                  }
                  
                  // 2. 尝试从评论文本中提取
                  const commentText = commentElement.textContent;
                  
                  // 匹配常见模式
                  const patterns = [
                    /(\d+(\.\d+)?万?)\s*分享/, // "123 分享"或"1.2万 分享"
                    /(\d+(\.\d+)?万?)\s*回复/, // "123 回复"或"1.2万 回复"
                    /·[^·]*?(\d+(\.\d+)?万?)/, // 点号后的数字，通常是点赞数
                    /赞\s*(\d+(\.\d+)?万?)/, // "赞 123"或"赞 1.2万"
                    /(\d+(\.\d+)?万?)\s*赞/, // "123 赞"或"1.2万 赞"
                    /[\d\.]+万?[^\d]*$/ // 评论末尾的数字
                  ];
                  
                  for (const pattern of patterns) {
                    try {
                      const match = commentText.match(pattern);
                      if (match && match[1]) {
                        console.log(`从评论文本中使用模式 ${pattern} 提取到点赞数: ${match[1]}`);
                        results.found = true;
                        results.value = match[1];
                        results.method = `pattern:${pattern}`;
                        return results;
                      }
                    } catch (err) {
                      console.error(`使用模式 "${pattern}" 提取点赞数时出错:`, err);
                      results.allAttempts.push({
                        pattern: pattern.toString(),
                        error: err.toString()
                      });
                    }
                  }
                  
                  // 3. 其他策略：查找只包含数字的短文本元素
                  try {
                    const textNodes = Array.from(commentElement.querySelectorAll('*'))
                      .filter(el => {
                        const text = el.textContent.trim();
                        // 仅包含数字和可能的"万"字的短文本
                        return text.length < 10 && /^(\d+(\.\d+)?(万)?)$/.test(text);
                      });
                    
                    if (textNodes.length > 0) {
                      // 对于多个匹配，尝试找出最可能是点赞数的元素（通常位于评论底部区域）
                      // 按元素在评论中的垂直位置排序，偏下方的更可能是点赞数
                      textNodes.sort((a, b) => {
                        const rectA = a.getBoundingClientRect();
                        const rectB = b.getBoundingClientRect();
                        return rectB.top - rectA.top; // 排序，底部元素优先
                      });
                      
                      results.allAttempts.push({
                        method: 'textNodeFilter',
                        count: textNodes.length,
                        nodes: textNodes.slice(0, 5).map(node => node.textContent) // 最多5个
                      });
                      
                      console.log(`找到可能的点赞数元素: ${textNodes[0].textContent}`);
                      results.found = true;
                      results.value = textNodes[0].textContent;
                      results.method = 'textNodePosition';
                      return results;
                    }
                  } catch (err) {
                    console.error('查找数字文本节点时出错:', err);
                    results.allAttempts.push({
                      method: 'textNodeFilter',
                      error: err.toString()
                    });
                  }
                  
                  // 4. 尝试通过图片识别 - 记录图像元素的存在
                  try {
                    const images = commentElement.querySelectorAll('img, svg');
                    if (images.length > 0) {
                      results.allAttempts.push({
                        method: 'images',
                        count: images.length,
                        types: Array.from(images).map(img => img.tagName)
                      });
                    }
                  } catch (err) {
                    console.error('检查图像元素时出错:', err);
                  }
                  
                  return results;
                } catch (err) {
                  console.error('提取点赞数主函数出错:', err);
                  results.allAttempts.push({
                    method: 'main',
                    error: err.toString()
                  });
                  return results;
                }
              };
              
              // 寻找评论项 - 遍历多个容器选择器
              const containerSelectors = [
                // 2025年最新版抖音评论容器
                '.UJ3DpJTM', // 2025版主评论区
                '.RzKJpP2S', // 2025版评论列表容器 
                '.OxhJfHrE', // 2025版公共评论区
                '.KzPVzIKf', // 2025版评论面板新布局
                // 以前版本的容器
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
              
              // 如果没有找到评论项，记录更详细的信息
              if (commentItems.length === 0) {
                return {
                  error: true,
                  errorType: 'NO_COMMENTS_FOUND',
                  message: '未找到评论项',
                  debugInfo: {
                    url: window.location.href,
                    title: document.title,
                    bodyText: document.body.innerText.substring(0, 1000) + '...',
                    containerSelectors: containerSelectors,
                    commentSelectors: selectors.commentItem
                  }
                };
              }
              
              // 提取每条评论的数据
              const extractedComments = Array.from(commentItems).slice(0, MAX_COMMENTS).map((item, index) => {
                try {
                  // 提取每条评论的数据 - 使用改进的提取函数
                  const username = findWithSelectors(item, selectors.username);
                  const content = findWithSelectors(item, selectors.content);
                  const timeStr = findWithSelectors(item, selectors.time);
                  
                  // 使用新的点赞数提取函数
                  const likeCount = extractLikeCount(item);
                  
                  // 记录日志
                  console.log(`评论 ${index + 1}:`, {
                    username: username.found ? username.value : '未找到用户名',
                    content: content.found ? (content.value.length > 20 ? content.value.substring(0, 20) + '...' : content.value) : '未找到内容',
                    time: timeStr.found ? timeStr.value : '未找到时间',
                    likeCount: likeCount.found ? likeCount.value : '未找到点赞数'
                  });
                  
                  // 返回包含更多原始信息的结构
                  return {
                    username: username.found ? username.value : '未知用户',
                    content: content.found ? content.value : '无内容',
                    time: timeStr.found ? timeStr.value : '',
                    likeCount: likeCount.found ? likeCount.value : '0',
                    // 添加调试信息
                    debug: {
                      usernameDetails: username,
                      contentDetails: content,
                      timeDetails: timeStr,
                      likeCountDetails: likeCount,
                      commentHtml: item.outerHTML.substring(0, 500) + (item.outerHTML.length > 500 ? '...' : '')
                    }
                  };
                } catch (err) {
                  console.error(`提取评论 ${index + 1} 时出错:`, err);
                  return {
                    username: '提取失败',
                    content: `提取过程中出错: ${err.message || err}`,
                    time: '',
                    likeCount: '0',
                    error: err.toString(),
                    // 尝试保存评论HTML，即使提取失败
                    debug: {
                      error: err.toString(),
                      stack: err.stack,
                      commentHtml: item ? (item.outerHTML ? item.outerHTML.substring(0, 500) + '...' : '无HTML') : '无元素'
                    }
                  };
                }
              });
              
              console.log(`成功提取 ${extractedComments.length} 条评论`);
              
              // 在浏览器环境中定义parseLikes函数
              function parseLikes(likeText) {
                if (!likeText) return 0;
                
                try {
                  // 清理输入文本，去除非数字、小数点和"万"以外的字符
                  const cleanText = likeText.toString().replace(/[^\d\.万]/g, '');
                  
                  // 处理"万"单位
                  if (cleanText.includes('万')) {
                    return parseFloat(cleanText.replace('万', '')) * 10000;
                  }
                  
                  // 处理可能的科学计数法
                  if (cleanText.includes('e') || cleanText.includes('E')) {
                    return Math.round(parseFloat(cleanText));
                  }
                  
                  // 处理纯数字
                  const num = parseInt(cleanText, 10);
                  if (!isNaN(num)) {
                    return num;
                  }
                  
                  // 处理小数
                  const floatNum = parseFloat(cleanText);
                  if (!isNaN(floatNum)) {
                    return Math.round(floatNum);
                  }
                  
                  // 如果以上都失败，尝试提取任何数字
                  const numMatch = cleanText.match(/\d+/);
                  if (numMatch) {
                    return parseInt(numMatch[0], 10);
                  }
                  
                  return 0;
                } catch (err) {
                  console.error('解析点赞数出错:', err, '原始文本:', likeText);
                  return 0;
                }
              }
              
              // 按点赞数排序评论
              const sortedComments = extractedComments.sort((a, b) => {
                try {
                  const likesA = parseLikes(a.likeCount);
                  const likesB = parseLikes(b.likeCount);
                  return likesB - likesA; // 倒序排列
                } catch (err) {
                  console.error('排序评论时出错:', err);
                  return 0; // 保持原有顺序
                }
              });
              
              // 完善的排序日志
              console.log('按点赞数排序完成，前三条评论点赞数：');
              try { 
                console.log(sortedComments.slice(0, 3).map(c => {
                  try {
                    return `${c.likeCount || '0'} (${parseLikes(c.likeCount)})`;
                  } catch (err) {
                    return `${c.likeCount || '0'} (解析出错)`;
                  }
                }).join(', ')); 
              } catch (err) {
                console.error('输出排序结果时出错:', err);
              }
              
              // 只返回排序后的前10条评论，但包含更多调试信息
              return {
                success: true,
                comments: sortedComments.slice(0, 10),
                rawCommentCount: commentItems.length,
                extractedCommentCount: extractedComments.length,
                pageUrl: window.location.href,
                pageTitle: document.title,
                timestamp: new Date().toISOString()
              };
            } catch (error) {
              console.error('提取评论失败:', error);
              return {
                success: false,
                error: error.toString(),
                stack: error.stack,
                url: window.location.href,
                title: document.title
              }; // 返回错误信息而不是抛出异常
            }
          }, MAX_COMMENTS);
        
          // 提取评论后检查结果
          if (!comments || comments.length === 0) {
            // 记录详细日志以便调试
            console.error('评论提取结果为空，可能原因：1.评论区未正确加载 2.选择器不匹配 3.页面结构变化');
            await browser.close();
            throw new Error('未找到评论，请确保网页中评论区已加载');
          }
          
          // 关闭浏览器
          await browser.close();
        
          // 返回评论数据
          return {
            comments: comments.comments.map(comment => ({
              username: comment.username,
              text: comment.content, // 将content字段映射为text
              likes: parseLikes(comment.likeCount), // 解析点赞数
              time: comment.time,
              raw_like_count: comment.likeCount, // 保留原始点赞数文本
              debug: comment.debug // 保留调试信息
            })),
            count: comments.comments.length,
            url: url,
            raw_data: {
              rawCommentCount: comments.rawCommentCount,
              extractedCommentCount: comments.extractedCommentCount,
              pageUrl: comments.pageUrl,
              pageTitle: comments.pageTitle
            },
            screenshots: comments.screenshots.map(path => ({
              path,
              url: path.replace('/root/douyin-comments-api', '/screenshots')
            }))
          };
        } catch (error) {
          // 确保任何情况下浏览器都会被关闭
          console.error('评论提取过程中出错:', error);
          
          try {
            // 检查浏览器是否已关闭，如果未关闭则关闭
            if (browser && typeof browser.close === 'function') {
              await browser.close().catch(err => {
                console.error('关闭浏览器时出错:', err);
              });
            }
          } catch (closingError) {
            console.error('尝试关闭浏览器时出错:', closingError);
          }
          
          throw error;
        }
      } catch (err) {
        // 确保关闭浏览器防止内存泄漏
        try {
          if (browser && typeof browser.close === 'function') {
            await browser.close().catch(closeErr => {
              console.error('关闭浏览器时出错:', closeErr);
            });
          }
        } catch (browserCloseErr) {
          console.error('尝试关闭浏览器时出错:', browserCloseErr);
        }
        
        throw err;
      }
    });
    
    // 截图功能 - 无论评论提取成功还是失败都进行截图
    const timestamp = Date.now();
    const screenshotPathBase = `${screenshotDir}/douyin_${timestamp}`;
    const screenshotPaths = [];
    
    try {
      // 保存当前页面截图
      const fullPagePath = `${screenshotPathBase}_full.png`;
      await page.screenshot({ path: fullPagePath, fullPage: true });
      screenshotPaths.push(fullPagePath);
      console.log(`已保存完整页面截图: ${fullPagePath}`);
      
      // 尝试滚动并截图评论区
      await page.evaluate(() => {
        // 尝试找到评论区容器并滚动
        const commentSelectors = [
          '.comment-mainContent',
          '.CMU_z1Vn',
          '.UJ3DpJTM',
          '#commentArea',
          '[data-e2e="comment-list"]'
        ];
        
        for (const selector of commentSelectors) {
          const container = document.querySelector(selector);
          if (container) {
            container.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
          }
        }
        
        // 如果找不到具体的评论区，尝试滚动到页面中间
        window.scrollTo(0, document.body.scrollHeight / 2);
        return false;
      });
      
      // 等待滚动完成
      await page.waitForTimeout(1000);
      
      // 再截一张评论区截图
      const commentsPath = `${screenshotPathBase}_comments.png`;
      await page.screenshot({ path: commentsPath });
      screenshotPaths.push(commentsPath);
      console.log(`已保存评论区截图: ${commentsPath}`);
      
    } catch (screenshotError) {
      console.error('截图时出错:', screenshotError);
    }
    
    // 检查评论提取结果
    if (!comments.success || !comments.comments || comments.comments.length === 0) {
      const errorPath = `${screenshotPathBase}_error.png`;
      try {
        await page.screenshot({ path: errorPath, fullPage: true });
        screenshotPaths.push(errorPath);
        console.log(`已保存错误状态截图: ${errorPath}`);
      } catch (e) {
        console.error('保存错误截图时出错:', e);
      }
      
      // 记录详细日志以便调试
      console.error('评论提取结果有误:', JSON.stringify(comments, null, 2));
      await browser.close();
      
      // 返回错误信息和截图路径
      throw new Error(JSON.stringify({
        error: true,
        message: '未找到评论或提取失败',
        details: comments,
        screenshots: screenshotPaths.map(path => ({
          path,
          url: `http://localhost:${port}${path.replace(screenshotDir, '/screenshots')}`
        }))
      }));
    }
    
    // 关闭浏览器
    await browser.close();
    
    // 返回处理结果并保存到缓存
    const responseData = {
      success: true,
      url: url,
      summary: {
        total: comments.comments.length,
        hasLikes: comments.comments.some(c => c.likeCount && c.likeCount !== '提取失败'),
        processTime: Date.now() - startTime,
        commentCount: comments.comments.length,
      },
      comments: comments.comments.map(comment => ({
        username: comment.username,
        text: comment.text || comment.content, // 兼容text或content字段
        likes: parseLikes(comment.likeCount),
        time: comment.time,
        raw_like_count: comment.likeCount, // 保留原始点赞数文本
        like_method: comment.likeMethod, // 保留点赞数提取方法信息
      })).sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10), // 按点赞数排序，取前10条
      debug: {
        raw: comments.debug || {},
        firstComment: comments.comments.length > 0 ? comments.comments[0] : null,
        commentCount: comments.comments.length,
        totalProcessingTime: `${Date.now() - startTime}ms`,
        timestamp: new Date().toISOString()
      },
      screenshots: screenshotPaths.map(path => `http://localhost:${port}/${path}`)
    };
    
    // 记录成功日志
    addLog('success', `成功爬取 ${comments.comments.length} 条评论`, {
      url,
      commentCount: comments.comments.length,
      topComment: responseData.comments.length > 0 ? {
        likes: responseData.comments[0].likes,
        text: responseData.comments[0].text.substring(0, 50) + (responseData.comments[0].text.length > 50 ? '...' : '')
      } : null,
      processingTime: `${Date.now() - startTime}ms`,
      screenshots: responseData.screenshots
    });
    
    // 保存到缓存
    cache.set(cacheKey, responseData);
    
    return responseData;
    
  } catch (error) {
    console.error('处理请求时出错:', error);
    console.error('错误详情:', error.stack);
    
    // 解析错误信息，检查是否包含截图信息
    let errorObj = error;
    let screenshots = [];
    let errorDetails = null;
    
    try {
      // 检查错误是否包含JSON数据
      const errorStr = error.message || error.toString();
      if (typeof errorStr === 'string' && (errorStr.startsWith('{') || errorStr.includes('{"error":'))) {
        try {
          errorObj = JSON.parse(errorStr.substring(errorStr.indexOf('{')));
          screenshots = errorObj.screenshots || [];
          errorDetails = errorObj.details;
        } catch (e) {
          console.error('解析错误JSON失败:', e);
        }
      }
    } catch (parseErr) {
      console.error('处理错误对象时出错:', parseErr);
    }
    
    // 根据错误类型返回不同的状态码和信息
    let statusCode = 500;
    let errorMessage = '无法获取评论';
    let errorCategory = 'UNKNOWN_ERROR';
    
    if (error.message && error.message.includes('确保您在抖音视频页面')) {
      statusCode = 400;
      errorMessage = '无效的URL: ' + error.message;
      errorCategory = 'INVALID_URL';
    } else if (error.message && error.message.includes('未找到评论')) {
      statusCode = 404;
      errorMessage = '未找到评论: ' + error.message;
      errorCategory = 'NO_COMMENTS_FOUND';
    } else if (error.message && error.message.includes('Navigation timeout')) {
      statusCode = 504;
      errorMessage = '页面加载超时: 请检查网络连接或目标网站是否可访问';
      errorCategory = 'TIMEOUT';
    } else if (error.message && error.message.includes('net::ERR_')) {
      statusCode = 503;
      errorMessage = '网络错误: ' + error.message;
      errorCategory = 'NETWORK_ERROR';
    } else if (error.message && error.message.includes('context')) {
      statusCode = 500;
      errorMessage = '浏览器上下文错误: 可能是服务器资源不足';
      errorCategory = 'BROWSER_ERROR';
    }
    
    // 记录错误日志
    addLog('error', errorMessage, {
      url,
      errorCategory,
      timestamp: new Date().toISOString(),
      processingTime: `${Date.now() - startTime}ms`
    });
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      errorCategory,
      originalError: error.message,
      url: url,
      timestamp: new Date().toISOString(),
      screenshots: screenshots,
      errorDetails: errorDetails
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`抖音评论API服务运行在 http://0.0.0.0:${port}`);
});

// 全局错误处理设置
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  console.error('堆栈:', error.stack);
  
  // 记录日志
  addLog('critical', `未捕获的异常: ${error.message}`, {
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  
  // 对于某些可恢复的错误，我们可以继续运行
  // 但严重错误（如内存不足）可能需要重启
  if (error.message.includes('ENOMEM') || 
      error.message.includes('堆内存不足') || 
      error.message.includes('out of memory')) {
    console.error('内存不足错误，服务将在3秒后退出...');
    setTimeout(() => {
      process.exit(1);
    }, 3000);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
  
  // 记录日志
  addLog('warning', `未处理的Promise拒绝: ${reason}`, {
    promise: String(promise),
    timestamp: new Date().toISOString()
  });
});

// 错误日志API端点
app.get('/api/logs', (req, res) => {
  const logType = req.query.type || 'all';
  const limit = parseInt(req.query.limit || '50');
  
  let filteredLogs = recentLogs;
  
  if (logType !== 'all') {
    filteredLogs = recentLogs.filter(log => log.type === logType);
  }
  
  res.json({
    logs: filteredLogs.slice(0, limit),
    total: filteredLogs.length,
    types: ['success', 'error', 'warning', 'info', 'critical'].map(type => ({
      type,
      count: recentLogs.filter(log => log.type === type).length
    }))
  });
});

// 健康检查和API文档路由
app.get('/', (req, res) => {
  const docsHTML = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>抖音评论爬取API文档</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        line-height: 1.6;
        max-width: 1000px;
        margin: 0 auto;
        padding: 20px;
        color: #333;
      }
      h1 {
        color: #ff2d55;
        border-bottom: 2px solid #eee;
        padding-bottom: 10px;
      }
      h2 {
        color: #007aff;
        margin-top: 30px;
      }
      .endpoint {
        background: #f5f5f7;
        padding: 15px;
        border-radius: 8px;
        margin-bottom: 20px;
      }
      .method {
        font-weight: bold;
        color: #34c759;
      }
      code {
        background: #eee;
        padding: 2px 5px;
        border-radius: 4px;
        font-family: monospace;
      }
      pre {
        background: #282c34;
        color: #abb2bf;
        padding: 15px;
        border-radius: 8px;
        overflow-x: auto;
      }
      .status {
        display: inline-block;
        padding: 5px 10px;
        border-radius: 20px;
        font-size: 14px;
        font-weight: bold;
      }
      .status.up {
        background: #34c759;
        color: white;
      }
      .status.warn {
        background: #ffcc00;
        color: black;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 20px 0;
      }
      th, td {
        padding: 10px;
        border: 1px solid #ddd;
        text-align: left;
      }
      th {
        background-color: #f5f5f7;
      }
      .screenshot {
        max-width: 100%;
        border-radius: 8px;
        margin-top: 20px;
        box-shadow: 0 4px 10px rgba(0,0,0,0.1);
      }
    </style>
  </head>
  <body>
    <h1>抖音评论爬取API文档</h1>
    <div>
      <p>服务状态: <span class="status up">运行中</span></p>
      <p>版本: ${require('puppeteer/package.json').version} (Puppeteer)</p>
      <p>服务启动时间: ${new Date().toLocaleString()}</p>
    </div>
    
    <h2>API接口</h2>
    <div class="endpoint">
      <p><span class="method">GET</span> /api/comments</p>
      <p>获取抖音视频评论数据，按点赞数排序。</p>
      <h3>请求参数:</h3>
      <table>
        <tr>
          <th>参数名</th>
          <th>类型</th>
          <th>必须</th>
          <th>描述</th>
        </tr>
        <tr>
          <td>url</td>
          <td>string</td>
          <td>是</td>
          <td>抖音视频URL，如https://www.douyin.com/video/7123456789012345678</td>
        </tr>
      </table>
      <h3>响应示例:</h3>
      <pre>{
  "success": true,
  "url": "https://www.douyin.com/video/7123456789012345678",
  "summary": {
    "total": 42,
    "hasLikes": true,
    "processTime": 12345,
    "commentCount": 42
  },
  "comments": [
    {
      "username": "抖音用户123456",
      "text": "这个视频太有意思了！",
      "likes": 1234,
      "time": "3天前",
      "raw_like_count": "1234",
      "like_method": "selector:.VT7pNbtS"
    },
    ...
  ],
  "debug": { ... },
  "screenshots": [
    "http://localhost:3000/screenshots/douyin_1234567890_full.png",
    "http://localhost:3000/screenshots/douyin_1234567890_comments.png"
  ]
}</pre>
    </div>
    
    <div class="endpoint">
      <p><span class="method">GET</span> /api/logs</p>
      <p>获取服务日志信息。</p>
      <h3>请求参数:</h3>
      <table>
        <tr>
          <th>参数名</th>
          <th>类型</th>
          <th>必须</th>
          <th>描述</th>
        </tr>
        <tr>
          <td>type</td>
          <td>string</td>
          <td>否</td>
          <td>日志类型，可选值：all, success, error, warning, info, critical。默认为all</td>
        </tr>
        <tr>
          <td>limit</td>
          <td>number</td>
          <td>否</td>
          <td>返回日志条数，默认50</td>
        </tr>
      </table>
    </div>
    
    <div class="endpoint">
      <p><span class="method">GET</span> /health</p>
      <p>健康检查接口。</p>
    </div>
    
    <div class="endpoint">
      <p><span class="method">GET</span> /version</p>
      <p>获取版本信息。</p>
    </div>
    
    <h2>使用示例</h2>
    <pre>fetch('http://localhost:3000/api/comments?url=https://www.douyin.com/video/7123456789012345678')
  .then(response => response.json())
  .then(data => console.log(data));</pre>
    
    <h2>注意事项</h2>
    <ul>
      <li>请求频率不宜过高，建议使用缓存结果</li>
      <li>每次请求会返回截图，可用于调试</li>
      <li>如果遇到反爬虫措施，可能需要更新选择器</li>
    </ul>
    
  </body>
  </html>
  `;
  res.send(docsHTML);
});

// 增强的健康检查
app.get('/health', (req, res) => {
  // 计算服务运行时间
  const uptime = process.uptime();
  const uptimeHours = Math.floor(uptime / 3600);
  const uptimeMinutes = Math.floor((uptime % 3600) / 60);
  const uptimeSeconds = Math.floor(uptime % 60);
  
  // 获取内存使用情况
  const memoryUsage = process.memoryUsage();
  const memoryUsageMB = {
    rss: (memoryUsage.rss / 1024 / 1024).toFixed(2) + 'MB',
    heapTotal: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2) + 'MB',
    heapUsed: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2) + 'MB',
    external: (memoryUsage.external / 1024 / 1024).toFixed(2) + 'MB'
  };
  
  // 获取CPU使用情况
  const cpuUsage = process.cpuUsage();
  
  // 检查磁盘空间
  const screenshotDirSize = fs.existsSync(screenshotDir) ? 
    fs.readdirSync(screenshotDir).length : 0;
  
  res.json({
    status: 'ok',
    version: '1.2.0',
    timestamp: new Date().toISOString(),
    uptime: `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`,
    memory: memoryUsageMB,
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system
    },
    storage: {
      screenshots: screenshotDirSize
    },
    cache: {
      size: cache.keys().length,
      stats: cache.getStats()
    }
  });
});
    
    
