#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import cors from 'cors';
import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const GONG_API_URL = 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;
const GONG_MCP_GOOGLE_CLIENT_ID = process.env.GONG_MCP_GOOGLE_CLIENT_ID;
const GONG_MCP_GOOGLE_CLIENT_SECRET = process.env.GONG_MCP_GOOGLE_CLIENT_SECRET;
const GONG_MCP_JWT_SECRET = process.env.GONG_MCP_JWT_SECRET;
const GONG_MCP_PUBLIC_URL = process.env.GONG_MCP_PUBLIC_URL;
const OKTETO_EMAIL_DOMAIN = 'okteto.com';
const PORT = Number(process.env.PORT ?? 3000);
const ACCESS_TOKEN_TTL_SECONDS = 3600;

const required: Record<string, string | undefined> = {
  GONG_ACCESS_KEY,
  GONG_ACCESS_SECRET,
  GONG_MCP_GOOGLE_CLIENT_ID,
  GONG_MCP_GOOGLE_CLIENT_SECRET,
  GONG_MCP_JWT_SECRET,
  GONG_MCP_PUBLIC_URL,
};
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Error: ${name} environment variable is required`);
    process.exit(1);
  }
}

interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  direction?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  url?: string;
}

interface GongTranscript {
  speakerId: string;
  topic?: string;
  sentences: Array<{
    start: number;
    text: string;
  }>;
}

interface GongListCallsResponse {
  calls: GongCall[];
}

interface GongRetrieveTranscriptsResponse {
  transcripts: GongTranscript[];
}

interface GongListCallsArgs {
  [key: string]: string | undefined;
  fromDateTime?: string;
  toDateTime?: string;
}

interface GongRetrieveTranscriptsArgs {
  callIds: string[];
}

class GongClient {
  private basicAuth: string;

  constructor(accessKey: string, accessSecret: string) {
    this.basicAuth = `Basic ${Buffer.from(`${accessKey}:${accessSecret}`).toString('base64')}`;
  }

  private async request<T>(method: string, path: string, params?: Record<string, string | undefined>, data?: Record<string, unknown>): Promise<T> {
    const url = `${GONG_API_URL}${path}`;
    try {
      const response = await axios({
        method,
        url,
        params,
        data,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.basicAuth,
        }
      });
      log('gong.request.success', { method, path, status: response.status });
      return response.data as T;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        log('gong.request.error', {
          method,
          path,
          status: err.response?.status ?? null,
          response_body: err.response?.data ?? null,
        });
      } else {
        log('gong.request.error', { method, path, reason: 'non_axios', details: String(err) });
      }
      throw err;
    }
  }

  async listCalls(fromDateTime?: string, toDateTime?: string): Promise<GongListCallsResponse> {
    const params: GongListCallsArgs = {};
    if (fromDateTime) params.fromDateTime = fromDateTime;
    if (toDateTime) params.toDateTime = toDateTime;

    return this.request<GongListCallsResponse>('GET', '/calls', params);
  }

  async retrieveTranscripts(callIds: string[]): Promise<GongRetrieveTranscriptsResponse> {
    return this.request<GongRetrieveTranscriptsResponse>('POST', '/calls/transcript', undefined, {
      filter: {
        callIds,
        includeEntities: true,
        includeInteractionsSummary: true,
        includeTrackers: true
      }
    });
  }
}

const gongClient = new GongClient(GONG_ACCESS_KEY!, GONG_ACCESS_SECRET!);

const LIST_CALLS_TOOL: Tool = {
  name: "list_calls",
  description: "List Gong calls with optional date range filtering. Returns call details including ID, title, start/end times, participants, and duration.",
  inputSchema: {
    type: "object",
    properties: {
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
      }
    }
  }
};

const RETRIEVE_TRANSCRIPTS_TOOL: Tool = {
  name: "retrieve_transcripts",
  description: "Retrieve transcripts for specified call IDs. Returns detailed transcripts including speaker IDs, topics, and timestamped sentences.",
  inputSchema: {
    type: "object",
    properties: {
      callIds: {
        type: "array",
        items: { type: "string" },
        description: "Array of Gong call IDs to retrieve transcripts for"
      }
    },
    required: ["callIds"]
  }
};

function isGongListCallsArgs(args: unknown): args is GongListCallsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    (!("fromDateTime" in args) || typeof (args as GongListCallsArgs).fromDateTime === "string") &&
    (!("toDateTime" in args) || typeof (args as GongListCallsArgs).toDateTime === "string")
  );
}

function isGongRetrieveTranscriptsArgs(args: unknown): args is GongRetrieveTranscriptsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    "callIds" in args &&
    Array.isArray((args as GongRetrieveTranscriptsArgs).callIds) &&
    (args as GongRetrieveTranscriptsArgs).callIds.every(id => typeof id === "string")
  );
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "example-servers/gong", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LIST_CALLS_TOOL, RETRIEVE_TRANSCRIPTS_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
    try {
      const { name, arguments: args } = request.params;

      if (!args) {
        throw new Error("No arguments provided");
      }

      switch (name) {
        case "list_calls": {
          if (!isGongListCallsArgs(args)) {
            throw new Error("Invalid arguments for list_calls");
          }
          const { fromDateTime, toDateTime } = args;
          const response = await gongClient.listCalls(fromDateTime, toDateTime);
          return {
            content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
            isError: false,
          };
        }

        case "retrieve_transcripts": {
          if (!isGongRetrieveTranscriptsArgs(args)) {
            throw new Error("Invalid arguments for retrieve_transcripts");
          }
          const { callIds } = args;
          const response = await gongClient.retrieveTranscripts(callIds);
          return {
            content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
            isError: false,
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        log('mcp.upstream_error_masked', {
          tool: request.params.name,
          upstream_status: error.response?.status ?? null,
        });
        return {
          content: [{ type: "text", text: "Internal server error" }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ============================================================
// OAuth 2.1 authorization server (delegates login to Google)
// ============================================================

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
}

interface PendingAuth {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  client_state: string;
  scope: string;
  created_at: number;
}

interface AuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  user_email: string;
  created_at: number;
}

const clients = new Map<string, RegisteredClient>();
const pendingAuths = new Map<string, PendingAuth>();
const authCodes = new Map<string, AuthCode>();

const TEN_MINUTES_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [state, pa] of pendingAuths) {
    if (now - pa.created_at > TEN_MINUTES_MS) pendingAuths.delete(state);
  }
  for (const [code, ac] of authCodes) {
    if (now - ac.created_at > TEN_MINUTES_MS) authCodes.delete(code);
  }
}, 60_000).unref();

interface AccessTokenPayload extends jwt.JwtPayload {
  email: string;
  client_id: string;
}

function issueAccessToken(userEmail: string, clientId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    sub: userEmail,
    email: userEmail,
    iss: GONG_MCP_PUBLIC_URL!,
    aud: GONG_MCP_PUBLIC_URL!,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    client_id: clientId,
  };
  return jwt.sign(payload, GONG_MCP_JWT_SECRET!, { algorithm: 'HS256' });
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  const payload = { ts: new Date().toISOString(), event, ...fields };
  console.log(JSON.stringify(payload));
}

function decodeJwtClaimsUnsafe(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const resourceMetadata = `${GONG_MCP_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  const header = req.headers.authorization;
  const clientInfo = {
    path: req.path,
    origin: req.headers.origin ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
  if (!header) {
    log('auth.fail', { reason: 'no_authorization_header', ...clientInfo });
    res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"`);
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  if (!header.startsWith('Bearer ')) {
    log('auth.fail', { reason: 'wrong_scheme', scheme_prefix: header.slice(0, 10), ...clientInfo });
    res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"`);
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, GONG_MCP_JWT_SECRET!, {
      algorithms: ['HS256'],
      issuer: GONG_MCP_PUBLIC_URL!,
      audience: GONG_MCP_PUBLIC_URL!,
    }) as AccessTokenPayload;
    if (!payload.email || !payload.email.endsWith(`@${OKTETO_EMAIL_DOMAIN}`)) {
      log('auth.fail', { reason: 'wrong_domain', email: payload.email, ...clientInfo });
      res.set('WWW-Authenticate', `Bearer error="insufficient_scope"`);
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    log('auth.success', { email: payload.email, client_id: payload.client_id, ...clientInfo });
    next();
  } catch (err) {
    const jwtError = err instanceof Error ? err.name : 'unknown';
    const jwtMessage = err instanceof Error ? err.message : String(err);
    const claims = decodeJwtClaimsUnsafe(token);
    log('auth.fail', {
      reason: 'jwt_verify_failed',
      jwt_error: jwtError,
      jwt_message: jwtMessage,
      token_length: token.length,
      claims_iss: claims?.iss ?? null,
      claims_aud: claims?.aud ?? null,
      claims_exp: claims?.exp ?? null,
      claims_email: claims?.email ?? null,
      claims_alg: null,
      ...clientInfo,
    });
    res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}", error="invalid_token"`);
    res.status(401).json({ error: 'invalid token' });
  }
}

const ALLOWED_ORIGINS = [
  'https://claude.ai',
  'https://www.claude.ai',
];

const app = express();

// Discovery endpoints must be CORS-open for any origin per MCP spec.
const publicCors = cors({ origin: '*', methods: ['GET', 'OPTIONS'], maxAge: 600 });

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Accept',
    'Mcp-Session-Id',
    'Mcp-Protocol-Version',
    'Last-Event-ID',
  ],
  exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
  credentials: false,
  maxAge: 600,
}));

