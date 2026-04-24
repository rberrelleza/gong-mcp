# Gong MCP Server

A remote MCP server that lets Claude query Okteto's Gong data — call listings and full transcripts — on behalf of any Okteto employee. It runs as an HTTPS service on Okteto, authenticates users via Google SSO against the `okteto.com` Workspace, and calls the Gong API with a single shared access key held on the server.

## How it works

- **Transport**: MCP Streamable HTTP at `POST /mcp`.
- **User auth**: OAuth 2.1 + PKCE. The MCP server *is* the authorization server; it delegates actual login to Google and restricts `hd=okteto.com`. After login, clients receive a short-lived JWT (1h) signed with a per-deployment secret.
- **Gong auth**: shared Gong access key/secret held in a Kubernetes `Secret`, never exposed to clients. All users' queries go through the same Gong integration.
- **Deployment**: Okteto, via `okteto.yaml`. Manifests live under `k8s/`. Auto-HTTPS via the Okteto ingress controller.

## Prerequisites

- [Okteto CLI](https://www.okteto.com/docs/getting-started/) with access to an Okteto cluster.
- Permission to create an OAuth client under the `okteto.com` Google Cloud organization.
- Gong API credentials (access key + secret) with read access to calls and transcripts.

## Deploy

### 1. Create a Google OAuth client

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** → Web application.
2. OAuth consent screen: **Internal** — this is what actually restricts sign-in to `@okteto.com`.
3. Authorized redirect URI: `https://gong-mcp-<namespace>.<okteto-domain>/oauth/google/callback`
   (on `demo.okteto.dev` with namespace `gong-mcp-rberrelleza`: `https://gong-mcp-gong-mcp-rberrelleza.demo.okteto.dev/oauth/google/callback`)
4. Save the **client ID** and **client secret**.

### 2. Set Okteto user variables

Okteto UI → User Settings → Variables:

| Variable | Value |
|---|---|
| `GONG_ACCESS_KEY` | Gong API access key |
| `GONG_ACCESS_SECRET` | Gong API access secret |
| `GONG_MCP_GOOGLE_CLIENT_ID` | From step 1 |
| `GONG_MCP_GOOGLE_CLIENT_SECRET` | From step 1 |

The deploy step derives `GONG_MCP_PUBLIC_URL` from `$OKTETO_NAMESPACE` + `$OKTETO_DOMAIN`, and generates + preserves `GONG_MCP_JWT_SECRET` across redeploys (so existing JWTs stay valid).

### 3. Deploy

```bash
okteto deploy --wait
okteto endpoints
```

## Connect Claude

Point any OAuth-capable MCP client at `<PUBLIC_URL>/mcp`. Claude drives the OAuth dance end-to-end — you'll be redirected to Google, sign in with your `@okteto.com` account, and end up connected.

- **claude.ai** → Settings → Connectors → Add custom connector → paste `<PUBLIC_URL>/mcp`.
- **Claude Desktop / Code** with an OAuth-capable transport: same URL.

## Security model

- Only `@okteto.com` Google Workspace accounts can sign in. Enforced at three layers: Google consent screen (Internal), `hd` + email check at the `/oauth/google/callback`, and email-domain check on every `/mcp` request's JWT.
- Gong credentials never leave the server. Users cannot see or extract them.
- Access tokens are signed with a per-deployment secret held in the k8s `Secret`; if the secret is rotated, all outstanding tokens become invalid.
- PKCE (S256) is required on every authorization flow.
- CORS is restricted to `https://claude.ai` for `/mcp`; OAuth discovery endpoints are CORS-open (per spec).

## Available tools

### `list_calls`

Lists Gong calls, optionally filtered by date range.

| Argument | Type | Notes |
|---|---|---|
| `fromDateTime` | string | ISO 8601, e.g. `2024-03-01T00:00:00Z` |
| `toDateTime` | string | ISO 8601, e.g. `2024-03-31T23:59:59Z` |

### `retrieve_transcripts`

Returns full transcripts for a list of call IDs, including per-speaker sentences with timestamps.

| Argument | Type | Notes |
|---|---|---|
| `callIds` | string[] | Required. Array of Gong call IDs |

## Repo layout

```
src/index.ts        — Express server: OAuth endpoints + MCP transport + Gong client
k8s/deployment.yaml — Deployment (mounts Secret as env via envFrom)
k8s/service.yaml    — Service with dev.okteto.com/auto-ingress annotation
okteto.yaml         — build + deploy steps (secret sync, manifest apply)
Dockerfile          — node:22-alpine, non-root, multi-stage build
```
