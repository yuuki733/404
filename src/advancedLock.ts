import * as vscode from 'vscode';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const STORAGE_KEY = '404Extension.advanced.passwordHash';

export class AdvancedLock {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async isEnabled(): Promise<boolean> {
    const stored = await this.context.secrets.get(STORAGE_KEY);
    return !!stored;
  }

  async setPassword(password: string): Promise<void> {
    if (!password || password.length < 4) {
      throw new Error('Password must be at least 4 characters.');
    }
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    const blob = salt.toString('hex') + ':' + hash.toString('hex');
    await this.context.secrets.store(STORAGE_KEY, blob);
  }

  async clear(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEY);
  }

  async verify(password: string): Promise<boolean> {
    const stored = await this.context.secrets.get(STORAGE_KEY);
    if (!stored) return true;
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = scryptSync(password, salt, expected.length);
      return timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}