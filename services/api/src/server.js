import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import http from 'http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { connectDb, User, Account } from './models.js';
import { signAccessToken } from './auth.js';
import authRoutes from './routes/auth.js';
import bankingRoutes from './routes/banking.js';
import adminRoutes from './routes/admin.js';

const app = express();
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'sentinelpay-api', time: new Date().toISOString() }));
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', bankingRoutes);
app.use('/api/v1/admin', adminRoutes);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigins, credentials: true } });

io.on('connection', (socket) => {
  socket.on('join', ({ userId, role }) => {
    if (role === 'admin') socket.join('admins');
    else if (userId) socket.join(`user:${userId}`);
  });
});

// Broadcast helper used by other modules
app.set('io', io);
export function broadcast(room, event, payload) {
  io.to(room).emit(event, payload);
}

async function seedAdmin() {
  const exists = await User.findOne({ email: config.seedAdminEmail });
  if (exists) return exists;
  const bcrypt = (await import('bcryptjs')).default;
  const admin = await User.create({
    email: config.seedAdminEmail,
    passwordHash: await bcrypt.hash(config.seedAdminPassword, 10),
    fullName: 'System Admin',
    role: 'admin',
    status: 'ACTIVE'
  });
  console.log(`[seed] admin created: ${config.seedAdminEmail}`);
  return admin;
}

async function start() {
  await connectDb(config.mongoUri);
  console.log('[db] connected');
  const admin = await seedAdmin();
  if (!(await Account.findOne({ userId: admin._id }))) {
    await Account.create({ userId: admin._id, accountNumber: 'SPY-ADMIN-001', balance: 100000 });
  }
  server.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
}

start().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});

export { app, server, io };
