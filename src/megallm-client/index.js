import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class MegaLLMClient {
  constructor(sessionFilePath) {
    if (!sessionFilePath) {
      throw new Error('Veuillez spécifier le chemin vers le fichier de session (ex: ./megallm-session.json)');
    }
    this.sessionFile = path.resolve(sessionFilePath);
    this.session = null;
    this.defaultModel = 'claude-opus-4-6';
    this.apiUrl = 'https://megallm.io/api/chat';
  }

  _loadSession() {
    if (!fs.existsSync(this.sessionFile)) {
      throw new Error(`Fichier de session introuvable à : ${this.sessionFile}`);
    }
    this.session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
  }

  _getSecret() {
    const d = () => String.fromCharCode(77, 101, 103, 97, 76, 76, 77);
    const u = () => Buffer.from("X3B1YmxpYw==", 'base64').toString();
    const x = () => "_key";
    const m = () => String.fromCharCode(95, 50, 48, 50, 53);
    const f = () => Buffer.from("secure").toString('base64').substring(0, 6);
    const h = () => "_v2";
    const p = () => String.fromCharCode(95, 104, 109, 97, 99);
    const g = () => "_sig";
    const b = () => Buffer.from("X2ZpbmFs", 'base64').toString();
    const v = () => String.fromCharCode(95, 51, 50);

    const raw = [d, u, x, m, f, h, p, g, b, v].map(e => e()).join("");
    const encrypted = raw.split("").map((e, t) => String.fromCharCode(e.charCodeAt(0) ^ (42 + (t % 7)))).join("");
    return Buffer.from(encrypted).toString('base64');
  }

  _solvePow(challenge, difficulty = 2) {
    const prefix = "0".repeat(difficulty);
    let s = 0;
    while (true) {
      const hash = crypto.createHash('sha256').update(`${challenge}:${s}`).digest('hex');
      if (hash.startsWith(prefix)) return s.toString();
      if (++s > 1000000) throw new Error("PoW: Max attempts reached");
    }
  }

  _generateSecureHeaders(bodyString, method = "POST", endpoint = "/api/chat") {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(32).toString('hex');
    const powChallenge = crypto.randomBytes(32).toString('hex');
    const powSolution = this._solvePow(powChallenge, 2);
    const fingerprint = this.session?.extraHeaders?.['x-fingerprint'] || '';
    const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');

    const stringToSign = `${method}:${endpoint}:${timestamp}:${nonce}:${fingerprint}:${powSolution}:${bodyHash}`;
    const signature = crypto.createHmac('sha256', this._getSecret()).update(stringToSign).digest('hex');

    return {
      "x-timestamp": timestamp,
      "x-nonce": nonce,
      "x-pow-challenge": powChallenge,
      "x-pow-solution": powSolution,
      "x-signature": signature,
      "x-fingerprint": fingerprint,
    };
  }

  _extractChunkText(parsed) {
    if (!parsed) return '';
    if (typeof parsed === 'string') return parsed;
    return (
      parsed?.choices?.[0]?.delta?.content ||
      parsed?.choices?.[0]?.message?.content ||
      parsed?.delta?.content ||
      parsed?.message?.content ||
      parsed?.content ||
      ''
    );
  }

  async _readStreamResponse(res, onChunk) {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let done = false;
    let fullText = '';

    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (!chunk.value) continue;

      buffer += decoder.decode(chunk.value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('data:')) {
          const payload = trimmed.replace(/^data:\s*/, '');
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const text = this._extractChunkText(parsed);
            if (!text) continue;
            fullText += text;
            if (typeof onChunk === 'function') onChunk(text);
            continue;
          } catch {
            fullText += payload;
            if (typeof onChunk === 'function') onChunk(payload);
            continue;
          }
        }

        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed);
            const text = this._extractChunkText(parsed);
            if (!text) continue;
            fullText += text;
            if (typeof onChunk === 'function') onChunk(text);
            continue;
          } catch {
            // ignore malformed json line
          }
        }
      }
    }

    return fullText.trim();
  }

  async generate(prompt, options = {}) {
    const maxAttempts = options.maxAttempts || 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this._loadSession();

        const body = {
          model: options.model || this.defaultModel,
          messages: [
            { role: 'user', content: prompt },
          ],
          stream: options.stream || false,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens || 4096,
        };

        if (options.systemPrompt) {
          body.messages.unshift({ role: 'system', content: options.systemPrompt });
        }

        const bodyString = JSON.stringify(body);
        const extra = this.session?.extraHeaders || {};

        const headers = {
          "accept": "*/*",
          "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
          "cache-control": "no-cache",
          "content-type": "application/json",
          "origin": "https://megallm.io",
          "referer": "https://megallm.io/?home",
          "priority": "u=1, i",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "user-agent": extra['user-agent'] || '',
          "sec-ch-ua": extra['sec-ch-ua'] || '',
          "sec-ch-ua-mobile": extra['sec-ch-ua-mobile'] || '',
          "sec-ch-ua-platform": extra['sec-ch-ua-platform'] || '',
          "cookie": this.session?.cookieHeader || '',
          ...this._generateSecureHeaders(bodyString),
        };

        const res = await fetch(this.apiUrl, { method: 'POST', headers, body: bodyString });

        if (!res.ok) {
          const rawText = await res.text();
          const shortText = rawText.length > 600 ? `${rawText.substring(0, 600)}...` : rawText;
          const isRetryable = res.status === 429 || res.status >= 500;

          if (isRetryable && attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            continue;
          }

          throw new Error(`MegaLLM API Error (${res.status}): ${shortText}`);
        }

        if (options.stream === true) {
          return await this._readStreamResponse(res, options.onChunk);
        }

        const data = await res.json();
        return data.choices?.[0]?.message?.content || data.message || data.content || '';
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
      }
    }

    throw lastError || new Error('MegaLLM API Error: unknown');
  }
}

if (process.argv[1]?.endsWith('index.js')) {
  const candidates = [
    './megallm-session.json',
    './api/src/megallm-client/megallm-session.json',
    '../server/megallm-session.json'
  ];
  const sessionPath = candidates.find(p => fs.existsSync(p));

  if (!sessionPath) {
    console.error("Fichier megallm-session.json introuvable.");
    process.exit(1);
  }

  console.log('--- Test du MegaLLM Client ---');
  const client = new MegaLLMClient(sessionPath);
  console.log('Session:', client.sessionFile);
  console.log('Modèle :', client.defaultModel);
  console.log('Envoi en cours...\n');

  client.generate("Bonjour, donne moi juste le mot 'test' sans ponctuation.")
    .then(res => console.log('✅ Réponse :\n', res))
    .catch(err => console.error('❌ Erreur :\n', err.message));
}