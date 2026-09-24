import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User, Account } from '../models.js';
import { signAccessToken, signRefreshToken, verifyToken, requireAuth } from '../auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body ?? {};
    if (!email || !password || !fullName) return res.status(400).json({ error: 'email, password, fullName required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email: String(email).toLowerCase(), passwordHash, fullName });
    const accountNumber = `SPY-${String(user._id).slice(-6).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const account = await Account.create({ userId: user._id, accountNumber, balance: 5000 });
    res.status(201).json({ id: user._id, email: user.email, fullName: user.fullName, status: user.status, accountNumber: account.accountNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.status !== 'ACTIVE') return res.status(403).json({ error: `Account ${user.status}` });
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    res.json({ accessToken, refreshToken, user: { id: user._id, email: user.email, fullName: user.fullName, role: user.role, status: user.status } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    const payload = verifyToken(refreshToken, 'sentinelpay-refresh');
    const user = await User.findById(payload.sub);
    if (!user || user.status !== 'ACTIVE') return res.status(401).json({ error: 'Invalid refresh token' });
    res.json({ accessToken: signAccessToken(user) });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u._id, email: u.email, fullName: u.fullName, role: u.role, status: u.status, homeCountry: u.homeCountry });
});

export default router;
