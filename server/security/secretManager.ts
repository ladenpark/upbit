import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ApiKeys, MaskedApiKeys } from '../types/trading';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SECRET_FILE = path.join(DATA_DIR, 'secure_keys.dat');
const LEGACY_JSON = path.join(DATA_DIR, 'api_keys.json');

// Derive encryption key from a local server master salt or machine ID
const MASTER_SALT = 'upbit-quant-secure-salt-2026';
const configuredSecret = process.env.APP_SECRET;
if (process.env.NODE_ENV === 'production' && !configuredSecret) {
  throw new Error('APP_SECRET is required in production to encrypt exchange API keys.');
}
// Development keeps backward compatibility with the existing local key file,
// while production never falls back to a source-visible encryption secret.
const ENCRYPTION_KEY = crypto.scryptSync(configuredSecret || 'antigravity-upbit-secret-key-default', MASTER_SALT, 32);
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
      upbitSecretKey: (keys.upbitSecretKey !== undefined ? keys.upbitSecretKey : this.memoryKeys.upbitSecretKey)?.trim()
    };
    this.saveSecure();
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
      upbitAccessMasked: this.memoryKeys.upbitAccessKey ? SecretManager.mask(this.memoryKeys.upbitAccessKey) : undefined
    };
  }
}
