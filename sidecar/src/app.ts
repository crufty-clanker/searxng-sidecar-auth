import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import { authRoutes } from './auth/index.js';
import { proxyRoutes } from './proxy/index.js';

export const app = Fastify({
  logger: true,
});

// Register plugins
await app.register(cookie);
await app.register(session, {
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: parseInt(process.env.SESSION_MAX_AGE || '86400', 10),
  },
});

// Register routes
app.register(authRoutes, { prefix: '/auth' });
app.register(proxyRoutes, { prefix: '' });
