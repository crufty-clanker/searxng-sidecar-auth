import { FastifyInstance } from 'fastify';
import { loginHandler } from './handler.js';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.get('/login', loginHandler);
  fastify.get('/callback', loginHandler);
  fastify.get('/logout', (req, reply) => {
    reply.clearCookie('session');
    reply.redirect('/');
  });
}
