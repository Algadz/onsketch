# OnSketch for AI assistants (MCP connector)

People ask Claude or ChatGPT to draw something; the assistant calls the
OnSketch MCP server, which draws the sketch, saves it in their account and
returns a link to edit it (`https://onsketch.io/app/?project=<id>`).

## What is in the repo

| Piece | Where | What it does |
|---|---|---|
| Sketch format ("spec") | `app/src/core/spec.js` | The AI-facing format: named or `[x, y]` points, line / polyline / rectangle / circle / arc / point, 18 constraint types. `buildFromSpec()` checks it, builds a native `Project`, solves it and refuses contradictions or repeated constraints with messages that name the bad item. `projectToSpec()` turns a drawn sketch back into a spec (flags what it can't carry). |
| MCP protocol + tools | `supabase/functions/mcp/server.js` | Stateless Streamable HTTP (JSON answers). Tools: `create_sketch`, `get_sketch`, `update_sketch`, `list_sketches`. The format guide the assistant reads is `FORMAT` in this file. |
| Edge Function | `supabase/functions/mcp/index.ts` | Checks the OAuth token (`auth.getClaims`), answers 401 + `WWW-Authenticate` to start sign-in, serves `/.well-known/oauth-protected-resource`, runs every query as the user (RLS applies; no service key). |
| App modules for the function | `scripts/build-mcp.mjs` → `supabase/functions/mcp/_app/` (git-ignored) | Supabase deploys only the function's folder, so the needed `app/src` modules are copied there. Edit `app/src`, never `_app`. |
| Consent page | `oauth/consent/index.html`, `app/src/site/consent.js` | Where Supabase Auth sends the user: sign in (comes back), see who asks and where they go back to, Allow / Don't allow. |
| Limits for assistants | `supabase/migrations/0010_ai_assistants.sql` | Tokens issued to OAuth clients can't delete, change visibility, or touch profiles / likes. |
| Help page | `ai/index.html` (onsketch.io/ai/) | How to connect it in Claude and ChatGPT. Not in the sitemap yet. |
| Tests | `tests/unit/spec.test.js`, `tests/unit/mcp.test.js`, `tests/mcp.e2e.mjs`, `tests/consent.e2e.mjs` | Format, tools, sketches opening in the editor unchanged, consent flow. |

## Turning it on (once)

1. **Migration**: run `supabase/migrations/0010_ai_assistants.sql` in the SQL editor.
2. **OAuth 2.1 server** (Supabase Auth, public beta since Nov 2025). In the dashboard: Authentication → OAuth Server:
   - enable it;
   - authorization path: `/oauth/consent` (the Site URL must be `https://onsketch.io`);
   - allow **dynamic client registration** (Claude and ChatGPT register themselves).
   The supabase-js calls the consent page uses (`auth.oauth.getAuthorizationDetails`, `approveAuthorization`, `denyAuthorization`) were checked against supabase-js 2.119. The dashboard labels weren't checked from here (supabase.com docs were unreachable): follow "Getting Started with OAuth 2.1 Server" in the Supabase docs if they differ.
3. **JWT signing keys**: asymmetric keys (Settings → JWT Keys) let `getClaims` verify tokens locally; with the legacy secret it asks the Auth server instead (works, slower).
4. **Deploy**: `npm run mcp:deploy` (Supabase CLI, logged in, linked to the project). Endpoint: `https://rwmzpzaqijgdfsjmpqbd.supabase.co/functions/v1/mcp`.
5. **Check the claim name** used by `public.via_assistant()`: connect once, decode the assistant's access token (jwt.io) and confirm it has `client_id`. If not, change the function in 0010 and rerun it.
6. **Try it**: `npx @modelcontextprotocol/inspector`, transport Streamable HTTP, the URL above; it walks through the OAuth flow. Then add it in Claude (Settings → Connectors → Add custom connector) and ChatGPT (developer mode).

Discovery chain an MCP client follows: POST without token → 401 with
`resource_metadata=".../functions/v1/mcp/.well-known/oauth-protected-resource"`
→ `authorization_servers: [https://<project>.supabase.co/auth/v1]` → that
server's `/.well-known/oauth-authorization-server/auth/v1` metadata →
dynamic registration → browser to `/oauth/consent/` → code → token.

## Known limits (v1)

- No thumbnail is uploaded for sketches made by assistants (thumbnails are WebP made by the browser); My sketches shows a placeholder until the sketch is opened and saved in the editor. A server-side preview (SVG → PNG with resvg-wasm) would fix it and let the assistant see the result.
- `update_sketch` replaces the whole drawing and refuses sketches with ink, text, fills, curves, patterns, layers or formulas (it would lose them).
- Beziers, text, fills and layers can't be drawn by assistants yet.
- The free plan's sketches are public: `create_sketch` refuses until the assistant passes `"visibility": "public"`, which its instructions say to do only after asking the user.

## Next

1. Deploy and test with a real Claude and ChatGPT account (beta, help page linked from the FAQ).
2. Custom domain for the endpoint (`mcp.onsketch.io`; set `MCP_PUBLIC_URL`).
3. Preview image in tool results, thumbnails.
4. Collect failed specs (logs) and tune `FORMAT`.
5. Submit to Anthropic's connector directory and OpenAI's app directory (privacy policy, support contact, test account, tool annotations are in place).
