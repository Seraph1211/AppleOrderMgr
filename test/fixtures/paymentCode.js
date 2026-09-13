const zlib = require('zlib');
/** 创建无业务载荷的合成 PNG，以验证容器而不使用真实付款码。 */
function makePng(seed = 0) {
  const crc = bytes => {
    let n = 0xffffffff;
    for (const b of bytes) {
      n ^= b;
      for (let i = 0; i < 8; i += 1) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(bytes));
    return Buffer.concat([length, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(21);
  header.writeUInt32BE(21, 4);
  header[8] = 8;
  const rows = Buffer.alloc(22 * 21, seed);
  for (let i = 0; i < 21; i += 1) rows[i * 22] = 0;
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
module.exports = { makePng };
