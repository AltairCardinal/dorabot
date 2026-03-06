import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import type { Provider, ProviderAuthStatus, ProviderMessage, ProviderQueryResult, ProviderRunOptions } from './types.js';
import type { ProviderAuthMode } from '../config.js';
import { QWEN_AUTH_PATH, DORABOT_DIR } from '../workspace.js';

const QWEN_BAILIAN_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
const QWEN_PORTAL_BASE_URL = 'https://portal.qwen.ai/v1';
const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai';
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';

type QwenAuthStore = {
  paygKey?: string;
  codingPlanKey?: string;
  oauthTokens?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    resourceUrl?: string;
  };
};

type PendingOAuth = {
  loginId: string;
  deviceCode: string;
  verifier: string;
  expiresAt: number;
  pollIntervalMs: number;
};

function ensureDir(): void {
  mkdirSync(DORABOT_DIR, { recursive: true });
}

function loadStore(): QwenAuthStore {
  try {
    if (existsSync(QWEN_AUTH_PATH)) {
      return JSON.parse(readFileSync(QWEN_AUTH_PATH, 'utf-8')) as QwenAuthStore;
    }
  } catch {
    // ignore invalid file and treat as empty
  }
  return {};
}

function saveStore(store: QwenAuthStore): void {
  ensureDir();
  writeFileSync(QWEN_AUTH_PATH, JSON.stringify(store), { mode: 0o600 });
  chmodSync(QWEN_AUTH_PATH, 0o600);
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

function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
  const normalized = withProtocol.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function resolveBaseUrl(authMode: ProviderAuthMode, configured?: string, oauthResourceUrl?: string): string {
  const c = configured?.trim();
  if (authMode === 'oauth') {
    if (!c || c === QWEN_BAILIAN_BASE_URL) return normalizeBaseUrl(oauthResourceUrl || QWEN_PORTAL_BASE_URL);
    return normalizeBaseUrl(c);
  }
  if (!c || c === QWEN_PORTAL_BASE_URL) return normalizeBaseUrl(QWEN_BAILIAN_BASE_URL);
  return normalizeBaseUrl(c);
}

function resolveMode(configMode?: ProviderAuthMode): ProviderAuthMode {
  return configMode || 'payg';
}

async function refreshOAuthIfNeeded(store: QwenAuthStore): Promise<QwenAuthStore> {
  const oauth = store.oauthTokens;
  if (!oauth?.accessToken || oauth.expiresAt > now() + 60_000) return store;
  if (!oauth.refreshToken) return store;

  const response = await fetch(`${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: QWEN_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) return store;

  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const accessToken = payload.access_token?.trim();
  const refreshToken = payload.refresh_token?.trim() || oauth.refreshToken;
  const expiresIn = Number(payload.expires_in || 0);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) return store;

  const next: QwenAuthStore = {
    ...store,
    oauthTokens: {
      ...oauth,
      accessToken,
      refreshToken,
      expiresAt: now() + expiresIn * 1000,
    },
  };
  saveStore(next);
  return next;
}

export class QwenProvider implements Provider {
  readonly name = 'qwen';
  private pendingOAuth = new Map<string, PendingOAuth>();

  async checkReady(): Promise<{ ready: boolean; reason?: string }> {
    const auth = await this.getAuthStatus();
    if (!auth.authenticated) {
      return { ready: false, reason: auth.error || 'Not authenticated. Use API key or OAuth.' };
    }
    return { ready: true };
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const store = await refreshOAuthIfNeeded(loadStore());
    if (store.codingPlanKey) {
      return { authenticated: true, method: 'api_key', identity: 'Qwen API key (coding plan)' };
    }
    if (store.paygKey) {
      return { authenticated: true, method: 'api_key', identity: 'Qwen API key (payg)' };
    }
    const oauth = store.oauthTokens;
    if (oauth?.accessToken) {
      if (oauth.expiresAt > now()) {
        return { authenticated: true, method: 'oauth', identity: 'Qwen OAuth' };
      }
      return { authenticated: false, method: 'oauth', error: 'Qwen OAuth token expired. Re-authenticate.' };
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
      identity: `Qwen API key (${keyType === 'coding' ? 'coding plan' : 'payg'})`,
    };
  }

  async loginWithOAuth(_options?: Record<string, unknown>): Promise<{ authUrl: string; loginId: string }> {
    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);

    const response = await fetch(`${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: QWEN_OAUTH_CLIENT_ID,
        scope: 'openid profile email model.completion',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Qwen OAuth start failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json() as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      expires_in?: number;
      interval?: number;
    };

    if (!payload.device_code || !payload.verification_uri || !payload.expires_in) {
      throw new Error('Qwen OAuth response missing device_code/verification_uri/expires_in');
    }

    const loginId = `qwen-oauth-${Date.now()}`;
    this.pendingOAuth.set(loginId, {
      loginId,
      deviceCode: payload.device_code,
      verifier,
      expiresAt: now() + Number(payload.expires_in) * 1000,
      pollIntervalMs: payload.interval ? Number(payload.interval) * 1000 : 2000,
    });

    return {
      authUrl: payload.verification_uri_complete || payload.verification_uri,
      loginId,
    };
  }

  async completeOAuthLogin(loginId: string): Promise<ProviderAuthStatus> {
    const pending = this.pendingOAuth.get(loginId);
    if (!pending) return { authenticated: false, error: 'No pending OAuth login' };

    let interval = Math.max(1500, pending.pollIntervalMs || 2000);

    try {
      while (now() < pending.expiresAt) {
        const response = await fetch(`${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: QWEN_OAUTH_CLIENT_ID,
            device_code: pending.deviceCode,
            code_verifier: pending.verifier,
          }),
        });

        if (!response.ok) {
          let body: { error?: string; error_description?: string } = {};
          try {
            body = await response.json() as { error?: string; error_description?: string };
          } catch {
            body = {};
          }
          if (body.error === 'authorization_pending') {
            await new Promise((resolve) => setTimeout(resolve, interval));
            continue;
          }
          if (body.error === 'slow_down') {
            interval = Math.min(10000, Math.floor(interval * 1.5));
            await new Promise((resolve) => setTimeout(resolve, interval));
            continue;
          }
          return { authenticated: false, method: 'oauth', error: body.error_description || body.error || response.statusText };
        }

        const payload = await response.json() as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          resource_url?: string;
        };

        const accessToken = payload.access_token?.trim();
        const refreshToken = payload.refresh_token?.trim();
        const expiresIn = Number(payload.expires_in || 0);
        if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
          return { authenticated: false, method: 'oauth', error: 'Qwen OAuth token payload invalid' };
        }

        const store = loadStore();
        store.oauthTokens = {
          accessToken,
          refreshToken,
          expiresAt: now() + expiresIn * 1000,
          resourceUrl: payload.resource_url,
        };
        saveStore(store);

        return { authenticated: true, method: 'oauth', identity: 'Qwen OAuth' };
      }

      return { authenticated: false, method: 'oauth', error: 'Qwen OAuth timed out' };
    } finally {
      this.pendingOAuth.delete(loginId);
    }
  }

  async *query(opts: ProviderRunOptions): AsyncGenerator<ProviderMessage, ProviderQueryResult, unknown> {
    const qwenCfg = opts.config.provider?.qwen;
    const authMode = resolveMode(qwenCfg?.authMode);

    let store = loadStore();
    store = await refreshOAuthIfNeeded(store);

    const baseUrl = resolveBaseUrl(authMode, qwenCfg?.baseUrl, store.oauthTokens?.resourceUrl);
    const model = qwenCfg?.model || opts.model || (authMode === 'oauth' ? 'coder-model' : 'glm-5');

    const preferredKey = authMode === 'coding'
      ? (store.codingPlanKey || store.paygKey)
      : authMode === 'payg'
      ? (store.paygKey || store.codingPlanKey)
      : undefined;

    const token = preferredKey || store.oauthTokens?.accessToken;
    if (!token) {
      throw new Error('Qwen not authenticated. Configure API key or OAuth first.');
    }

    const messages: Array<Record<string, unknown>> = [];
    if (opts.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: opts.systemPrompt.trim() });
    }

    if (opts.images?.length) {
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: opts.prompt }];
      for (const img of opts.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        });
      }
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: opts.prompt });
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: opts.abortController?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Qwen request failed (${response.status}): ${text || response.statusText}`);
    }

    const data = await response.json() as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content?.trim() || '';
    const sessionId = String(data.id || `qwen-${Date.now()}`);

    yield {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    } as ProviderMessage;

    yield {
      type: 'result',
      result: text,
      session_id: sessionId,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
      total_cost_usd: 0,
    } as ProviderMessage;

    return {
      result: text,
      sessionId,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        totalCostUsd: 0,
      },
    };
  }
}
