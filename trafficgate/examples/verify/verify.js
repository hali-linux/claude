// TrafficGate 통과 토큰 검증 (Node.js 16+, 외부 패키지 없음)
//
//   const { verifyToken } = require('./verify');
//   const claims = verifyToken(token, process.env.TRAFFICGATE_TOKEN_SECRET, 'event'); // 실패 시 null
//
// Express 미들웨어 예시:
//   app.post('/order', (req, res, next) => {
//     const token = req.get('X-TrafficGate-Token') || req.cookies['tg_event'];
//     if (!verifyToken(token, SECRET, 'event')) return res.status(429).json({ error: 'queue_required' });
//     next();
//   });
'use strict';
const crypto = require('crypto');

function verifyToken(token, secret, segment, nowSec) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  const now = nowSec != null ? nowSec : Math.floor(Date.now() / 1000);
  if (!(claims.exp > now)) return null;
  if (segment && claims.s !== segment) return null;
  return claims;
}

module.exports = { verifyToken };

if (require.main === module) {
  const [token, secret, segment] = process.argv.slice(2);
  const claims = verifyToken(token, secret, segment);
  console.log(claims ? JSON.stringify(claims) : 'INVALID');
  process.exit(claims ? 0 : 1);
}
