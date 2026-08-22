import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { ApiKeys, MaskedApiKeys } from '../types/trading';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SECRET_FILE = path.join(DATA_DIR, 'secure_keys.dat');
const LEGACY_JSON = path.join(DATA_DIR, 'api_keys.json');

// Derive encryption key from a local server master salt or machine ID
const MASTER_SALT = 'upbit-quant-secure-salt-2026';
const configuredSecret = process.env.APP_SECRET || 'antigravity-upbit-secret-key-default';
const ENCRYPTION_KEY = crypto.scryptSync(configuredSecret, MASTER_SALT, 32);
const ALGORITHM = 'aes-256-gcm';

export class SecretManager {
  private static instance: SecretManager;
  private memoryKeys: ApiKeys = {};

  private constructor() {
    this.ensureDataDir();
    this.migrateAndLoad();
  }

  public static getInstance(): SecretManager {
    if (!SecretManager.instance) {
      SecretManager.instance = new SecretManager();
    }
    return SecretManager.instance;
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private migrateAndLoad() {
    // 1. If encrypted file exists, load from it
    if (fs.existsSync(SECRET_FILE)) {
      try {
        const raw = fs.readFileSync(SECRET_FILE, 'utf-8');
        const [ivHex, authTagHex, encryptedText] = raw.split(':');
        if (ivHex && authTagHex && encryptedText) {
          const iv = Buffer.from(ivHex, 'hex');
          const authTag = Buffer.from(authTagHex, 'hex');
          const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
          decipher.setAuthTag(authTag);
          let decrypted = decipher.update(encryptedText, 'hex', 'utf-8');
          decrypted += decipher.final('utf-8');
          this.memoryKeys = JSON.parse(decrypted);
          console.log('[SecretManager] Encrypted API keys safely loaded.');
          return;
        }
      } catch (e) {
        console.error('[SecretManager] Failed to decrypt secure keys file:', e);
      }
    }

    // 2. Fallback / Migration from legacy plaintext JSON
    if (fs.existsSync(LEGACY_JSON)) {
      try {
        const legacyRaw = fs.readFileSync(LEGACY_JSON, 'utf-8');
        this.memoryKeys = JSON.parse(legacyRaw);
        this.saveSecure();
        // Overwrite legacy json with masked version for safety
        fs.writeFileSync(LEGACY_JSON, JSON.stringify({ note: 'Keys migrated to secure storage' }, null, 2));
        console.log('[SecretManager] Legacy keys migrated to encrypted storage.');
      } catch (e) {
        console.error('[SecretManager] Failed to migrate legacy keys:', e);
      }
    }
  }

  public saveKeys(keys: ApiKeys) {
    this.memoryKeys = {
      upbitAccessKey: (keys.upbitAccessKey !== undefined ? keys.upbitAccessKey : this.memoryKeys.upbitAccessKey)?.trim(),
      upbitSecretKey: (keys.upbitSecretKey !== undefined ? keys.upbitSecretKey : this.memoryKeys.upbitSecretKey)?.trim(),
      telegramBotToken: (keys.telegramBotToken !== undefined ? keys.telegramBotToken : this.memoryKeys.telegramBotToken)?.trim(),
      telegramChatId: (keys.telegramChatId !== undefined ? keys.telegramChatId : this.memoryKeys.telegramChatId)?.trim()
    };
    this.saveSecure();
  }

  public saveTelegramConfig(telegramBotToken: string, telegramChatId: string) {
    const token = telegramBotToken.trim();
    const chatId = telegramChatId.trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
      throw new Error('텔레그램 BotFather API 토큰 형식이 올바르지 않습니다.');
    }
    if (!/^-?\d+$/.test(chatId)) {
      throw new Error('텔레그램 Chat ID는 숫자여야 합니다.');
    }
    this.saveKeys({ telegramBotToken: token, telegramChatId: chatId });
  }

  /** Best-effort notification: an alert failure must never affect trading. */
  public async sendTelegramAlert(text: string): Promise<boolean> {
    const token = this.memoryKeys.telegramBotToken;
    const chatId = this.memoryKeys.telegramChatId;
    if (!token || !chatId) return false;
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    // Node's fetch/undici can prefer an unavailable IPv6 route on this host.
    // Force the already verified IPv4 route without changing bot behaviour.
    return new Promise<boolean>((resolve) => {
      const request = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        family: 4,
        timeout: 8_000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (response) => {
        let responseBody = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => {
          const ok = Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300);
          if (!ok) {
            let description = '';
            try { description = JSON.parse(responseBody).description || ''; } catch {}
            console.warn(`[SecretManager] Telegram API rejected alert: HTTP ${response.statusCode}${description ? ` — ${description}` : ''}`);
          }
          resolve(ok);
        });
      });
      request.once('timeout', () => request.destroy(new Error('Telegram request timed out')));
      request.once('error', (e) => {
        console.warn('[SecretManager] Telegram alert delivery failed:', e.message);
        resolve(false);
      });
      request.write(body);
      request.end();
    });
  }

  private saveSecure() {
    try {
      this.ensureDataDir();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
      const text = JSON.stringify(this.memoryKeys);
      let encrypted = cipher.update(text, 'utf-8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');
      const payload = `${iv.toString('hex')}:${authTag}:${encrypted}`;
      fs.writeFileSync(SECRET_FILE, payload, 'utf-8');
    } catch (e) {
      console.error('[SecretManager] Error saving encrypted keys:', e);
    }
  }

  public getKeys(): ApiKeys {
    return { ...this.memoryKeys };
  }

  public static mask(key?: string): string {
    if (!key || key.length < 8) return '****';
    const prefix = key.slice(0, 4);
    const suffix = key.slice(-4);
    return `${prefix}************${suffix}`;
  }

  public getMaskedStatus(): MaskedApiKeys {
    return {
      hasUpbitKeys: Boolean(this.memoryKeys.upbitAccessKey && this.memoryKeys.upbitSecretKey),
      upbitAccessMasked: this.memoryKeys.upbitAccessKey ? SecretManager.mask(this.memoryKeys.upbitAccessKey) : undefined,
      hasTelegramAlerts: Boolean(this.memoryKeys.telegramBotToken && this.memoryKeys.telegramChatId),
      telegramChatIdMasked: this.memoryKeys.telegramChatId ? SecretManager.mask(this.memoryKeys.telegramChatId) : undefined
    };
  }
}
