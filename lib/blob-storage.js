/**
 * Vercel Blob 存储适配器
 * 使用 Vercel Blob 存储 JSON 数据，支持本地和 Vercel 环境自动切换
 */

const fs = require('fs');
const path = require('path');

// 检测是否在 Vercel 环境中运行
const IS_VERCEL = process.env.VERCEL || process.env.BLOB_READ_WRITE_TOKEN;

// 配置文件路径（本地环境）
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const HISTORY_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

// Blob 文件名
const CONFIG_BLOB = 'config.json';
const HISTORY_BLOB = 'history.json';

// Vercel Blob 客户端
class VercelBlobClient {
  constructor() {
    // 动态导入 @vercel/blob（仅在 Vercel 环境中）
    this.blobModule = null;
    if (IS_VERCEL) {
      try {
        // 在 Vercel 环境中，@vercel/blob 会自动可用
        this.blobModule = require('@vercel/blob');
      } catch (error) {
        console.warn('⚠️ @vercel/blob 未安装，将使用 REST API');
      }
    }
  }

  // 使用 REST API 作为后备方案
  async fetchBlob(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Blob API 错误: ${response.statusText}`);
    }
    
    return response;
  }

  async read(filename) {
    try {
      if (this.blobModule) {
        // 使用 @vercel/blob SDK
        const { list } = this.blobModule;
        
        // Vercel Blob 会给文件名添加随机后缀，所以需要用前缀搜索
        // 例如：config.json 会变成 config-HcJbdeVwxdFL9S5mifVW6Tn5ufxgiz.json
        const prefix = filename.replace('.json', '');
        
        // 列出所有匹配前缀的文件
        const result = await list({ prefix: prefix });
        
        if (result.blobs && result.blobs.length > 0) {
          // 找到最新的文件（按上传时间排序）
          const sortedBlobs = result.blobs.sort((a, b) => {
            const timeA = new Date(a.uploadedAt || 0).getTime();
            const timeB = new Date(b.uploadedAt || 0).getTime();
            return timeB - timeA; // 降序，最新的在前
          });
          
          const latestBlob = sortedBlobs[0];
          
          // 获取文件内容
          const response = await fetch(latestBlob.url);
          const data = await response.text();
          return JSON.parse(data);
        }
        

        return null;
      } else {
        // 使用 REST API 列出 blobs
        const prefix = filename.replace('.json', '');
        const listUrl = `https://api.vercel.com/v1/blob?prefix=${prefix}`;
        const response = await this.fetchBlob(listUrl);
        const result = await response.json();
        
        if (result.blobs && result.blobs.length > 0) {
          // 找到最新的文件
          const sortedBlobs = result.blobs.sort((a, b) => {
            const timeA = new Date(a.uploadedAt || 0).getTime();
            const timeB = new Date(b.uploadedAt || 0).getTime();
            return timeB - timeA;
          });
          
          const latestBlob = sortedBlobs[0];
          const dataResponse = await fetch(latestBlob.url);
          const data = await dataResponse.text();
          return JSON.parse(data);
        }
        return null;
      }
    } catch (error) {
      // 静默处理错误
      return null;
    }
  }

  async write(filename, data) {
    try {
      const jsonData = JSON.stringify(data, null, 2);
      if (this.blobModule) {
        // 使用 @vercel/blob SDK
        const { put, del, list } = this.blobModule;
        
        // 先删除旧文件（如果存在）
        try {
          const prefix = filename.replace('.json', '');
          const existingFiles = await list({ prefix: prefix });
          
          if (existingFiles.blobs && existingFiles.blobs.length > 0) {
            for (const blob of existingFiles.blobs) {
              await del(blob.url);
            }
          }
        } catch (e) {
          // 忽略清理错误
        }
        
        // 写入新文件
        const result = await put(filename, jsonData, {
          access: 'public',
          contentType: 'application/json',
          addRandomSuffix: true, // 明确使用随机后缀
        });
        return true;
      } else {
        // 使用 REST API
        const putUrl = `https://api.vercel.com/v1/blob/${filename}`;
        await this.fetchBlob(putUrl, {
          method: 'PUT',
          body: jsonData,
          headers: {
            'Content-Type': 'application/json',
          },
        });
        return true;
      }
    } catch (error) {
      // 静默处理错误
      return false;
    }
  }

  async delete(filename) {
    try {
      if (this.blobModule) {
        // 使用 @vercel/blob SDK
        const { del } = this.blobModule;
        await del(filename);
        return true;
      } else {
        // 使用 REST API
        const deleteUrl = `https://api.vercel.com/v1/blob/${filename}`;
        await this.fetchBlob(deleteUrl, {
          method: 'DELETE',
        });
        return true;
      }
    } catch (error) {
      console.error(`删除 Blob [${filename}] 失败:`, error.message);
      return false;
    }
  }
}

