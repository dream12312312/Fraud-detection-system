import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { User } from './models.js';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, aud: 'sentinelpay' },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function signRefreshToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, aud: 'sentinelpay-refresh' },
    config.jwtSecret,
    { expiresIn: `${config.refreshTokenDays}d` }
  );
}

export function verifyToken(token, audience) {
  return jwt.verify(token, config.jwtSecret, { audience });
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const payload = verifyToken(token, 'sentinelpay');
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.status !== 'ACTIVE') return res.status(403).json({ error: `Account ${user.status}` });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
