import { EngineSecrets } from './resolver.js';

/**
 * Builds the X-Authenticated-Engines-Secrets header value.
 */
export function buildSecretsHeader(secrets: EngineSecrets): string {
  return JSON.stringify(secrets);
}

/**
 * Injects secrets into request headers.
 */
export function injectSecrets(headers: Record<string, string>, secrets: EngineSecrets): Record<string, string> {
  const headerValue = buildSecretsHeader(secrets);
  return {
    ...headers,
    'X-Authenticated-Engines-Secrets': headerValue,
  };
}
