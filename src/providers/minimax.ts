import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import type { Provider, ProviderAuthStatus, ProviderMessage, ProviderQueryResult, ProviderRunOptions } from './types.js';
import type { MiniMaxRegion, ProviderAuthMode } from '../config.js';
import { MINIMAX_AUTH_PATH, DORABOT_DIR } from '../workspace.js';

const MINIMAX_DEFAULT_BASE_URLS: Record<MiniMaxRegion, string> = {
  global: 'https://api.minimax.io/anthropic',
  cn: 'https://api.minimaxi.com/anthropic',
};

const MINIMAX_OAUTH: Record<MiniMaxRegion, { baseUrl: string; clientId: string }> = {
  global: { baseUrl: 'https://api.minimax.io', clientId: '78257093-7e40-4613-99e0-527b14b39113' },
  cn: { baseUrl: 'https://api.minimaxi.com', clientId: '78257093-7e40-4613-99e0-527b14b39113' },
};

const MINIMAX_OAUTH_SCOPE = 'group_id profile model.completion';

type MiniMaxAuthStore = {
  paygKey?: string;
  codingPlanKey?: string;
  oauthTokens?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    region: MiniMaxRegion;
    resourceUrl?: string;
  };
};

type PendingOAuth = {
  loginId: string;
  region: MiniMaxRegion;
  userCode: string;
  verifier: string;
  expiresAt: number;
  pollIntervalMs: number;
};

function ensureDir(): void {
  mkdirSync(DORABOT_DIR, { recursive: true });
}

function loadStore(): MiniMaxAuthStore {
  try {
    if (existsSync(MINIMAX_AUTH_PATH)) {
      return JSON.parse(readFileSync(MINIMAX_AUTH_PATH, 'utf-8')) as MiniMaxAuthStore;
    }
  } catch {
    // ignore corrupted file and treat as empty
  }
  return {};
}

function saveStore(store: MiniMaxAuthStore): void {
  ensureDir();
  writeFileSync(MINIMAX_AUTH_PATH, JSON.stringify(store), { mode: 0o600 });
  chmodSync(MINIMAX_AUTH_PATH, 0o600);
}

function generateVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function now(): number {
  return Date.now();
}

function toMessagesUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (b.endsWith('/v1/messages')) return b;
  if (b.endsWith('/v1')) return `${b}/messages`;
  return `${b}/v1/messages`;
}

function resolveMode(configMode?: ProviderAuthMode): ProviderAuthMode {
  return configMode || 'payg';
}

export class MiniMaxProvider implements Provider {
  readonly name = 'minimax';
  private pendingOAuth = new Map<string, PendingOAuth>();

  async checkReady(): Promise<{ ready: boolean; reason?: string }> {
    const auth = await this.getAuthStatus();
    if (!auth.authenticated) {
      return { ready: false, reason: auth.error || 'Not authenticated. Use API key or OAuth.' };
    }
    return { ready: true };
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const store = loadStore();
    if (store.codingPlanKey) {
      return { authenticated: true, method: 'api_key', identity: 'MiniMax API key (coding plan)' };
    }
    if (store.paygKey) {
      return { authenticated: true, method: 'api_key', identity: 'MiniMax API key (payg)' };
    }
    const oauth = store.oauthTokens;
    if (oauth?.accessToken) {
      if (oauth.expiresAt > now()) {
        return { authenticated: true, method: 'oauth', identity: 'MiniMax OAuth' };
      }
      return { authenticated: false, method: 'oauth', error: 'MiniMax OAuth token expired. Re-authenticate.' };
    }
    return { authenticated: false, error: 'Not authenticated. Use provider.auth.apiKey or provider.auth.oauth.' };
  }

  async loginWithApiKey(apiKey: string, options?: { keyType?: 'payg' | 'coding' }): Promise<ProviderAuthStatus> {
    const key = apiKey.trim();
    if (!key) return { authenticated: false, method: 'api_key', error: 'API key required' };

    const store = loadStore();
    const keyType = options?.keyType === 'coding' ? 'coding' : 'payg';
    if (keyType === 'coding') {
      store.codingPlanKey = key;
    } else {
      store.paygKey = key;
    }
    saveStore(store);

    return {
      authenticated: true,
      method: 'api_key',
      identity: `MiniMax API key (${keyType === 'coding' ? 'coding plan' : 'payg'})`,
    };
  }

  async loginWithOAuth(options?: Record<string, unknown>): Promise<{ authUrl: string; loginId: string }> {
    const store = loadStore();
    const requestedRegion = options?.region;
    const region: MiniMaxRegion = requestedRegion === 'cn' || requestedRegion === 'global'
      ? requestedRegion
      : (store.oauthTokens?.region || 'global');
    const oauthCfg = MINIMAX_OAUTH[region];

    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);
    const state = randomBytes(16).toString('base64url');

