import './env.js';
export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/sentinelpay',
  // separate database for user-interaction events (defaults to the same server, db "sentinelpay_interactions")
  interactionsMongoUri: process.env.INTERACTIONS_MONGODB_URI || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15m',
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS || 7),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174').split(','),
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID || 'sentinelpay-api',
    enabled: process.env.KAFKA_ENABLED === 'true'
  },
  fraudEngineUrl: process.env.FRAUD_ENGINE_URL || 'http://localhost:8000',
  seedAdminEmail: process.env.ADMIN_EMAIL || 'admin@sentinelpay.local',
  seedAdminPassword: process.env.ADMIN_PASSWORD || 'Admin123!'
};
