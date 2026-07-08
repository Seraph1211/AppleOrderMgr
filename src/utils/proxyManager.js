/**
 * 代理池管理模块
 * 功能：管理爬虫代理池，支持代理轮换、健康检查、智能刷新
 *
 * 核心策略：
 * 1. 仅爬虫服务使用代理，其他服务禁止使用
 * 2. 失败计数累积，达到 2 次永久废弃，永不恢复
 * 3. 智能刷新：可用代理 < 30% 或 = 0 时才刷新
 * 4. 开发环境默认关闭，测试时手动启用
 *
 * 作者：Seraph
 * 更新：2026-07-08
 */

const axios = require('axios');

const logger = require('./logger');
const { config } = require('./config');

/**
 * 代理池管理器类
 * 负责代理的获取、轮换、失败追踪、智能刷新
 */
class ProxyManager {
  constructor() {
    this.proxies = [];                    // 代理列表
    this.currentIndex = 0;                // 当前轮询索引
    this.badProxies = new Set();          // 已永久废弃的代理（key: "ip:port"）
    this.proxyFailCount = new Map();      // 代理累计失败次数（key: "ip:port", value: 失败次数）
    this.isInitialized = false;           // 是否已初始化
    this.maxFailCount = config.proxy.maxFailCount || 2; // 最大失败次数
  }

