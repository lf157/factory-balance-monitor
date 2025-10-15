const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 生成管理员密码（服务器启动时只生成一次）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (() => {
  const randomPwd = Math.floor(100000 + Math.random() * 900000).toString();
  console.log('⚠️ 警告：未设置 ADMIN_PASSWORD 环境变量');
  console.log('📌 临时管理员密码：', randomPwd);
  console.log('💡 建议：设置环境变量 ADMIN_PASSWORD 来使用固定密码');
  return randomPwd;
})();

// 加密密钥（用于加密 API Keys）
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || ADMIN_PASSWORD + 'factory2024';
const ALGORITHM = 'aes-256-gcm';

// 加密函数
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const salt = crypto.randomBytes(64);
  const key = crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 2145, 32, 'sha512');
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

// 解密函数
function decrypt(encdata) {
  try {
    const bData = Buffer.from(encdata, 'base64');
    const salt = bData.slice(0, 64);
    const iv = bData.slice(64, 80);
    const tag = bData.slice(80, 96);
    const text = bData.slice(96);
    
    const key = crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 2145, 32, 'sha512');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    return decipher.update(text, 'binary', 'utf8') + decipher.final('utf8');
  } catch (error) {
    console.error('解密失败:', error.message);
    return null;
  }
}

// 优先使用 Blob 存储，如果不存在则使用原存储适配器
let storage;
try {
  storage = require('./lib/blob-storage');
} catch (error) {
  console.log('使用原存储适配器');
  storage = require('./lib/storage');
}

// 包装存储适配器方法，添加加密/解密
const loadConfig = async () => {
  const config = await storage.loadConfig();
  // 解密 API Keys
  if (config.apiKeys) {
    config.apiKeys = config.apiKeys.map(key => {
      if (key.key && key.key.startsWith('enc:')) {
        // 已加密的 key
        const decrypted = decrypt(key.key.substring(4));
        if (decrypted) {
          key.key = decrypted;
        }
      }
      return key;
    });
  }
  return config;
};

const saveConfig = async (config) => {
  // 加密 API Keys 后保存
  const encryptedConfig = JSON.parse(JSON.stringify(config));
  if (encryptedConfig.apiKeys) {
    encryptedConfig.apiKeys = encryptedConfig.apiKeys.map(key => {
      if (key.key && !key.key.startsWith('enc:')) {
        // 未加密的 key，进行加密
        key.key = 'enc:' + encrypt(key.key);
      }
      return key;
    });
  }
  return storage.saveConfig(encryptedConfig);
};

const loadHistory = () => storage.loadHistory();
const saveHistory = (historyData) => storage.saveHistory(historyData);

// 统一的请求体解析函数
function parseRequestBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      callback(null, data);
    } catch (error) {
      callback(new Error('Invalid JSON'));
    }
  });
}

// 统一的错误响应函数
function sendErrorResponse(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ 
    success: false, 
    error: message 
  }));
}

// 统一的成功响应函数
function sendSuccessResponse(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ 
    success: true,
    ...data 
  }));
}

