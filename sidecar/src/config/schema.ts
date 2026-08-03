import { z } from 'zod';

export const configSchema = z.object({
  listenAddr: z.string().default('0.0.0.0:8080'),
  searxngBackendUrl: z.string().url().default('http://localhost:8888'),
  ssoProvider: z.enum(['oidc', 'saml', 'ldap']).default('oidc'),
  ssoIssuer: z.string().url().optional(),
  ssoClientId: z.string().optional(),
  ssoClientSecret: z.string().optional(),
  ssoRedirectUri: z.string().url().optional(),
  enginesConfig: z.string().default('./engines.json'),
  sessionSecret: z.string().optional(),
  sessionMaxAge: z.number().default(86400),
  rateLimitPerMin: z.number().default(60),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof configSchema>;