  /**
   * 初始化代理池
   * 从代理 API 加载代理列表
   * @returns {Promise<void>}
   * @throws {Error} 当代理 API 请求失败时抛出异常
   */
  async initialize() {
    if (!config.proxy.enabled) {
      logger.info('代理池未启用，跳过初始化');
      this.isInitialized = true;
      return;
    }

    try {
      await this.loadProxies();
      this.isInitialized = true;
      logger.info('代理池初始化成功', {
        proxyCount: this.proxies.length,
      });

      // ⚠️ 自动刷新已禁用 - 按需手动刷新，避免浪费代理配额
      // this.startAutoRefresh();
      logger.info('代理池自动刷新已禁用（按需手动刷新模式）');
    } catch (error) {
      logger.error('代理池初始化失败', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * 从代理 API 加载代理列表（全量刷新）
   * @returns {Promise<void>}
   * @throws {Error} 当 API 请求失败时抛出异常
   */
  async loadProxies() {
    const { apiUrl } = config.proxy;

    if (!apiUrl) {
      throw new Error('代理 API 配置缺失');
    }

    try {
      logger.debug('开始加载代理列表', { apiUrl: apiUrl.split('?')[0] });

      const response = await axios.get(apiUrl, {
        timeout: 10000,
      });

      // 检查快代理响应状态
      if (response.data.code !== 0) {
        throw new Error(`代理 API 返回错误: ${response.data.msg || '未知错误'}`);
      }

      // 解析快代理响应格式: { code: 0, msg: "", data: { count: 10, proxy_list: ["ip:port:user:pass", ...] } }
      const proxyList = this.parseProxyResponse(response.data);

      if (!proxyList || proxyList.length === 0) {
        throw new Error('代理 API 返回空列表');
      }

      // 全量替换代理列表
      this.proxies = proxyList;

      // 清空废弃列表和失败计数（刷新后重新开始）
      this.badProxies.clear();
      this.proxyFailCount.clear();

      logger.info('代理列表加载成功（全量刷新）', {
        count: this.proxies.length,
        validMinutes: '1-5',
        leftCount: response.data.data?.order_left_count || 'unknown',
      });
    } catch (error) {
      logger.error('加载代理列表失败', {
        error: error.message,
        apiUrl: apiUrl.split('?')[0],
      });
      throw error;
    }
  }

  /**
   * 解析代理 API 响应（快代理私密代理格式）
   * @param {Object} responseData - API 响应数据
   * @returns {Array<Object>} 代理对象数组
   */
  parseProxyResponse(responseData) {
    try {
      // 快代理私密代理响应格式（f_auth=1）: { code: 0, msg: "", data: { count: 10, proxy_list: ["ip:port:user:pass", ...] } }
      if (!responseData.data || !Array.isArray(responseData.data.proxy_list)) {
        logger.error('代理响应格式不正确', { responseData });
        return [];
      }

      const proxyList = responseData.data.proxy_list;

      logger.debug('解析代理列表', {
        count: proxyList.length,
        hasAuth: proxyList[0]?.split(':').length === 4,
      });

      // 转换为标准格式
      return proxyList.map((proxyStr) => this.parseProxyString(proxyStr));
    } catch (error) {
      logger.error('解析代理响应失败', {
        error: error.message,
        responseData,
      });
      return [];
    }
  }

  /**
   * 解析代理字符串为对象
   * @param {string} proxyStr - 代理字符串（格式：ip:port:user:pass）
   * @returns {Object} 代理对象
   */
  parseProxyString(proxyStr) {
    const parts = proxyStr.trim().split(':');

    if (parts.length >= 2) {
      const proxy = {
        host: parts[0],
        port: parseInt(parts[1], 10),
      };

      // 如果有认证信息（格式：ip:port:user:pass）
      if (parts.length >= 4) {
        proxy.auth = {
          username: parts[2],
          password: parts[3],
        };
      }

      return proxy;
    }

    throw new Error(`无效的代理格式: ${proxyStr}`);
  }

  /**
   * 获取下一个可用代理
   * 使用轮询策略，跳过已标记为坏的代理
   * @returns {Object|null} 代理对象，如果无可用代理返回 null
   */
  getNextProxy() {
    if (!config.proxy.enabled || this.proxies.length === 0) {
      return null;
    }

    let attempts = 0;

    // 遍历代理列表，寻找可用代理
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

      const proxyKey = `${proxy.host}:${proxy.port}`;

      if (!this.badProxies.has(proxyKey)) {
        logger.debug('获取代理', { proxy: proxyKey });
        return proxy;
      }

      attempts++;
    }

    logger.warn('无可用代理', {
      totalProxies: this.proxies.length,
      badProxies: this.badProxies.size,
    });

    return null;
  }

  /**
   * 记录代理失败（累计失败次数，不重置）
   * @param {Object} proxy - 代理对象
   * @returns {boolean} 是否已永久废弃该代理
   */
  recordProxyFailure(proxy) {
    if (!proxy) {
      return false;
    }

    const proxyKey = `${proxy.host}:${proxy.port}`;

    // 累计失败次数
    const currentFailCount = this.proxyFailCount.get(proxyKey) || 0;
    const newFailCount = currentFailCount + 1;

    this.proxyFailCount.set(proxyKey, newFailCount);

    logger.warn('代理请求失败', {
      proxy: proxyKey,
      failCount: newFailCount,
      maxFailCount: this.maxFailCount,
    });

    // 达到最大失败次数，永久废弃
    if (newFailCount >= this.maxFailCount) {
      this.badProxies.add(proxyKey);

      logger.error('代理已永久废弃', {
        proxy: proxyKey,
        reason: `累计失败 ${newFailCount} 次`,
        badProxyCount: this.badProxies.size,
      });

      return true; // 已废弃
    }

    return false; // 未废弃
  }

  /**
   * 记录代理成功（不重置失败计数）
   * @param {Object} proxy - 代理对象
   */
  recordProxySuccess(proxy) {
    if (!proxy) {
      return;
    }

    const proxyKey = `${proxy.host}:${proxy.port}`;

    // 不重置失败计数，失败次数累积
    const currentFailCount = this.proxyFailCount.get(proxyKey) || 0;

    logger.debug('代理请求成功', {
      proxy: proxyKey,
      currentFailCount,
    });
  }

  /**
   * 立即永久废弃代理（用于 HTTP 541 等严重错误）
   * @param {Object} proxy - 代理对象
   */
  markProxyAsBad(proxy) {
    if (!proxy) {
      return;
    }

    const proxyKey = `${proxy.host}:${proxy.port}`;
    this.badProxies.add(proxyKey);

    logger.error('代理被立即永久废弃', {
      proxy: proxyKey,
      reason: '触发 Apple 风控或其他严重错误',
      badProxyCount: this.badProxies.size,
    });
  }

  /**
   * 获取代理池状态
   * @returns {Object} 代理池状态信息
   */
  getStatus() {
    return {
      total: this.proxies.length,
      available: this.proxies.length - this.badProxies.size,
      bad: this.badProxies.size,
      currentIndex: this.currentIndex,
      enabled: config.proxy.enabled,
      isInitialized: this.isInitialized,
    };
  }

  /**
   * 检查是否需要刷新代理池（智能刷新）
   * @returns {boolean}
   */
  needsRefresh() {
    const status = this.getStatus();

    // 条件 1：可用代理数 < 总数的 30%
    const threshold = config.proxy.refreshThreshold || 0.3;
    if (status.available < status.total * threshold) {
      logger.info('可用代理不足阈值，需要刷新', {
        available: status.available,
        total: status.total,
        threshold: `${(threshold * 100).toFixed(0)}%`,
        currentPercentage: `${((status.available / status.total) * 100).toFixed(1)}%`,
      });
      return true;
    }

    // 条件 2：无可用代理
    if (status.available === 0) {
      logger.warn('无可用代理，需要立即刷新');
      return true;
    }

    return false;
  }

  /**
   * 启动智能刷新定时任务
   * ⚠️ 已废弃 - 改为按需手动刷新，避免浪费代理配额
   * @returns {void}
   * @deprecated 使用 refresh() 手动刷新
   */
  startAutoRefresh() {
    logger.warn('startAutoRefresh 已废弃，请使用 refresh() 手动刷新');
    return;

    // 以下代码已禁用
    const { refreshInterval, refreshThreshold } = config.proxy;

    setInterval(async () => {
      try {
        // 只有需要时才刷新
        if (this.needsRefresh()) {
          logger.info('触发智能刷新代理池');
          await this.loadProxies();
        } else {
          const status = this.getStatus();
          logger.debug('代理池状态良好，跳过刷新', {
            available: status.available,
            total: status.total,
            percentage: `${((status.available / status.total) * 100).toFixed(1)}%`,
          });
        }
      } catch (error) {
        logger.error('智能刷新代理池失败', {
          error: error.message,
        });
      }
    }, refreshInterval);

    logger.info('代理池智能刷新已启动', {
      intervalMinutes: refreshInterval / 60000,
      refreshThreshold: `${((refreshThreshold || 0.3) * 100).toFixed(0)}%`,
      strategy: '可用代理 < 阈值或 = 0 时刷新',
    });
  }

  /**
   * 手动刷新代理池
   * @returns {Promise<void>}
   */
  async refresh() {
    logger.info('手动刷新代理池');
    await this.loadProxies();
  }
}

// 创建并导出全局代理管理器实例
const proxyManager = new ProxyManager();

module.exports = proxyManager;
