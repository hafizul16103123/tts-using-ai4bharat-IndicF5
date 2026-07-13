export interface ApiUser {
  id: string;
  name: string;
}

export interface AppConfig {
  port: number;
  redisHost: string;
  redisPort: number;
  pythonTtsUrl: string;
  pythonTtsTimeoutMs: number;
  workerConcurrency: number;
  maxQueueSize: number;
  maxTextLength: number;
  rateLimitTtlMs: number;
  rateLimitMax: number;
  apiKeys: Map<string, ApiUser>;
}

function parseApiKeys(raw: string | undefined): Map<string, ApiUser> {
  const keys = new Map<string, ApiUser>();
  if (!raw) return keys;
  for (const entry of raw.split(',')) {
    const [key, name] = entry.split(':').map((s) => s.trim());
    if (!key || !name) continue;
    keys.set(key, { id: name, name });
  }
  return keys;
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  redisHost: process.env.REDIS_HOST ?? '127.0.0.1',
  redisPort: parseInt(process.env.REDIS_PORT ?? '6380', 10),
  pythonTtsUrl: process.env.PYTHON_TTS_URL ?? 'http://127.0.0.1:8000',
  pythonTtsTimeoutMs: parseInt(process.env.PYTHON_TTS_TIMEOUT_MS ?? '60000', 10),
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY ?? '1', 10),
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE ?? '20', 10),
  maxTextLength: parseInt(process.env.MAX_TEXT_LENGTH ?? '500', 10),
  rateLimitTtlMs: parseInt(process.env.RATE_LIMIT_TTL_MS ?? '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? '10', 10),
  apiKeys: parseApiKeys(process.env.API_KEYS),
});
