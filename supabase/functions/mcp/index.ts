// OnSketch MCP server (Supabase Edge Function "mcp").
//
// Lets an AI assistant (Claude, ChatGPT, any MCP client) draw sketches in
// the user's OnSketch account. The user connects it once by adding
//   https://<project>.supabase.co/functions/v1/mcp
// as a connector; the assistant then signs them in with OAuth 2.1 through
// Supabase Auth's OAuth server (consent page: /oauth/consent/ on the site).
// The access token it gets is an ordinary Supabase JWT for that user, so
// every query below runs as them, under the tables' row-level security.
//
// Routes (the function's own path, /mcp, or under /functions/v1/mcp):
//   POST  /                                      MCP (Streamable HTTP, JSON answers)
//   GET   /.well-known/oauth-protected-resource  where to sign in (RFC 9728)
//   GET   /                                      405: no server-sent stream
//
// Deploy:  node scripts/build-mcp.mjs && supabase functions deploy mcp --no-verify-jwt
// (verify_jwt is off in config.toml too: unauthenticated requests must get
// a 401 with the WWW-Authenticate header below, which starts sign-in.)
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import { handleMessage, createTools } from './server.js';
import { Cloud } from './_app/cloud/cloud.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// The URL clients use (set it when the function sits behind a custom
// domain such as https://mcp.onsketch.io).
const PUBLIC_URL = (Deno.env.get('MCP_PUBLIC_URL') || `${SUPABASE_URL}/functions/v1/mcp`).replace(/\/$/, '');
const APP_URL = (Deno.env.get('ONSKETCH_APP_URL') || 'https://onsketch.io').replace(/\/$/, '');
const METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;
const SCOPES = ['openid', 'email', 'profile'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'Access-Control-Expose-Headers': 'www-authenticate, mcp-session-id',
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', ...headers } });

/** The caller's projects, as them. Cloud (app/src/cloud/cloud.js) reads
 *  the user from a browser session; here the user comes from the token. */
class ServerCloud extends Cloud {
  userId: string;
  _user: { id: string };
  constructor(client: unknown, user: { id: string }) { super(client); this._user = user; this.userId = user.id; }
  async user() { return this._user; }
  /** With owner_id, so a public sketch of someone else can be told apart. */
  async load(id: string) {
    const { data, error } = await this.client.from('projects')
      .select('id,owner_id,name,description,visibility,revision,updated_at,created_at,data').eq('id', id).single();
    if (error) throw error;
    return data;
  }
}

function unauthorized(message = 'Sign in to OnSketch to use this server.') {
  return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }, 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${METADATA_URL}", scope="${SCOPES.join(' ')}"`,
  });
}

async function caller(req: Request) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const token = m[1];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // Verifies the signature (JWKS) and expiry; falls back to the Auth server.
  const { data, error } = await client.auth.getClaims(token);
  const claims = data?.claims;
  if (error || !claims?.sub || claims.role !== 'authenticated') return null;
  return new ServerCloud(client, { id: claims.sub });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (url.pathname.endsWith('/.well-known/oauth-protected-resource')) {
    return json({
      resource: PUBLIC_URL,
      authorization_servers: [`${SUPABASE_URL}/auth/v1`],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'OnSketch',
      resource_documentation: `${APP_URL}/ai/`,
    }, 200, { 'cache-control': 'public, max-age=3600' });
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    return new Response('This MCP server answers POST requests only (no event stream, no sessions).', { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS' } });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

  const store = await caller(req);
  if (!store) return unauthorized();

  let body: unknown;
  try { body = await req.json(); }
  catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

  const tools = createTools(store, { appUrl: APP_URL });
  const log = (...args: unknown[]) => console.error('[mcp]', ...args);
  if (Array.isArray(body)) {                 // batches (older clients)
    const answers = (await Promise.all(body.map(m => handleMessage(m, tools, { log })))).filter(Boolean);
    return answers.length ? json(answers) : new Response(null, { status: 202, headers: CORS });
  }
  const answer = await handleMessage(body, tools, { log });
  return answer ? json(answer) : new Response(null, { status: 202, headers: CORS });
});
