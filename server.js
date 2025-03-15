const express = require('express');
const puppeteer = require('puppeteer');
const NodeCache = require('node-cache');
const app = express();
const port = process.env.PORT || 3000;
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
    console.error('页面分析失败: ', error);
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
          '--disable-notifications',
          '--disable-extensions'
        ],
        defaultViewport: {
          width: 1920,
          height: 1080
        }
      });
      
      try {
        // 打开新页面
        const page = await browser.newPage();
        
        // 设置用户代理
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log('正在访问URL:', url);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('页面已加载');
        
        // 等待页面加载
        await page.waitForTimeout(3000);
        
        // 检查是否在视频页面
        const isVideoPage = await page.evaluate(() => {
          // 检查URL是否包含视频标识
          const isVideoUrl = window.location.href.includes('/video/') || 
                            window.location.href.includes('modal_id=');
          
          // 检查是否存在视频相关元素
          const videoElements = [
            '.xgplayer-container',
            '.video-player',
            '[data-e2e="video-player"]',
            '.video-container',
            'video',
            '.swiper-slide-active'
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
        
        // 尝试点击"暂不登录"按钮
        await page.evaluate(() => {
          const texts = ['暂不登录', '稍后再说', '暂不', '取消', '关闭'];
          
          for (const text of texts) {
            const elements = Array.from(document.querySelectorAll('*'));
            const matchingElements = elements.filter(el => {
              const hasText = el.innerText && el.innerText.includes(text);
              const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
              return hasText && isVisible;
            });
            
            if (matchingElements.length > 0) {
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
        
        // 使用我们新的评论提取函数
        const comments = await getCommentsFromPage(page, url, 50);
        
        // 截取评论区截图
        const screenshotPath = path.join(screenshotDir, `comments_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath });
        
        // 构造响应
        const response = {
          success: true,
          url: url,
          commentCount: comments.comments.length,
          comments: comments.comments.map(comment => ({
            index: comment.index,
            username: comment.username,
            content: comment.content,
            likes: comment.likeCount,
            originalLikeText: comment.originalLikeCount
          })),
          processTime: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          screenshots: [`/screenshots/${path.basename(screenshotPath)}`]
        };
        
        // 关闭浏览器
        await browser.close();
        
        // 保存到缓存
        cache.set(cacheKey, response, 3600); // 缓存1小时
        
        return response;
      } catch (error) {
        // 确保浏览器关闭
        await browser.close();
        throw error;
      }
    }, 2); // 最多重试2次
    
    return res.json(result);
    
  } catch (error) {
    console.error('处理评论请求时出错:', error);
    
    // 构造清晰的错误响应
    const errorResponse = {
      success: false,
      error: error.message,
      url: url,
      timestamp: new Date().toISOString(),
      processTime: Date.now() - startTime,
      screenshotPath: '/screenshots/error.png'
    };
    
    return res.status(500).json(errorResponse);
  }
});

// 启动服务器
app.listen(port, '0.0.0.0', () => {
  console.log(`抖音评论API服务运行在 http://0.0.0.0:${port}`);
});
    
// 全局错误处理设置
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常:', error);
  logger.error('堆栈:', error.stack);
  
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
    logger.error('内存不足错误，服务将在3秒后退出...');
    setTimeout(() => {
      process.exit(1);
    }, 3000);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', reason);
  
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
    
// 滚动加载更多评论
async function scrollForComments(page, maxComments = 50) {
  console.log('开始滚动加载更多评论...');
  
  let previousCommentCount = 0;
  let noChangeCount = 0;
  const maxScrollAttempts = 20;
  
  for (let i = 0; i < maxScrollAttempts; i++) {
    // 获取当前评论数量
    const currentCommentCount = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="comment-item"]',
        '.UuCzPLbi',
        '.comment-item',
        'div[class*="CommentItem"]'
      ];
      
      for (const selector of selectors) {
        const items = document.querySelectorAll(selector);
        if (items.length > 0) {
          return items.length;
        }
      }
      return 0;
    });
    
    console.log(`当前评论数量: ${currentCommentCount}, 滚动次数: ${i+1}/${maxScrollAttempts}`);
    
    // 如果评论数量达到目标或连续3次没有增加，则停止滚动
    if (currentCommentCount >= maxComments) {
      console.log(`已达到目标评论数量: ${currentCommentCount}`);
      break;
    }
    
    if (currentCommentCount === previousCommentCount) {
      noChangeCount++;
      if (noChangeCount >= 3) {
        console.log(`连续 ${noChangeCount} 次评论数量未增加，停止滚动`);
        break;
      }
    } else {
      noChangeCount = 0;
    }
    
    previousCommentCount = currentCommentCount;
    
    // 执行滚动
    await page.evaluate(() => {
      const selectors = [
        '[data-e2e="comment-list"]',
        '.comment-list',
        '.comments-list',
        '.comment-container',
        '.ReplyList',
        '.comment-mainContent'
      ];
      
      for (const selector of selectors) {
        const container = document.querySelector(selector);
        if (container) {
          container.scrollTop = container.scrollHeight;
          console.log(`已滚动评论容器: ${selector}`);
          return true;
        }
      }
      
      // 如果没找到特定容器，尝试滚动整个页面
      window.scrollTo(0, document.body.scrollHeight);
      console.log('已滚动整个页面');
      return true;
    });
    
    // 等待新评论加载
    await page.waitForTimeout(1000);
  }
}
    
// 评论提取主函数
async function getCommentsFromPage(page, url, MAX_COMMENTS = 50) {
  console.log('开始提取评论...');
  const startTime = Date.now();
  
  // 1. 滚动加载更多评论
  await scrollForComments(page, MAX_COMMENTS);
  
  // 2. 提取评论
  const comments = await page.evaluate((MAX_COMMENTS) => {
    console.log('开始评论提取...');
    
    // 定义点赞数解析函数
    function parseLikes(likesStr) {
      if (!likesStr) return 0;
      const str = likesStr.trim().toLowerCase();
      
      try {
        // 处理带单位的数字
        if (str.includes('亿')) {
          const num = parseFloat(str.replace(/亿.*$/, ''));
          return Math.round(num * 100000000);
        }
        
        if (str.includes('万')) {
          const num = parseFloat(str.replace(/万.*$/, ''));
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
    
    // 查找评论容器
    const commentContainerSelectors = [
      '.comment-list',
      '.comments-list',
      '[data-e2e="comment-list"]',
      '.comment-container',
      '.ReplyList',
      '.BbQpYS1P',
      '.comment-panel',
      '.ESlRXJ16',
      '.comment-area',
      '.comment-mainContent',
      '.comment-box'
    ];
    
    let commentContainer = null;
    for (const selector of commentContainerSelectors) {
      const container = document.querySelector(selector);
      if (container) {
        commentContainer = container;
        console.log(`找到评论容器，使用选择器: ${selector}`);
        break;
      }
    }
    
    if (!commentContainer) {
      console.error('未找到评论容器');
      return { comments: [], success: false, error: '未找到评论容器' };
    }
    
    // 查找评论项
    const commentItemSelectors = [
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
    
    let commentItems = [];
    for (const selector of commentItemSelectors) {
      const items = commentContainer.querySelectorAll(selector);
      if (items && items.length > 0) {
        commentItems = Array.from(items);
        console.log(`找到 ${items.length} 条评论，使用选择器: ${selector}`);
        break;
      }
    }
    
    if (commentItems.length === 0) {
      console.error('未找到评论项');
      return { comments: [], success: false, error: '未找到评论项' };
    }
    
    // 限制评论数量
    if (commentItems.length > MAX_COMMENTS) {
      console.log(`评论数量超过限制，将截取前 ${MAX_COMMENTS} 条`);
      commentItems = commentItems.slice(0, MAX_COMMENTS);
    }
    
    // 提取评论数据
    const extractedComments = [];
    
    for (let i = 0; i < commentItems.length; i++) {
      const item = commentItems[i];
      try {
        console.log(`提取第 ${i+1} 条评论...`);
        
        // 提取用户名
        const usernameSelectors = [
          '[data-e2e="comment-user-name"]',
          '.user-name',
          '.username',
          '.author-name',
          '.comment-user',
          '.user-nickname',
          'span.xtTwhlGw',
          '.arnSiSbK span',
          '.arnSiSbK.xtTwhlGw span span span span'
        ];
        
        let username = '未知用户';
        for (const selector of usernameSelectors) {
          const el = item.querySelector(selector);
          if (el && el.textContent.trim()) {
            username = el.textContent.trim();
            break;
          }
        }
        
        // 提取评论内容
        const contentSelectors = [
          '[data-e2e="comment-content"]',
          '.comment-content',
          '.content-text',
          '.comment-text',
          '.text-content',
          '.WFJiGxr7',
          '.C7LroK_h .WFJiGxr7',
          'p'
        ];
        
        let content = '';
        for (const selector of contentSelectors) {
          const el = item.querySelector(selector);
          if (el && el.textContent.trim()) {
            content = el.textContent.trim();
            break;
          }
        }
        
        // 如果选择器没找到，尝试用文本节点搜索
        if (!content) {
          const textNodes = [];
          // 获取所有文本节点
          const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (text && text.length > 5 && !username.includes(text)) {
              textNodes.push(text);
            }
          }
          
          if (textNodes.length > 0) {
            // 取最长的文本作为评论内容
            content = textNodes.reduce((longest, current) => 
              current.length > longest.length ? current : longest, '');
            console.log(`通过文本节点搜索找到内容: ${content.substring(0, 20)}...`);
          }
        }
        
        // 提取点赞数
        const likeSelectors = [
          '.xZhLomAs span',
          '[class*="like-count"]',
          '[class*="digg-count"]',
          '[data-e2e="like-count"]',
          '.like-num',
          '.comment-like-count',
          '[class*="like"] span',
          '[class*="digg"] span',
          'svg[class*="like"] + span',
          '.LVdHm6YR',
          '.NR5VYR6L'
        ];
        
        let likeCount = '0';
        for (const selector of likeSelectors) {
          const el = item.querySelector(selector);
          if (el && el.textContent.trim()) {
            likeCount = el.textContent.trim();
            console.log(`找到点赞数: ${likeCount}, 使用选择器: ${selector}`);
            break;
          }
        }
        
        // 如果用户名和内容都不为空，才添加到结果中
        if (content && content.length > 1) {
          extractedComments.push({
            username,
            content,
            likeCount: parseLikes(likeCount),
            originalLikeCount: likeCount,
            index: i + 1
          });
        }
      } catch (err) {
        console.error(`提取评论 ${i+1} 时出错:`, err);
      }
    }
    
    console.log(`成功提取 ${extractedComments.length} 条评论`);
    
    // 根据点赞数排序
    extractedComments.sort((a, b) => b.likeCount - a.likeCount);
    
    return {
      comments: extractedComments,
      success: extractedComments.length > 0,
      selectors: {
        container: commentContainer ? commentContainer.className : '',
        items: commentItems.length > 0 ? commentItems[0].className : ''
      }
    };
  }, MAX_COMMENTS);
  
  return comments;
}
    
    
