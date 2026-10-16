import * as vscode from 'vscode';

export type SkillLevel = 1 | 2 | 3 | 4 | 5;
export type SkillSetting = 'auto' | '1' | '2' | '3' | '4' | '5';

export class SkillTracker {
  private static readonly KEY = '404Extension.errorCount';

  constructor(private readonly context: vscode.ExtensionContext) {}

  getLevel(): SkillLevel {
    const setting = vscode.workspace
      .getConfiguration('404Extension')
      .get<SkillSetting>('skillLevel', 'auto');

    if (setting !== 'auto') {
      const n = parseInt(setting, 10);
      if (n >= 1 && n <= 5) return n as SkillLevel;
    }

    const count = this.context.globalState.get<number>(SkillTracker.KEY, 0);
    if (count < 5) return 1;
    if (count < 15) return 2;
    if (count < 40) return 3;
    if (count < 100) return 4;
    return 5;
  }

  async record(): Promise<void> {
    const count = this.context.globalState.get<number>(SkillTracker.KEY, 0);
    await this.context.globalState.update(SkillTracker.KEY, count + 1);
  }

  async reset(): Promise<void> {
    await this.context.globalState.update(SkillTracker.KEY, 0);
  }

  async setManualLevel(level: SkillSetting): Promise<void> {
    await vscode.workspace
      .getConfiguration('404Extension')
      .update('skillLevel', level, vscode.ConfigurationTarget.Global);
  }
}

export function levelName(level: SkillLevel): string {
  switch (level) {
    case 1: return 'beginner';
    case 2: return 'early learner';
    case 3: return 'intermediate';
    case 4: return 'comfortable';
    case 5: return 'expert';
  }
}