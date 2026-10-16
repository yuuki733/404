import * as vscode from 'vscode';

export type TeachingDepth = 1 | 2 | 3 | 4;

interface Store {
  [signature: string]: number;
}

export class MistakeTracker {
  private static readonly KEY = '404Extension.mistakeCounts';

  constructor(private readonly context: vscode.ExtensionContext) {}

  
  signature(errorMessage: string): string {
    return errorMessage
      .replace(/'[^']*'/g, "'X'")
      .replace(/"([^"]*)"/g, '"X"')
      .replace(/\b\d+\b/g, 'N')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  
  countBefore(errorMessage: string): number {
    const store = this.context.globalState.get<Store>(
      MistakeTracker.KEY,
      {}
    );
    return store[this.signature(errorMessage)] ?? 0;
  }

  async record(errorMessage: string): Promise<void> {
    const sig = this.signature(errorMessage);
    const store = {
      ...this.context.globalState.get<Store>(MistakeTracker.KEY, {})
    };
    store[sig] = (store[sig] ?? 0) + 1;
    await this.context.globalState.update(MistakeTracker.KEY, store);
  }

  async reset(): Promise<void> {
    await this.context.globalState.update(MistakeTracker.KEY, {});
  }

 
  depthFor(count: number): TeachingDepth {
    if (count <= 0) return 1;
    if (count <= 2) return 2;
    if (count <= 5) return 3;
    return 4;
  }
}