// 存储适配器
class BlobStorageAdapter {
  constructor() {
    this.isVercel = IS_VERCEL;
    
    if (this.isVercel) {
      this.blob = new VercelBlobClient();
    } else {
      // 确保本地数据目录存在
      if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
      }
    }
  }

  // 加载配置
  async loadConfig() {
    try {
      if (this.isVercel) {
        // 从 Vercel Blob 加载
        const config = await this.blob.read(CONFIG_BLOB);
        if (config && config.apiKeys && config.apiKeys.length > 0) {
          // 验证配置有效性
          if (Array.isArray(config.apiKeys)) {
            return config;
          }
        }
        
        // 如果 Blob 中没有，尝试从环境变量加载
        // 支持多种环境变量名称
        const apiKeysEnv = process.env.FACTORY_API_KEYS || process.env.API_KEYS;
        if (apiKeysEnv) {
          try {
            const keys = JSON.parse(apiKeysEnv);
            const defaultConfig = {
              apiKeys: keys,
              settings: this.getDefaultSettings()
            };
            // 保存到 Blob
            await this.blob.write(CONFIG_BLOB, defaultConfig);
            return defaultConfig;
          } catch (e) {
            console.error('解析 API_KEYS 环境变量失败:', e);
          }
        }
        
        // 返回默认配置
        const defaultConfig = this.getDefaultConfig();
        await this.blob.write(CONFIG_BLOB, defaultConfig);
        return defaultConfig;
      } else {
        // 从本地文件加载
        if (!fs.existsSync(CONFIG_FILE)) {
          const defaultConfig = this.getDefaultConfig();
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
          return defaultConfig;
        }
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      return this.getDefaultConfig();
    }
  }

  // 保存配置
  async saveConfig(config) {
    try {
      if (this.isVercel) {
        // 保存到 Vercel Blob
        return await this.blob.write(CONFIG_BLOB, config);
      } else {
        // 保存到本地文件
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

        return true;
      }
    } catch (error) {
      return false;
    }
  }

  // 加载历史数据
  async loadHistory() {
    try {
      if (this.isVercel) {
        // 从 Vercel Blob 加载
        const history = await this.blob.read(HISTORY_BLOB);
        return history || [];
      } else {
        // 从本地文件加载
        if (!fs.existsSync(HISTORY_FILE)) {
          return [];
        }
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      return [];
    }
  }

  // 保存历史数据
  async saveHistory(historyData) {
    try {
      // 清理过期数据
      const config = await this.loadConfig();
      const retentionDays = config.settings?.historyRetentionDays || 30;
      const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      const filteredData = historyData.filter(item => item.timestamp > cutoffTime);

      // 限制历史记录数量（防止文件过大）
      const maxRecords = 1000;
      const trimmedData = filteredData.slice(-maxRecords);

      if (this.isVercel) {
        // 保存到 Vercel Blob
        return await this.blob.write(HISTORY_BLOB, trimmedData);
      } else {
        // 保存到本地文件
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmedData, null, 2));
        return true;
      }
    } catch (error) {
      return false;
    }
  }

  // 获取默认设置
  getDefaultSettings() {
    return {
      autoRefreshInterval: 300000,
      alertThreshold: 0.8,
      historyRetentionDays: 30
    };
  }

  // 获取默认配置
  getDefaultConfig() {
    return {
      apiKeys: [],
      settings: this.getDefaultSettings()
    };
  }

  // 获取存储模式信息
  getStorageInfo() {
    return {
      mode: this.isVercel ? 'vercel-blob' : 'local-file',
      description: this.isVercel ? 'Vercel Blob (云端对象存储)' : '本地文件系统',
      persistent: true,
      features: {
        config: true,
        history: true,
        addKey: true,
        deleteKey: true,
        updateKey: true
      },
      limits: this.isVercel ? {
        storage: '1GB 免费额度',
        operations: '10k 次/月',
        fileSize: '4.5MB/文件'
      } : null
    };
  }
}

// 导出单例
module.exports = new BlobStorageAdapter();