// 查询单个 API Key 的使用情况
async function fetchApiKeyData(keyConfig) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'app.factory.ai',
      path: '/api/organization/members/chat-usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${keyConfig.key}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error(`❌ Key ${keyConfig.id} 查询失败: HTTP ${res.statusCode}`);
            resolve({
              ...keyConfig,
              error: `HTTP ${res.statusCode}`,
              valid: false
            });
            return;
          }

          const apiData = JSON.parse(data);
          if (!apiData.usage || !apiData.usage.standard) {
            resolve({
              ...keyConfig,
              error: 'Invalid API response',
              valid: false
            });
            return;
          }

          const usageInfo = apiData.usage;
          const standardUsage = usageInfo.standard;

          const formatDate = (timestamp) => {
            if (!timestamp && timestamp !== 0) return 'N/A';
            try {
              return new Date(timestamp).toISOString().split('T')[0];
            } catch (e) {
              return 'Invalid Date';
            }
          };

          resolve({
            ...keyConfig,
            startDate: formatDate(usageInfo.startDate),
            endDate: formatDate(usageInfo.endDate),
            orgTotalTokensUsed: standardUsage.orgTotalTokensUsed,
            totalAllowance: standardUsage.totalAllowance,
            usedRatio: standardUsage.usedRatio,
            remaining: standardUsage.totalAllowance - standardUsage.orgTotalTokensUsed,
            valid: true,
            maskedKey: `${keyConfig.key.substring(0, 8)}...${keyConfig.key.substring(keyConfig.key.length - 4)}`
          });
        } catch (error) {
          console.error(`❌ Key ${keyConfig.id} 处理失败:`, error.message);
          resolve({
            ...keyConfig,
            error: 'Parse error',
            valid: false
          });
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ Key ${keyConfig.id} 请求失败:`, error.message);
      resolve({
        ...keyConfig,
        error: error.message,
        valid: false
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ...keyConfig,
        error: 'Request timeout',
        valid: false
      });
    });

    req.end();
  });
}

// 聚合所有 API Keys 的数据
async function getAggregatedData() {
  const config = await loadConfig();
  const enabledKeys = config.apiKeys.filter(k => k.enabled !== false);

  if (enabledKeys.length === 0) {
    return {
      update_time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      total_count: 0,
      totals: {
        total_orgTotalTokensUsed: 0,
        total_totalAllowance: 0,
        total_remaining: 0
      },
      data: [],
      groups: {}
    };
  }

  console.log(`\n🔍 正在查询 ${enabledKeys.length} 个 API Keys...`);

  const results = await Promise.all(enabledKeys.map(keyConfig => fetchApiKeyData(keyConfig)));

  const validResults = results.filter(r => r.valid);

  const totals = validResults.reduce((acc, res) => {
    acc.total_orgTotalTokensUsed += res.orgTotalTokensUsed || 0;
    acc.total_totalAllowance += res.totalAllowance || 0;
    return acc;
  }, {
    total_orgTotalTokensUsed: 0,
    total_totalAllowance: 0
  });

  totals.total_remaining = totals.total_totalAllowance - totals.total_orgTotalTokensUsed;

  // 按分组统计
  const groups = {};
  results.forEach(item => {
    const group = item.group || 'default';
    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(item);
  });

  // 保存到历史记录
  const historyData = await loadHistory();
  const historyEntry = {
    timestamp: Date.now(),
    totals: totals,
    keys: validResults.map(r => ({
      id: r.id,
      used: r.orgTotalTokensUsed,
      allowance: r.totalAllowance,
      remaining: r.remaining
    }))
  };
  historyData.push(historyEntry);
  await saveHistory(historyData);

  // 输出剩余额度信息
  const keysWithBalance = validResults.filter(r => r.remaining > 0);
  if (keysWithBalance.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log("📋 剩余额度大于0的 API Keys:");
    console.log("-".repeat(80));
    keysWithBalance.forEach(item => {
      console.log(`${item.id} (${item.alias || 'No Alias'}): 剩余 ${item.remaining.toLocaleString()} tokens`);
    });
    console.log("=".repeat(80) + "\n");
  }

  return {
    update_time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    total_count: enabledKeys.length,
    totals,
    data: results,
    groups
  };
}

// HTTP 路由处理
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS 支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 首页 - 返回 HTML 界面
  if (url.pathname === "/" && req.method === 'GET') {
    try {
      const htmlPath = path.join(__dirname, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error loading page");
    }
    return;
  }



  // API: 获取聚合数据
  if (url.pathname === "/api/data" && req.method === 'GET') {
    try {
      const data = await getAggregatedData();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (error) {
      console.error('❌ API Error:', error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API: 获取配置
  if (url.pathname === "/api/config" && req.method === 'GET') {
    try {
      const config = await loadConfig();
      // 不返回完整的 key,只返回掩码版本
      const safeConfig = {
        ...config,
        apiKeys: config.apiKeys.map(k => ({
          ...k,
          key: `${k.key.substring(0, 8)}...${k.key.substring(k.key.length - 4)}`
        }))
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safeConfig));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API: 更新配置
  if (url.pathname === "/api/config" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const newConfig = JSON.parse(body);
        const success = await saveConfig(newConfig);
        res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success, message: success ? 'Config saved' : 'Failed to save' }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API: 批量导入 Keys
  if (url.pathname === "/api/keys/batch-import" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { keys, defaultGroup = 'default', viewPassword = '0000' } = data;
        const config = await loadConfig();
        
        // 获取当前最大的 ID 数字
        let maxId = 0;
        config.apiKeys.forEach(k => {
          const match = k.id.match(/key-(\d+)/);
          if (match) {
            maxId = Math.max(maxId, parseInt(match[1]));
          }
        });
        
        // 处理批量导入的 Keys
        const importedKeys = [];
        const failedKeys = [];
        
        keys.forEach((keyString, index) => {
          const trimmedKey = keyString.trim();
          if (!trimmedKey) return;
          
          // 检查是否是有效的 Factory.ai key
          if (!trimmedKey.startsWith('fk-')) {
            failedKeys.push({ key: trimmedKey, reason: '无效的 Key 格式' });
            return;
          }
          
          // 检查是否已存在
          if (config.apiKeys.find(k => k.key === trimmedKey)) {
            failedKeys.push({ key: trimmedKey, reason: 'Key 已存在' });
            return;
          }
          
          // 创建新的 Key 对象
          maxId++;
          const newKey = {
            id: `key-${maxId}`,
            key: trimmedKey,
            alias: `账户 ${maxId}`,
            group: defaultGroup,
            note: `批量导入 - ${new Date().toLocaleDateString()}`,
            enabled: true,
            viewPassword: viewPassword  // 添加查看密码
          };
          
          config.apiKeys.push(newKey);
          importedKeys.push(newKey);
        });
        
        // 保存配置
        const success = await saveConfig(config);
        
        res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success,
          imported: importedKeys.length,
          failed: failedKeys.length,
          importedKeys,
          failedKeys,
          message: `成功导入 ${importedKeys.length} 个 Keys${failedKeys.length > 0 ? `，${failedKeys.length} 个失败` : ''}`
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '处理失败: ' + error.message }));
      }
    });
    return;
  }

  // API: 批量删除 Keys
  if (url.pathname === "/api/keys/batch-delete" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { keyIds } = JSON.parse(body);
        const config = await loadConfig();
        
        const originalCount = config.apiKeys.length;
        config.apiKeys = config.apiKeys.filter(k => !keyIds.includes(k.id));
        const deletedCount = originalCount - config.apiKeys.length;
        
        const success = await saveConfig(config);
        res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success,
          deleted: deletedCount,
          message: `成功删除 ${deletedCount} 个 Keys`
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '删除失败' }));
      }
    });
    return;
  }

  // API: 验证管理员密码
  if (url.pathname === "/api/admin/verify" && req.method === 'POST') {
    parseRequestBody(req, (err, data) => {
      if (err) {
        return sendErrorResponse(res, 400, '请求格式错误');
      }
      
      const { password } = data;
      if (password === ADMIN_PASSWORD) {
        sendSuccessResponse(res, {});
      } else {
        sendErrorResponse(res, 403, '密码错误');
      }
    });
    return;
  }

  // API: 查看完整 Key
  if (url.pathname === "/api/keys/view" && req.method === 'POST') {
    parseRequestBody(req, async (err, data) => {
      if (err) {
        return sendErrorResponse(res, 400, '请求格式错误');
      }
      
      const { keyId, password } = data;
      const config = await loadConfig();
      const key = config.apiKeys.find(k => k.id === keyId);
      
      if (!key) {
        return sendErrorResponse(res, 404, 'Key 不存在');
      }
      
      // 使用全局管理员密码
      const keyPassword = key.viewPassword || '0000';
      
      if (password !== ADMIN_PASSWORD && password !== keyPassword) {
        return sendErrorResponse(res, 403, '密码错误');
      }
      
      sendSuccessResponse(res, { key: key.key });
    });
    return;
  }

  // API: 批量更新 Keys
  if (url.pathname === "/api/keys/batch-update" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { keyIds, updates } = JSON.parse(body);
        const config = await loadConfig();
        
        let updatedCount = 0;
        config.apiKeys.forEach(key => {
          if (keyIds.includes(key.id)) {
            // 应用更新
            if (updates.group !== undefined) key.group = updates.group;
            if (updates.enabled !== undefined) key.enabled = updates.enabled;
            if (updates.note !== undefined) key.note = updates.note;
            if (updates.viewPassword !== undefined) key.viewPassword = updates.viewPassword;
            updatedCount++;
          }
        });
        
        const success = await saveConfig(config);
        res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success,
          updated: updatedCount,
          message: `成功更新 ${updatedCount} 个 Keys`
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '更新失败' }));
      }
    });
    return;
  }

  // API: 添加新 Key
  if (url.pathname === "/api/keys" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const newKey = JSON.parse(body);
        const config = await loadConfig();

        // 验证必填字段
        if (!newKey.id || !newKey.key) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Missing required fields: id, key' }));
          return;
        }

        // 检查 ID 是否已存在
        if (config.apiKeys.find(k => k.id === newKey.id)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Key ID already exists' }));
          return;
        }

        config.apiKeys.push({
          id: newKey.id,
          key: newKey.key,
          alias: newKey.alias || '',
          group: newKey.group || 'default',
          note: newKey.note || '',
          enabled: true,
          viewPassword: newKey.viewPassword || '0000'
        });

        const success = await saveConfig(config);
        res.writeHead(success ? 201 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success,
          message: success ? 'Key added successfully' : 'Failed to add key'
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API: 更新 Key
  if (url.pathname.startsWith("/api/keys/") && req.method === 'PUT') {
    const keyId = decodeURIComponent(url.pathname.split('/api/keys/')[1]);
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const updatedKey = JSON.parse(body);
        const config = await loadConfig();
        const keyIndex = config.apiKeys.findIndex(k => k.id === keyId);

        if (keyIndex === -1) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Key not found' }));
          return;
        }

        // 保留原 key 值,除非明确提供新的
        config.apiKeys[keyIndex] = {
          ...config.apiKeys[keyIndex],
          ...updatedKey,
          id: keyId // ID 不允许修改
        };

        const success = await saveConfig(config);
        res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success,
          message: success ? 'Key updated successfully' : 'Failed to update key'
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API: 删除 Key
  if (url.pathname.startsWith("/api/keys/") && req.method === 'DELETE') {
    const keyId = decodeURIComponent(url.pathname.split('/api/keys/')[1]);
    const config = await loadConfig();
    const originalLength = config.apiKeys.length;
    config.apiKeys = config.apiKeys.filter(k => k.id !== keyId);

    if (config.apiKeys.length === originalLength) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const success = saveConfig(config);
    res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success,
      message: success ? 'Key deleted successfully' : 'Failed to delete key'
    }));
    return;
  }

  // API: 获取历史数据
  if (url.pathname === "/api/history" && req.method === 'GET') {
    try {
      const history = await loadHistory();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(history));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }



  // API: 测试单个 Key 的有效性
  if (url.pathname === "/api/test-key" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { key, id } = JSON.parse(body);
        const result = await fetchApiKeyData({ id: id || 'test', key });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log("\n" + "=".repeat(80));
  console.log("🚀 Factory.ai API 余额监控系统 v2.0 已启动!");
  console.log("-".repeat(80));
  console.log(`📊 访问地址: http://localhost:${PORT}`);
  

  
  if (!storage.isVercel) {
    console.log(`📁 配置文件: config.json`);
    console.log(`📈 历史数据: data/history.json`);
  } else {
    console.log(`☁️ Vercel KV: 数据存储在云端`);
  }
  
  console.log("=".repeat(80) + "\n");
});
