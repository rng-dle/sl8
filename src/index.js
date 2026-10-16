// Entry point: the MCP connector (OAuth 2.1 + /mcp) wraps the existing app. Everything that isn't the connector goes to worker.js unchanged.
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import app, { Room } from './worker.js';
import { McpApi, authorize } from './mcp.js';

export { Room };
let provider;
export default {
  fetch(req, env, ctx) {
    // The connector is bound to one address (tokens are issued for it). MCP_RESOURCE overrides it for local tests.
    provider ??= new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: McpApi,
      defaultHandler: { fetch: async (r, e, c) => (await authorize(r, e)) || app.fetch(r, e, c) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['canvas:read', 'canvas:write'],
      resourceMetadata: { resource: env.MCP_RESOURCE || 'https://thinksl8.com/mcp', authorization_servers: [new URL(env.MCP_RESOURCE || 'https://thinksl8.com').origin], scopes_supported: ['canvas:read', 'canvas:write'] },
    });
    return provider.fetch(req, env, ctx);
  },
};
