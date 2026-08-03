import { FastifyReply, FastifyRequest } from 'fastify';

export async function loginHandler(req: FastifyRequest, reply: FastifyReply) {
  // Redirect to SSO provider
  const provider = process.env.SSO_PROVIDER || 'oidc';
  const issuer = process.env.SSO_ISSUER;
  
  if (!issuer) {
    return reply.status(500).send({ error: 'SSO provider not configured' });
  }

  // TODO: Implement OIDC/SAML redirect
  reply.redirect(`${issuer}/authorize?client_id=${process.env.SSO_CLIENT_ID}&response_type=code&redirect_uri=${process.env.SSO_REDIRECT_URI}`);
}
