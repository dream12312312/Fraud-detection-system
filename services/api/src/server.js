import './env.js';
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
import interactionRoutes, { adminInteractionRoutes } from './routes/interactions.js';
import { connectInteractions } from './interactions.js';

const app = express();
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'sentinelpay-api', time: new Date().toISOString(), uptime_s: Math.round(process.uptime()) }));
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/interactions', interactionRoutes);
app.use('/api/v1/admin/interactions', adminInteractionRoutes);
app.use('/api/v1', bankingRoutes);
app.use('/api/v1/admin', adminRoutes);

// Final error handler: always answer with JSON so clients never see an opaque
// 'Internal Server Error' page (this is what produced the register 500 confusion).
app.use((err, _req, res, _next) => {
  console.error('[api] unhandled error:', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// A crash in async code outside a request must log loudly, not exit silently.
process.on('unhandledRejection', (reason) => console.error('[api] unhandled rejection:', reason));

const server = http.createServer(app);

// node --watch restarts this process the moment a file changes, sometimes before
// the previous instance has released port 4000. Retrying the listen instead of
// exiting turns that race into a clean hot-reload instead of an endless crash loop.
const LISTEN_RETRY_MS = 1000;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[api] port ${config.port} still in use (watch restart race) — retrying in ${LISTEN_RETRY_MS}ms…`);
    setTimeout(() => {
      server.close();
      server.listen(config.port);
    }, LISTEN_RETRY_MS);
  } else {
    console.error('[api] server error:', err);
  }
});

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
  // Make sure the unique indexes declared in models.js actually exist in the DB.
  // A stale/missing index (e.g. after schema changes) is otherwise only
  // discovered as a confusing duplicate-key error at registration time.
  const { User, Account, Transaction, Beneficiary, Notification } = await import('./models.js');
  await Promise.all([User.syncIndexes(), Account.syncIndexes(), Transaction.syncIndexes(), Beneficiary.syncIndexes(), Notification.syncIndexes()]);
  // the interaction store is optional: if it cannot connect, the bank still runs
  await connectInteractions();
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
