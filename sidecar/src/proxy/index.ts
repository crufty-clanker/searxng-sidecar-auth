import { FastifyInstance } from 'fastify';

export async function proxyRoutes(fastify: FastifyInstance) {
  // Proxy all requests to SearXNG
  fastify.all('*', async (req, reply) => {
    // TODO: Implement proxy logic
    // 1. Check if user is authenticated (has session)
    // 2. Resolve engine secrets for the user
    // 3. Inject X-Authenticated-Engines-Secrets header
    // 4. Forward request to SearXNG backend
    reply.status(501).send({ error: 'Proxy not implemented' });
  });
}
