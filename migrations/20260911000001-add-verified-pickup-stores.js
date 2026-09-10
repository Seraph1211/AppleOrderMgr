'use strict';

const VERIFIED_AT = new Date('2026-09-11T00:00:00.000Z');
const STORES = [
  {
    code: 'R320',
    name: 'Apple 三里屯',
    city: '北京',
    sourceUrl: 'https://www.apple.com.cn/retail/sanlitun/',
  },
  {
    code: 'R359',
    name: 'Apple 南京东路',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/nanjingeast/',
  },
  {
    code: 'R388',
    name: 'Apple 西单大悦城',
    city: '北京',
    sourceUrl: 'https://www.apple.com.cn/retail/xidanjoycity/',
  },
  {
    code: 'R389',
    name: 'Apple 浦东',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/pudong/',
  },
  {
    code: 'R390',
    name: 'Apple 香港广场',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/hongkongplaza/',
  },
  {
    code: 'R401',
    name: 'Apple 上海环贸 iapm',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/shanghaiiapm/',
  },
  {
    code: 'R448',
    name: 'Apple 王府井',
    city: '北京',
    sourceUrl: 'https://www.apple.com.cn/retail/wangfujing/',
  },
  {
    code: 'R471',
    name: 'Apple 西湖',
    city: '杭州',
    sourceUrl: 'https://www.apple.com.cn/retail/westlake/',
  },
  {
    code: 'R476',
    name: 'Apple 重庆北城天街',
    city: '重庆',
    sourceUrl: 'https://www.apple.com.cn/retail/paradisewalkchongqing/',
  },
  {
    code: 'R479',
    name: 'Apple 华贸购物中心',
    city: '北京',
    sourceUrl: 'https://www.apple.com.cn/retail/chinacentralmall/',
  },
  {
    code: 'R480',
    name: 'Apple 解放碑',
    city: '重庆',
    sourceUrl: 'https://www.apple.com.cn/retail/jiefangbei/',
  },
  {
    code: 'R484',
    name: 'Apple 深圳益田假日广场',
    city: '深圳',
    sourceUrl: 'https://www.apple.com.cn/retail/holidayplazashenzhen/',
  },
  {
    code: 'R493',
    name: 'Apple 新街口',
    city: '南京',
    sourceUrl: 'https://www.apple.com.cn/retail/xinjiekou/',
  },
  {
    code: 'R502',
    name: 'Apple 成都万象城',
    city: '成都',
    sourceUrl: 'https://www.apple.com.cn/retail/mixcchengdu/',
  },
  {
    code: 'R531',
    name: 'Apple 天一广场',
    city: '宁波',
    sourceUrl: 'https://www.apple.com.cn/retail/tianyisquare/',
  },
  {
    code: 'R532',
    name: 'Apple 杭州万象城',
    city: '杭州',
    sourceUrl: 'https://www.apple.com.cn/retail/mixchangzhou/',
  },
  {
    code: 'R534',
    name: 'Apple 中街大悦城',
    city: '沈阳',
    sourceUrl: 'https://www.apple.com.cn/retail/zhongjiejoycity/',
  },
  {
    code: 'R557',
    name: 'Apple 青岛万象城',
    city: '青岛',
    sourceUrl: 'https://www.apple.com.cn/retail/mixcqingdao/',
  },
  {
    code: 'R571',
    name: 'Apple 南宁万象城',
    city: '南宁',
    sourceUrl: 'https://www.apple.com.cn/retail/mixcnanning/',
  },
  {
    code: 'R572',
    name: 'Apple 郑州万象城',
    city: '郑州',
    sourceUrl: 'https://www.apple.com.cn/retail/mixczhengzhou/',
  },
  {
    code: 'R573',
    name: 'Apple 重庆万象城',
    city: '重庆',
    sourceUrl: 'https://www.apple.com.cn/retail/mixcchongqing/',
  },
  {
    code: 'R574',
    name: 'Apple 无锡恒隆广场',
    city: '无锡',
    sourceUrl: 'https://www.apple.com.cn/retail/center66wuxi/',
  },
  {
    code: 'R575',
    name: 'Apple 武汉',
    city: '武汉',
    sourceUrl: 'https://www.apple.com.cn/retail/wuhan/',
  },
  {
    code: 'R576',
    name: 'Apple 沈阳万象城',
    city: '沈阳',
    sourceUrl: 'https://www.apple.com.cn/retail/mixcshenyang/',
  },
  {
    code: 'R577',
    name: 'Apple 天环广场',
    city: '广州',
    sourceUrl: 'https://www.apple.com.cn/retail/parccentral/',
  },
  {
    code: 'R579',
    name: 'Apple 天津恒隆广场',
    city: '天津',
    sourceUrl: 'https://www.apple.com.cn/retail/riverside66tianjin/',
  },
  {
    code: 'R580',
    name: 'Apple 成都太古里',
    city: '成都',
    sourceUrl: 'https://www.apple.com.cn/retail/taikoolichengdu/',
  },
  {
    code: 'R581',
    name: 'Apple 五角场',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/wujiaochang/',
  },
  {
    code: 'R609',
    name: 'Apple 大连恒隆广场',
    city: '大连',
    sourceUrl: 'https://www.apple.com.cn/retail/olympia66dalian/',
  },
  {
    code: 'R617',
    name: 'Apple 长沙',
    city: '长沙',
    sourceUrl: 'https://www.apple.com.cn/retail/changsha/',
  },
  {
    code: 'R637',
    name: 'Apple 天津大悦城',
    city: '天津',
    sourceUrl: 'https://www.apple.com.cn/retail/tianjinjoycity/',
  },
  {
    code: 'R638',
    name: 'Apple 天津万象城',
    city: '天津',
    sourceUrl: 'https://www.apple.com.cn/retail/mixctianjin/',
  },
  {
    code: 'R639',
    name: 'Apple 珠江新城',
    city: '广州',
    sourceUrl: 'https://www.apple.com.cn/retail/zhujiangnewtown/',
  },
  {
    code: 'R643',
    name: 'Apple 虹悦城',
    city: '南京',
    sourceUrl: 'https://www.apple.com.cn/retail/wondercity/',
  },
  {
    code: 'R644',
    name: 'Apple 厦门新生活广场',
    city: '厦门',
    sourceUrl: 'https://www.apple.com.cn/retail/xiamenlifestylecenter/',
  },
  {
    code: 'R645',
    name: 'Apple 朝阳大悦城',
    city: '北京',
    sourceUrl: 'https://www.apple.com.cn/retail/chaoyangjoycity/',
  },
  {
    code: 'R646',
    name: 'Apple 泰禾广场',
    city: '福州',
    sourceUrl: 'https://www.apple.com.cn/retail/tahoeplaza/',
  },
  {
    code: 'R648',
    name: 'Apple 济南恒隆广场',
    city: '济南',
    sourceUrl: 'https://www.apple.com.cn/retail/parc66jinan/',
  },
  {
    code: 'R670',
    name: 'Apple 昆明',
    city: '昆明',
    sourceUrl: 'https://www.apple.com.cn/retail/kunming/',
  },
  {
    code: 'R678',
    name: 'Apple 静安',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/jingan/',
  },
  {
    code: 'R683',
    name: 'Apple 环球港',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/globalharbor/',
  },
  {
    code: 'R688',
    name: 'Apple 苏州',
    city: '苏州',
    sourceUrl: 'https://www.apple.com.cn/retail/suzhou/',
  },
  {
    code: 'R703',
    name: 'Apple 玄武湖',
    city: '南京',
    sourceUrl: 'https://www.apple.com.cn/retail/xuanwulake/',
  },
  {
    code: 'R705',
    name: 'Apple 七宝',
    city: '上海',
    sourceUrl: 'https://www.apple.com.cn/retail/qibao/',
  },
  {
    code: 'R761',
    name: 'Apple 深圳万象城',
    city: '深圳',
    sourceUrl: 'https://www.apple.com.cn/retail/mixcshenzhen/',
  },
  {
    code: 'R765',
    name: 'Apple 合肥万象城',
    city: '合肥',
    sourceUrl: 'https://www.apple.com.cn/retail/mixchefei/',
  },
  {
    code: 'R766',
    name: 'Apple 温州万象城',
    city: '温州',
    sourceUrl: 'https://www.apple.com.cn/retail/mixcwenzhou/',
  },
  {
    code: 'R792',
    name: 'Apple 北京荟聚',
    city: '北京',
    sourceUrl: 'https://www.apple.com.cn/retail/livatbeijing/',
  },
  {
    code: 'R793',
    name: 'Apple 前海壹方城',
    city: '深圳',
    sourceUrl: 'https://www.apple.com.cn/retail/uniwalkqianhai/',
  },
];

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const store of STORES) {
        await queryInterface.sequelize.query(
          `INSERT INTO pickup_stores
            (code, name, city, source_url, verified_at, created_at, updated_at)
           SELECT :code, :name, :city, :sourceUrl, :verifiedAt, NOW(), NOW()
           WHERE NOT EXISTS (SELECT 1 FROM pickup_stores WHERE code = :code)`,
          {
            replacements: { ...store, verifiedAt: VERIFIED_AT },
            transaction,
          }
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const store of STORES) {
        await queryInterface.bulkDelete(
          'pickup_stores',
          {
            code: store.code,
            source_url: store.sourceUrl,
            verified_at: VERIFIED_AT,
          },
          { transaction }
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
