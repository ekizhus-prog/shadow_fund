import crypto from 'node:crypto';

export class NansenClient {
  constructor({ apiKey, baseUrl = 'https://api.nansen.ai', onCall = () => {} }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.onCall = onCall;
  }

  async post(endpoint, body) {
    if (!this.apiKey) throw new Error('NANSEN_API_KEY is not configured; live mode is unavailable');
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    let response;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(`${this.baseUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apiKey: this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000)
        });
        break;
      } catch (error) {
        lastError = error;
        const cause = error.cause?.code ? ` (${error.cause.code})` : '';
        this.onCall({ endpoint, requestHash, status: 'error', httpStatus: null, credits: 0, error: `${error.message}${cause}` });
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!response) throw new Error(`Nansen ${endpoint} network request failed: ${lastError?.message || 'unknown error'}${lastError?.cause?.code ? ` (${lastError.cause.code})` : ''}`);
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 500) }; }
    this.onCall({ endpoint, requestHash, httpStatus: response.status, status: response.ok ? 'success' : 'error', credits: response.ok ? 1 : 0 });
    if (!response.ok) {
      const detail = payload?.message || payload?.detail || payload?.error || 'provider rejected the request';
      const field = payload?.param || payload?.errors?.[0]?.field;
      throw new Error(`Nansen ${endpoint} returned HTTP ${response.status}: ${detail}${field ? ` [${field}]` : ''}`);
    }
    return payload;
  }
}