app.get('/.well-known/oauth-protected-resource', publicCors, (_req, res) => {
  res.json({
    resource: GONG_MCP_PUBLIC_URL,
    authorization_servers: [GONG_MCP_PUBLIC_URL],
    bearer_methods_supported: ['header'],
  });
});

app.get('/.well-known/oauth-authorization-server', publicCors, (_req, res) => {
  res.json({
    issuer: GONG_MCP_PUBLIC_URL,
    authorization_endpoint: `${GONG_MCP_PUBLIC_URL}/authorize`,
    token_endpoint: `${GONG_MCP_PUBLIC_URL}/token`,
    registration_endpoint: `${GONG_MCP_PUBLIC_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
});

app.post('/register', express.json({ limit: '16kb' }), (req, res) => {
  const body = req.body ?? {};
  const redirect_uris = body.redirect_uris;
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || !redirect_uris.every((u: unknown) => typeof u === 'string')) {
    log('oauth.register.error', { reason: 'invalid_redirect_uris', body_keys: Object.keys(body) });
    res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    return;
  }
  const client_id = crypto.randomUUID();
  const client: RegisteredClient = {
    client_id,
    redirect_uris,
    client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
    created_at: Date.now(),
  };
  clients.set(client_id, client);
  log('oauth.register.success', {
    client_id,
    client_name: client.client_name ?? null,
    redirect_uris,
    ua: req.headers['user-agent'] ?? null,
  });
  res.status(201).json({
    client_id,
    redirect_uris,
    client_name: client.client_name,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
});

app.get('/authorize', (req, res) => {
  const {
    client_id,
    redirect_uri,
    response_type,
    scope,
    state: client_state,
    code_challenge,
    code_challenge_method,
  } = req.query as Record<string, string | undefined>;

  log('oauth.authorize.start', {
    client_id: client_id ?? null,
    redirect_uri: redirect_uri ?? null,
    response_type: response_type ?? null,
    scope: scope ?? null,
    has_pkce: !!code_challenge,
    pkce_method: code_challenge_method ?? null,
  });
  if (response_type !== 'code') {
    log('oauth.authorize.error', { reason: 'bad_response_type', response_type: response_type ?? null });
    res.status(400).send('response_type must be code');
    return;
  }
  if (!client_id || !redirect_uri) {
    log('oauth.authorize.error', { reason: 'missing_client_or_redirect' });
    res.status(400).send('client_id and redirect_uri required');
    return;
  }
  const client = clients.get(client_id);
  if (!client) {
    log('oauth.authorize.error', { reason: 'unknown_client_id', client_id, known_clients: clients.size });
    res.status(400).send('invalid client_id');
    return;
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    log('oauth.authorize.error', { reason: 'redirect_uri_not_registered', client_id, redirect_uri, registered: client.redirect_uris });
    res.status(400).send('redirect_uri not registered for this client');
    return;
  }
  if (!code_challenge || code_challenge_method !== 'S256') {
    log('oauth.authorize.error', { reason: 'missing_or_bad_pkce', has_challenge: !!code_challenge, method: code_challenge_method ?? null });
    res.status(400).send('PKCE with S256 required');
    return;
  }

  const ourState = crypto.randomBytes(16).toString('hex');
  pendingAuths.set(ourState, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    client_state: client_state ?? '',
    scope: scope ?? 'mcp',
    created_at: Date.now(),
  });

  const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleUrl.searchParams.set('client_id', GONG_MCP_GOOGLE_CLIENT_ID!);
  googleUrl.searchParams.set('redirect_uri', `${GONG_MCP_PUBLIC_URL}/oauth/google/callback`);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope', 'openid email profile');
  googleUrl.searchParams.set('state', ourState);
  googleUrl.searchParams.set('hd', OKTETO_EMAIL_DOMAIN);
  googleUrl.searchParams.set('prompt', 'select_account');
  googleUrl.searchParams.set('access_type', 'online');

  res.redirect(googleUrl.toString());
});

app.get('/oauth/google/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) {
    log('oauth.google.callback.error', { reason: 'google_returned_error', google_error: error });
    res.status(400).send(`google oauth error: ${error}`);
    return;
  }
  if (!code || !state) {
    log('oauth.google.callback.error', { reason: 'missing_code_or_state', has_code: !!code, has_state: !!state });
    res.status(400).send('missing code or state');
    return;
  }
  const pending = pendingAuths.get(state);
  if (!pending) {
    log('oauth.google.callback.error', { reason: 'invalid_or_expired_state', pending_count: pendingAuths.size });
    res.status(400).send('invalid or expired state');
    return;
  }
  pendingAuths.delete(state);

  try {
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: GONG_MCP_GOOGLE_CLIENT_ID!,
        client_secret: GONG_MCP_GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${GONG_MCP_PUBLIC_URL}/oauth/google/callback`,
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data as { access_token: string };
    const userInfoRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { email, email_verified, hd } = userInfoRes.data as {
      email?: string;
      email_verified?: boolean;
      hd?: string;
    };
    if (!email || !email_verified) {
      log('oauth.google.callback.error', { reason: 'email_not_verified', email: email ?? null });
      res.status(403).send('email not verified by google');
      return;
    }
    if (hd !== OKTETO_EMAIL_DOMAIN || !email.endsWith(`@${OKTETO_EMAIL_DOMAIN}`)) {
      log('oauth.google.callback.error', { reason: 'wrong_domain', email, hd: hd ?? null });
      res.status(403).send(`access restricted to @${OKTETO_EMAIL_DOMAIN} accounts`);
      return;
    }

    const ourCode = crypto.randomBytes(32).toString('hex');
    authCodes.set(ourCode, {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      code_challenge_method: pending.code_challenge_method,
      user_email: email,
      created_at: Date.now(),
    });

    log('oauth.google.callback.success', { email, client_id: pending.client_id });

    const redirectUrl = new URL(pending.redirect_uri);
    redirectUrl.searchParams.set('code', ourCode);
    if (pending.client_state) redirectUrl.searchParams.set('state', pending.client_state);
    res.redirect(redirectUrl.toString());
  } catch (e: unknown) {
    const message = axios.isAxiosError(e) ? JSON.stringify(e.response?.data ?? e.message) : String(e);
    log('oauth.google.callback.error', { reason: 'token_exchange_exception', details: message });
    res.status(500).send('token exchange failed');
  }
});

app.post('/token', express.urlencoded({ extended: true }), (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body as Record<string, string | undefined>;
  log('oauth.token.request', {
    grant_type: grant_type ?? null,
    client_id: client_id ?? null,
    has_code: !!code,
    has_verifier: !!code_verifier,
  });
  if (grant_type !== 'authorization_code') {
    log('oauth.token.error', { reason: 'unsupported_grant_type', grant_type: grant_type ?? null });
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  if (!code || !redirect_uri || !client_id || !code_verifier) {
    log('oauth.token.error', { reason: 'missing_fields', has_code: !!code, has_redirect_uri: !!redirect_uri, has_client_id: !!client_id, has_verifier: !!code_verifier });
    res.status(400).json({ error: 'invalid_request', error_description: 'code, redirect_uri, client_id, code_verifier required' });
    return;
  }
  const authCode = authCodes.get(code);
  if (!authCode) {
    log('oauth.token.error', { reason: 'unknown_or_reused_code', client_id });
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  authCodes.delete(code);
  if (authCode.client_id !== client_id || authCode.redirect_uri !== redirect_uri) {
    log('oauth.token.error', {
      reason: 'client_or_redirect_mismatch',
      request_client_id: client_id,
      code_client_id: authCode.client_id,
      redirect_match: authCode.redirect_uri === redirect_uri,
    });
    res.status(400).json({ error: 'invalid_grant', error_description: 'client/redirect mismatch' });
    return;
  }
  const computed = crypto.createHash('sha256').update(code_verifier).digest('base64url');
  if (computed !== authCode.code_challenge) {
    log('oauth.token.error', { reason: 'pkce_failed', client_id, email: authCode.user_email });
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    return;
  }
  const token = issueAccessToken(authCode.user_email, authCode.client_id);
  log('oauth.token.success', { client_id, email: authCode.user_email, expires_in: ACCESS_TOKEN_TTL_SECONDS });
  res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: 'mcp',
  });
});

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/mcp', requireAuth, async (req, res) => {
  const body = req.body as { method?: string; params?: { name?: string } } | undefined;
  log('mcp.request', {
    method: body?.method ?? null,
    tool: body?.params?.name ?? null,
  });
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log('mcp.error', {
      method: body?.method ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal error' });
    }
  }
});

app.get('/mcp', requireAuth, (_req, res) => {
  res.status(405).json({ error: 'method not allowed in stateless mode' });
});

app.delete('/mcp', requireAuth, (_req, res) => {
  res.status(405).json({ error: 'method not allowed in stateless mode' });
});

app.listen(PORT, () => {
  log('server.start', {
    port: PORT,
    public_url: GONG_MCP_PUBLIC_URL,
    allowed_domain: OKTETO_EMAIL_DOMAIN,
    access_token_ttl_s: ACCESS_TOKEN_TTL_SECONDS,
    jwt_secret_len: GONG_MCP_JWT_SECRET!.length,
  });
});
