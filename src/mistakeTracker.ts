import * as vscode from 'vscode';
import { createHash } from 'crypto';

export type TeachingDepth = 1 | 2 | 3 | 4;
export type TrackingScope = 'per-workspace' | 'global';

interface Store {
  [signature: string]: number;
}

export class MistakeTracker {
  private static readonly KEY_PREFIX = '404Extension.mistakeCounts.';

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Signature of the error *type* — not the specific code. This way
   * `TS7006 on param name` and `TS7006 on param age` count as the same
   * mistake, because the user is making the same kind of error.
   */
  signature(errorMessage: string): string {
    return errorMessage
      .replace(/'[^']*'/g, "'X'")
      .replace(/"([^"]*)"/g, '"X"')
      .replace(/\b\d+\b/g, 'N')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Storage scope:
   *   per-workspace (default) — counts live with the project folder
   *   global                  — counts follow the user across all projects
   *
   * In per-workspace mode we also mix in the OS username so two people
   * sharing the same PC and the same folder keep their own progress.
   */
  private scopeKey(): string {
    const scope = vscode.workspace
      .getConfiguration('404Extension')
      .get<TrackingScope>('mistakeTracking.scope', 'per-workspace');

    if (scope === 'global') return 'global';

    const folder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '__no-workspace__';
    const osUser =
      process.env.USERNAME || process.env.USER || process.env.LOGNAME || '__anon__';

    const hash = createHash('sha256')
      .update(`${folder}::${osUser}`)
      .digest('hex')
      .slice(0, 16);

    return hash;
  }

  private fullKey(): string {
    return MistakeTracker.KEY_PREFIX + this.scopeKey();
  }

  private get store(): Store {
    return this.context.globalState.get<Store>(this.fullKey(), {});
  }

  countBefore(errorMessage: string): number {
    return this.store[this.signature(errorMessage)] ?? 0;
  }

  async record(errorMessage: string): Promise<void> {
    const sig = this.signature(errorMessage);
    const store = { ...this.store };
    store[sig] = (store[sig] ?? 0) + 1;
    await this.context.globalState.update(this.fullKey(), store);
  }

  /**
   * Clear counts for the current scope only. Other workspaces are untouched.
   */
  async reset(): Promise<void> {
    await this.context.globalState.update(this.fullKey(), {});
  }

  /**
   * Clear every scope on this machine. Only used by the "reset all" command.
   */
  async resetAll(): Promise<void> {
    const keys = this.context.globalState.keys();
    for (const k of keys) {
      if (k.startsWith(MistakeTracker.KEY_PREFIX)) {
        await this.context.globalState.update(k, undefined);
      }
    }
  }

  depthFor(count: number): TeachingDepth {
    if (count <= 0) return 1;
    if (count <= 2) return 2;
    if (count <= 5) return 3;
    return 4;
  }

  /**
   * Summary for the sidebar: how many distinct mistake types are being
   * tracked in this workspace, and which has the highest count.
   */
  summary(): { totalTypes: number; worstCount: number } {
    const store = this.store;
    let totalTypes = 0;
    let worstCount = 0;
    for (const v of Object.values(store)) {
      if (v > 0) {
        totalTypes++;
        if (v > worstCount) worstCount = v;
      }
    }
    return { totalTypes, worstCount };
  }
}