    const response = await fetch(`${oauthCfg.baseUrl}/oauth/code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: oauthCfg.clientId,
        scope: MINIMAX_OAUTH_SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MiniMax OAuth start failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json() as {
      user_code?: string;
      verification_uri?: string;
      expired_in?: number;
      interval?: number;
      state?: string;
    };

    if (!payload.user_code || !payload.verification_uri || !payload.expired_in) {
      throw new Error('MiniMax OAuth response missing user_code/verification_uri/expired_in');
    }

    const loginId = `minimax-oauth-${Date.now()}`;
    this.pendingOAuth.set(loginId, {
      loginId,
      region,
      userCode: payload.user_code,
      verifier,
      expiresAt: Number(payload.expired_in),
      pollIntervalMs: payload.interval ? Number(payload.interval) : 2000,
    });

    return { authUrl: payload.verification_uri, loginId };
  }

  async completeOAuthLogin(loginId: string): Promise<ProviderAuthStatus> {
    const pending = this.pendingOAuth.get(loginId);
    if (!pending) return { authenticated: false, error: 'No pending OAuth login' };

    const oauthCfg = MINIMAX_OAUTH[pending.region];
    let interval = Math.max(1500, pending.pollIntervalMs || 2000);

    try {
      while (now() < pending.expiresAt) {
        const response = await fetch(`${oauthCfg.baseUrl}/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:user_code',
            client_id: oauthCfg.clientId,
            user_code: pending.userCode,
            code_verifier: pending.verifier,
          }),
        });

        const text = await response.text().catch(() => '');
        let body: Record<string, unknown> = {};
        try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = {}; }

        if (!response.ok) {
          return { authenticated: false, method: 'oauth', error: `MiniMax OAuth failed: ${text || response.statusText}` };
        }

        const status = String(body.status || '');
        if (status === 'success') {
          const accessToken = String(body.access_token || '').trim();
          const refreshToken = String(body.refresh_token || '').trim();
          const expiresIn = Number(body.expired_in || 0);
          const resourceUrl = typeof body.resource_url === 'string' ? body.resource_url : undefined;
          if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
            return { authenticated: false, method: 'oauth', error: 'MiniMax OAuth token payload invalid' };
          }

          const store = loadStore();
          store.oauthTokens = {
            accessToken,
            refreshToken,
            expiresAt: now() + expiresIn * 1000,
            region: pending.region,
            resourceUrl,
          };
          saveStore(store);
          return { authenticated: true, method: 'oauth', identity: 'MiniMax OAuth' };
        }

        if (status === 'error') {
          return { authenticated: false, method: 'oauth', error: 'MiniMax OAuth authorization failed' };
        }

        await new Promise((resolve) => setTimeout(resolve, interval));
        interval = Math.min(10000, Math.floor(interval * 1.5));
      }

      return { authenticated: false, method: 'oauth', error: 'MiniMax OAuth timed out' };
    } finally {
      this.pendingOAuth.delete(loginId);
    }
  }

  async *query(opts: ProviderRunOptions): AsyncGenerator<ProviderMessage, ProviderQueryResult, unknown> {
    const minimaxCfg = opts.config.provider?.minimax;
    const authMode = resolveMode(minimaxCfg?.authMode);
    const region = minimaxCfg?.region || 'global';
    const baseUrl = (minimaxCfg?.baseUrl || MINIMAX_DEFAULT_BASE_URLS[region]).trim();
    const model = minimaxCfg?.model || opts.model || 'MiniMax-M2.5';

    const store = loadStore();
    const preferredKey = authMode === 'coding'
      ? (store.codingPlanKey || store.paygKey)
      : authMode === 'payg'
      ? (store.paygKey || store.codingPlanKey)
      : undefined;

    let authHeader: string | null = null;
    if (preferredKey) {
      authHeader = preferredKey;
    } else if (store.oauthTokens?.accessToken && store.oauthTokens.expiresAt > now()) {
      authHeader = store.oauthTokens.accessToken;
    }

    if (!authHeader) {
      throw new Error('MiniMax not authenticated. Configure API key or OAuth first.');
    }

    const userBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: opts.prompt }];
    if (opts.images?.length) {
      for (const img of opts.images) {
        userBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        });
      }
    }

    const payload: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: userBlocks,
        },
      ],
    };

    if (opts.systemPrompt?.trim()) {
      payload.system = opts.systemPrompt.trim();
    }

    const response = await fetch(toMessagesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': authHeader,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: opts.abortController?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MiniMax request failed (${response.status}): ${text || response.statusText}`);
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      id?: string;
    };

    const text = (data.content || [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim();

    const sessionId = String(data.id || `minimax-${Date.now()}`);

    yield {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    } as ProviderMessage;

    yield {
      type: 'result',
      result: text,
      session_id: sessionId,
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
      },
      total_cost_usd: 0,
    } as ProviderMessage;

    return {
      result: text,
      sessionId,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        totalCostUsd: 0,
      },
    };
  }
}
