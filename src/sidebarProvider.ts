import * as vscode from 'vscode';
import { SkillTracker, SkillSetting, SkillLevel } from './skillTracker';
import { PROVIDERS, PROVIDER_IDS, ProviderId } from './providers/types';
import {
  getProvider,
  setApiKey,
  deleteApiKey,
  hasApiKey,
  resolveTarget,
  getApiKey
} from './providers/registry';
import {
  TASK_TYPES,
  TASK_LABELS,
  TASK_DESCRIPTIONS,
  TaskType
} from './taskRouter';
import { AdvancedLock } from './advancedLock';

interface TaskProfileState {
  provider: ProviderId | '';
  model: string;
}

interface SidebarState {
  skillLevel: SkillSetting;
  effectiveLevel: SkillLevel;
  useAI: boolean;
  provider: ProviderId;
  baseUrl: string;
  defaultBaseUrl: string;
  model: string;
  apiKeySet: boolean;
  providerRequiresKey: boolean;
  availableModels: string[];
  providerModels: Record<string, string[]>;
  providersWithoutKeys: ProviderId[];
  status: 'idle' | 'checking' | 'ok' | 'bad';
  statusMessage: string;
  testing: boolean;
  loadingModels: boolean;
  taskProfilesEnabled: boolean;
  taskProfiles: Record<TaskType, TaskProfileState>;
  totalIssues: number;
  logicCount: number;
  fixing: boolean;
  advancedLockEnabled: boolean;
  advancedUnlocked: boolean;
}

const LEVEL_COLORS: Record<number, string> = {
  1: '#3fb950',
  2: '#56d364',
  3: '#d29922',
  4: '#f0883e',
  5: '#f85149'
};

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = '404extension.mainView';
  private view?: vscode.WebviewView;

  private status: SidebarState['status'] = 'idle';
  private statusMessage = '';
  private testing = false;
  private loadingModels = false;
  private fixing = false;
  private advancedUnlocked = false;

  private modelsCache = new Map<ProviderId, string[]>();
  private providersWithoutKeys = new Set<ProviderId>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly skillTracker: SkillTracker,
    private readonly advancedLock: AdvancedLock
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.render();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case 'ready':
            await this.autoLoadModels();
            await this.sendStateAsync();
            break;

          case 'refreshModels':
            this.modelsCache.clear();
            await this.autoLoadModels();
            await this.sendStateAsync();
            break;

          case 'loadProviderModels': {
            const providerId = message.provider as ProviderId;
            await this.loadModelsForProvider(providerId);
            await this.sendStateAsync();
            break;
          }

          case 'testProvider':
            await this.runRealTest();
            await this.sendStateAsync();
            break;

          case 'fixAll':
            await vscode.commands.executeCommand('404Extension.fixAll');
            break;

          case 'openProblems':
            await vscode.commands.executeCommand(
              'workbench.actions.view.problems'
            );
            break;

          case 'unlockAdvanced': {
            const pwd = await vscode.window.showInputBox({
              prompt: 'Enter the advanced settings password',
              password: true,
              ignoreFocusOut: true
            });
            if (pwd === undefined) break;
            const ok = await this.advancedLock.verify(pwd);
            if (!ok) {
              void vscode.window.showErrorMessage(
                '404 Extension: Incorrect password.'
              );
              break;
            }
            this.advancedUnlocked = true;
            await this.sendStateAsync();
            break;
          }

          case 'lockAdvancedNow':
            this.advancedUnlocked = false;
            await this.sendStateAsync();
            break;

          case 'setAdvancedPassword':
            await vscode.commands.executeCommand(
              '404Extension.setAdvancedPassword'
            );
            break;

          case 'removeAdvancedPassword':
            await vscode.commands.executeCommand(
              '404Extension.removeAdvancedPassword'
            );
            break;

          case 'setSkillLevel':
            await this.skillTracker.setManualLevel(message.value as SkillSetting);
            await this.sendStateAsync();
            break;

          case 'setUseAI':
            await this.update('useAI', Boolean(message.value));
            await this.sendStateAsync();
            break;

          case 'setProvider':
            await this.update('provider', String(message.value));
            this.status = 'idle';
            this.statusMessage = '';
            await this.autoLoadModels();
            await this.sendStateAsync();
            break;

          case 'setBaseUrl': {
            const provider = message.provider as ProviderId;
            await this.update(`providerUrls.${provider}`, String(message.value));
            this.modelsCache.delete(provider);
            this.status = 'idle';
            this.statusMessage = '';
            await this.autoLoadModels();
            await this.sendStateAsync();
            break;
          }

          case 'resetBaseUrl': {
            const provider = message.provider as ProviderId;
            await vscode.workspace
              .getConfiguration('404Extension')
              .update(
                `providerUrls.${provider}`,
                '',
                vscode.ConfigurationTarget.Global
              );
            this.modelsCache.delete(provider);
            await this.autoLoadModels();
            await this.sendStateAsync();
            break;
          }

          case 'setModel':
            await this.update('model', String(message.value));
            await this.sendStateAsync();
            break;

          case 'setApiKey': {
            const providerId = message.provider as ProviderId;
            const key = await vscode.window.showInputBox({
              prompt: `Paste your ${PROVIDERS[providerId].label} API key`,
              password: true,
              ignoreFocusOut: true,
              validateInput: v =>
                v && v.trim().length > 8 ? undefined : 'Key looks too short.'
            });
            if (key) {
              await setApiKey(this.context, providerId, key);
              this.modelsCache.delete(providerId);
              await this.loadModelsForProvider(providerId);
              await this.sendStateAsync();
            }
            break;
          }

          case 'clearApiKey': {
            const providerId = message.provider as ProviderId;
            await deleteApiKey(this.context, providerId);
            this.modelsCache.delete(providerId);
            await this.sendStateAsync();
            break;
          }

          case 'setTaskProfilesEnabled':
            await this.update('taskProfiles.enabled', Boolean(message.value));
            await this.sendStateAsync();
            break;

          case 'setTaskProfile': {
            const task = String(message.task);
            if (typeof message.provider === 'string') {
              await this.update(`taskProfiles.${task}.provider`, message.provider);
              await this.update(`taskProfiles.${task}.model`, '');
            }
            if (typeof message.model === 'string') {
              await this.update(`taskProfiles.${task}.model`, message.model);
            }
            await this.sendStateAsync();
            break;
          }

          case 'clearCache':
            await this.context.globalState.update('404Extension.cache', {});
            void vscode.window.showInformationMessage(
              '404 Extension cache cleared.'
            );
            await this.sendStateAsync();
            break;

          case 'openSettings':
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '404Extension'
            );
            break;
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `404 Extension: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
      }
    });

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('404Extension')) void this.sendStateAsync();
      })
    );

    this.context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics(() => {
        void this.sendStateAsync();
      })
    );
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        void this.sendStateAsync();
      })
    );
  }

  public refresh(): void {
    void this.sendStateAsync();
  }

  public setFixing(value: boolean): void {
    this.fixing = value;
    void this.sendStateAsync();
  }

  private async update(key: string, value: unknown): Promise<void> {
    await vscode.workspace
      .getConfiguration('404Extension')
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  private postMessage(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private async sendStateAsync(): Promise<void> {
    const state = await this.buildState();
    this.postMessage({ type: 'state', state });
  }

  private async buildState(): Promise<SidebarState> {
    const config = vscode.workspace.getConfiguration('404Extension');

    const rawProvider = config.get<string>('provider', 'ollama-local');
    const provider: ProviderId = (PROVIDER_IDS as string[]).includes(rawProvider)
      ? (rawProvider as ProviderId)
      : 'ollama-local';

    const overrideUrl = config.get<string>(`providerUrls.${provider}`, '');
    const defaultUrl = PROVIDERS[provider].defaultBaseUrl;

    this.providersWithoutKeys.clear();
    for (const id of PROVIDER_IDS) {
      if (!PROVIDERS[id].requiresKey) continue;
      const has = await hasApiKey(this.context, id);
      if (!has) this.providersWithoutKeys.add(id);
    }

    const taskProfiles: Record<TaskType, TaskProfileState> = {
      debug: {
        provider: (config.get<string>('taskProfiles.debug.provider', '') ||
          '') as ProviderId | '',
        model: config.get<string>('taskProfiles.debug.model', '')
      },
      reasoning: {
        provider: (config.get<string>('taskProfiles.reasoning.provider', '') ||
          '') as ProviderId | '',
        model: config.get<string>('taskProfiles.reasoning.model', '')
      },
      math: {
        provider: (config.get<string>('taskProfiles.math.provider', '') ||
          '') as ProviderId | '',
        model: config.get<string>('taskProfiles.math.model', '')
      },
      code: {
        provider: (config.get<string>('taskProfiles.code.provider', '') ||
          '') as ProviderId | '',
        model: config.get<string>('taskProfiles.code.model', '')
      }
    };

    const providerModels: Record<string, string[]> = {};
    for (const [k, v] of this.modelsCache) providerModels[k] = v;

    let totalIssues = 0;
    let logicCount = 0;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const all = vscode.languages.getDiagnostics(editor.document.uri);
      for (const d of all) {
        if (
          d.severity !== vscode.DiagnosticSeverity.Error &&
          d.severity !== vscode.DiagnosticSeverity.Warning
        ) {
          continue;
        }
        totalIssues++;
        if (d.source === '404 (logic)') logicCount++;
      }
    }

    const advancedLockEnabled = await this.advancedLock.isEnabled();

    return {
      skillLevel: config.get<SkillSetting>('skillLevel', 'auto'),
      effectiveLevel: this.skillTracker.getLevel(),
      useAI: config.get<boolean>('useAI', true),
      provider,
      baseUrl: overrideUrl || defaultUrl,
      defaultBaseUrl: defaultUrl,
      model: config.get<string>('model', 'phi3:mini'),
      apiKeySet: !this.providersWithoutKeys.has(provider),
      providerRequiresKey: PROVIDERS[provider].requiresKey,
      availableModels: this.modelsCache.get(provider) ?? [],
      providerModels,
      providersWithoutKeys: Array.from(this.providersWithoutKeys),
      status: this.status,
      statusMessage: this.statusMessage,
      testing: this.testing,
      loadingModels: this.loadingModels,
      taskProfilesEnabled: config.get<boolean>('taskProfiles.enabled', false),
      taskProfiles,
      totalIssues,
      logicCount,
      fixing: this.fixing,
      advancedLockEnabled,
      advancedUnlocked: !advancedLockEnabled || this.advancedUnlocked
    };
  }

  private async autoLoadModels(): Promise<void> {
    const target = await resolveTarget(this.context, 'debug');
    await this.loadModelsForProvider(
      target.providerId,
      target.baseUrl,
      target.apiKey
    );
  }

  private async loadModelsForProvider(
    providerId: ProviderId,
    baseUrlOverride?: string,
    apiKeyOverride?: string
  ): Promise<void> {
    const meta = PROVIDERS[providerId];

    const config = vscode.workspace.getConfiguration('404Extension');
    const baseUrl =
      baseUrlOverride ||
      config.get<string>(`providerUrls.${providerId}`, '') ||
      meta.defaultBaseUrl;

    let apiKey = apiKeyOverride;
    if (meta.requiresKey && !apiKey) {
      apiKey = await getApiKey(this.context, providerId);
    }

    if (meta.requiresKey && !apiKey) {
      this.modelsCache.set(providerId, []);
      if (providerId === config.get<ProviderId>('provider', 'ollama-local')) {
        this.status = 'idle';
        this.statusMessage = `${meta.label} needs an API key to list models.`;
      }
      return;
    }

    const isMainProvider =
      providerId === config.get<ProviderId>('provider', 'ollama-local');

    if (isMainProvider) {
      this.loadingModels = true;
      await this.sendStateAsync();
    }

    try {
      const provider = getProvider(providerId);
      const models = await provider.listModels(baseUrl, apiKey);
      this.modelsCache.set(providerId, models);

      if (isMainProvider) {
        if (models.length === 0) {
          this.status = 'bad';
          this.statusMessage = 'No models available.';
        } else {
          this.status = 'ok';
          this.statusMessage = `${models.length} model${
            models.length === 1 ? '' : 's'
          } available.`;
        }
      }
    } catch (err) {
      this.modelsCache.set(providerId, []);
      if (isMainProvider) {
        this.status = 'bad';
        this.statusMessage =
          err instanceof Error ? err.message : 'Could not reach provider.';
      }
    } finally {
      if (isMainProvider) this.loadingModels = false;
    }
  }

  private async runRealTest(): Promise<void> {
    this.testing = true;
    this.status = 'checking';
    this.statusMessage = 'Testing…';
    await this.sendStateAsync();

    const target = await resolveTarget(this.context, 'debug');
    const meta = PROVIDERS[target.providerId];

    if (meta.requiresKey && !target.apiKey) {
      this.testing = false;
      this.status = 'bad';
      this.statusMessage = `${meta.label} requires an API key.`;
      return;
    }

    try {
      const provider = getProvider(target.providerId);
      const msg = await provider.test(target.baseUrl, target.apiKey, target.model);
      const models = await provider
        .listModels(target.baseUrl, target.apiKey)
        .catch(() => []);
      this.modelsCache.set(target.providerId, models);
      this.testing = false;
      this.status = 'ok';
      this.statusMessage = msg;
    } catch (err) {
      this.testing = false;
      this.status = 'bad';
      this.statusMessage = err instanceof Error ? err.message : 'Unknown error';
    }
  }

  private render(): string {
    const nonce = randomNonce();
    const colorsJson = JSON.stringify(LEVEL_COLORS);
    const providersJson = JSON.stringify(
      PROVIDER_IDS.map(id => ({
        id,
        label: PROVIDERS[id].label,
        requiresKey: PROVIDERS[id].requiresKey
      }))
    );
    const taskTypesJson = JSON.stringify(TASK_TYPES);
    const taskLabelsJson = JSON.stringify(TASK_LABELS);
    const taskDescJson = JSON.stringify(TASK_DESCRIPTIONS);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { --pad: 14px; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    padding: var(--pad);
    margin: 0;
    line-height: 1.4;
  }
  h2 {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 8px 0;
    font-weight: 700;
  }
  h2 + * { margin-top: 0; }
  .section { margin-bottom: 20px; }

  /* Action bar */
  .action-bar { margin-bottom: 16px; }
  .fix-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 10px 14px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    width: 100%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .fix-btn:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  .fix-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .logic-warning {
    display: none;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    background: rgba(255, 180, 0, 0.12);
    border: 1px solid rgba(255, 180, 0, 0.45);
    color: #d29922;
    font-size: 11px;
    cursor: pointer;
    user-select: none;
  }
  .logic-warning:hover {
    background: rgba(255, 180, 0, 0.2);
  }
  .logic-warning .icon {
    font-size: 13px;
    line-height: 1;
    flex-shrink: 0;
  }
  .logic-warning .text {
    flex: 1;
  }

  .fix-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    margin: 6px 0 0 0;
    line-height: 1.3;
  }

  /* Skill slider */
  .level-display { text-align: center; margin-bottom: 10px; }
  .level-value { font-size: 28px; font-weight: 700; line-height: 1; }
  .level-name {
    font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
    margin-top: 4px; opacity: 0.7;
  }
  input[type="range"] {
    --slider-color: #8b949e;
    --slider-pct: 50%;
    -webkit-appearance: none;
    appearance: none;
    width: 100%; height: 6px;
    border-radius: 3px; outline: none;
    margin: 4px 0; cursor: pointer;
    background: linear-gradient(to right,
      var(--slider-color) 0%, var(--slider-color) var(--slider-pct),
      var(--vscode-input-background) var(--slider-pct),
      var(--vscode-input-background) 100%);
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px; height: 16px; border-radius: 50%;
    background: #fff; border: 2px solid var(--slider-color); cursor: grab;
  }
  input[type="range"]::-webkit-slider-thumb:active { cursor: grabbing; }
  input[type="range"]::-moz-range-thumb {
    width: 16px; height: 16px; border-radius: 50%;
    background: #fff; border: 2px solid var(--slider-color); cursor: grab;
  }
  input[type="range"]:disabled { opacity: 0.4; cursor: not-allowed; }
  .ticks { display: flex; justify-content: space-between; padding: 0 4px; }
  .tick {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    cursor: pointer; padding: 3px 8px; border-radius: 3px; user-select: none;
  }
  .tick:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.15));
  }
  .tick.active { font-weight: 700; color: var(--vscode-foreground); }

  /* Controls */
  label {
    display: block; font-size: 11px;
    color: var(--vscode-descriptionForeground); margin-bottom: 4px;
  }
  select, input[type="text"] {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; padding: 5px 8px;
    font-family: inherit; font-size: 12px;
  }
  select:disabled, input[type="text"]:disabled { opacity: 0.6; cursor: not-allowed; }

  .field { margin-bottom: 12px; }
  .field:last-child { margin-bottom: 0; }

  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 12px; border-radius: 3px;
    cursor: pointer; font-family: inherit; font-size: 12px; width: 100%;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .row { display: flex; align-items: center; gap: 8px; }
  .row.between { justify-content: space-between; }

  .link-btn {
    background: none; border: none; padding: 0; width: auto;
    color: var(--vscode-textLink-foreground);
    cursor: pointer; font-size: 11px;
    text-decoration: none;
  }
  .link-btn:hover { text-decoration: underline; background: none; }

  .status-dot {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; flex-shrink: 0;
  }
  .status-dot.ok { background: #3fb950; }
  .status-dot.bad { background: #f85149; }
  .status-dot.checking { background: #d29922; animation: pulse 1s infinite; }
  .status-dot.idle { background: #8b949e; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

  .status-line {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; color: var(--vscode-descriptionForeground);
    margin-top: 8px;
  }
  .status-line.ok { color: #3fb950; }
  .status-line.bad { color: #f85149; }
  .status-line.checking { color: #d29922; }

  .key-warning {
    background: rgba(255, 180, 0, 0.1);
    border: 1px solid rgba(255, 180, 0, 0.4);
    border-radius: 4px; padding: 8px 10px; margin-bottom: 12px;
    font-size: 12px; display: flex; align-items: center;
    gap: 8px; justify-content: space-between;
  }
  .key-warning button {
    width: auto; padding: 4px 10px; font-size: 11px; flex-shrink: 0;
  }
  .key-warning.small {
    padding: 5px 8px; font-size: 11px; margin: 6px 0 0 0;
  }
  .key-warning.small button {
    padding: 2px 8px; font-size: 10px;
  }

  .key-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 6px 8px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    border-radius: 4px; font-size: 11px;
  }
  .key-row button { width: auto; padding: 3px 8px; font-size: 11px; }

  .check-row {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; cursor: pointer; user-select: none;
  }
  input[type="checkbox"] {
    accent-color: var(--vscode-checkbox-background, #007acc);
    cursor: pointer;
  }

  details {
    margin-top: 12px; padding-top: 12px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
  }
  details summary {
    font-size: 11px; color: var(--vscode-descriptionForeground);
    cursor: pointer; user-select: none; list-style: none;
    display: flex; align-items: center; gap: 4px;
  }
  details summary::-webkit-details-marker { display: none; }
  details summary::before {
    content: '▶'; font-size: 8px;
    transition: transform 0.15s; display: inline-block;
  }
  details[open] summary::before { transform: rotate(90deg); }
  details > *:not(summary) { margin-top: 10px; }

  .task {
    padding: 10px 0;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
  }
  .task:first-child { border-top: none; padding-top: 4px; }
  .task-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
  .task-desc {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
  }
  .task-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .task-grid select { width: 100%; }
  .task-grid label { margin-bottom: 2px; }

  hr.divider {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    margin: 16px 0;
  }

  /* Lock screen */
  .lock-screen {
    text-align: center;
    padding: 14px 10px;
    background: var(--vscode-sideBar-background);
    border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.3));
    border-radius: 4px;
  }
  .lock-icon {
    font-size: 22px;
    margin-bottom: 6px;
    opacity: 0.8;
  }
  .lock-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .lock-sub {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 10px;
  }
  .lock-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lock-actions button { width: 100%; }

  .lock-manage {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .lock-manage button {
    flex: 1;
    width: auto;
    font-size: 11px;
    padding: 4px 8px;
  }
</style>
</head>
<body>

<!-- ACTION BAR -->
<div class="action-bar">
  <button class="fix-btn" id="fixAllBtn">
    <span id="fixBtnLabel">Fix</span>
  </button>
  <div class="logic-warning" id="logicWarning">
    <span class="icon">⚠</span>
    <span class="text" id="logicWarningText">Logic issues detected</span>
  </div>
  <p class="fix-hint" id="fixHint">Fix errors in the active file</p>
</div>

<!-- SKILL LEVEL -->
<div class="section">
  <h2>Skill level</h2>
  <div class="level-display">
    <div class="level-value" id="levelValue">3</div>
    <div class="level-name" id="levelName">intermediate</div>
  </div>
  <input type="range" id="levelSlider" min="1" max="5" step="1" value="3" />
  <div class="ticks">
    <span class="tick" data-level="1">1</span>
    <span class="tick" data-level="2">2</span>
    <span class="tick" data-level="3">3</span>
    <span class="tick" data-level="4">4</span>
    <span class="tick" data-level="5">5</span>
  </div>
  <label class="check-row" style="margin-top: 12px;">
    <input type="checkbox" id="autoLevel" />
    <span>Auto — adapts as you code</span>
  </label>
</div>

<!-- MODEL -->
<div class="section">
  <h2>Model</h2>

  <div id="keyWarning" class="key-warning" style="display:none;">
    <span id="keyWarningText">API key required.</span>
    <button class="secondary" id="keyWarningBtn">Set key</button>
  </div>

  <div class="field">
    <label for="provider">Service</label>
    <select id="provider"></select>
  </div>

  <div class="field">
    <label for="modelSelect">Model</label>
    <select id="modelSelect"></select>
  </div>

  <div class="status-line" id="statusLine">
    <span class="status-dot idle" id="statusDot"></span>
    <span id="statusText">Ready.</span>
  </div>

  <div class="row between" style="margin-top: 6px;">
    <button class="link-btn" id="refreshModels">↻ Refresh models</button>
  </div>

  <button class="secondary" id="testProvider" style="margin-top: 12px;">Test connection</button>

  <details>
    <summary>Advanced</summary>

    <!-- Lock screen (shown when locked) -->
    <div id="lockScreen" class="lock-screen" style="display:none;">
      <div class="lock-icon">🔒</div>
      <div class="lock-title">Advanced settings are locked</div>
      <div class="lock-sub">Enter the password to unlock for this session.</div>
      <div class="lock-actions">
        <button class="secondary" id="unlockAdvancedBtn">Unlock</button>
      </div>
    </div>

    <!-- Advanced content (hidden when locked) -->
    <div id="advancedContent">
      <div class="field">
        <label for="baseUrl">Base URL</label>
        <input type="text" id="baseUrl" />
        <div class="row between" style="margin-top: 6px;">
          <span style="font-size: 10px; color: var(--vscode-descriptionForeground);" id="defaultUrl"></span>
          <button class="secondary" id="resetUrl" style="width:auto; padding: 3px 8px; font-size: 11px;">Reset</button>
        </div>
      </div>

      <div class="field">
        <label class="check-row">
          <input type="checkbox" id="useAI" />
          <span>Use AI for unknown errors</span>
        </label>
      </div>

      <div class="key-row" id="apiKeyRow" style="display: none;">
        <span>API key <span id="apiKeyStatus" style="opacity:0.7;"></span></span>
        <div style="display:flex; gap:6px;">
          <button class="secondary" id="setApiKeyBtn">Set</button>
          <button class="secondary" id="clearApiKeyBtn">Clear</button>
        </div>
      </div>

      <hr class="divider" />

      <label class="check-row">
        <input type="checkbox" id="taskProfilesEnabled" />
        <span>Use different models for different errors</span>
      </label>

      <div id="taskBlock" style="display: none; margin-top: 10px;">
        <p style="font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 4px 0;">
          Route each error type to its own provider and model. Leave provider blank to use the main model above.
        </p>
        <div id="taskRows"></div>
      </div>

      <hr class="divider" />

      <div class="lock-manage" id="lockManageActive" style="display:none;">
        <button class="secondary" id="lockNowBtn">Lock now</button>
        <button class="secondary" id="changePasswordBtn">Change password</button>
        <button class="secondary" id="removePasswordBtn">Remove lock</button>
      </div>

      <div class="lock-manage" id="lockManageInactive" style="display:none;">
        <button class="secondary" id="setPasswordBtn">Set password for Advanced</button>
      </div>
    </div>
  </details>
</div>

<!-- OTHER -->
<hr class="divider" />
<div class="section">
  <button class="secondary" id="openSettings">Open full settings</button>
  <button class="secondary" id="clearCache" style="margin-top: 6px;">Clear cache</button>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const LEVEL_COLORS = ${colorsJson};
  const PROVIDERS = ${providersJson};
  const TASK_TYPES = ${taskTypesJson};
  const TASK_LABELS = ${taskLabelsJson};
  const TASK_DESCRIPTIONS = ${taskDescJson};

  const LEVEL_NAMES = {
    1: 'beginner', 2: 'early learner', 3: 'intermediate',
    4: 'comfortable', 5: 'expert'
  };

  let state = null;
  let autoMode = false;
  let lastPaintedLevel = -1;
  const modelsRequested = new Set();

  const $ = id => document.getElementById(id);
  const send = (type, value, extra) => {
    const msg = { type, value };
    if (extra) Object.assign(msg, extra);
    vscode.postMessage(msg);
  };
  const escAttr = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  const escText = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  function paintColor(level) {
    const c = LEVEL_COLORS[level] || '#8b949e';
    const pct = ((level - 1) / 4) * 100;
    $('levelSlider').style.setProperty('--slider-color', c);
    $('levelSlider').style.setProperty('--slider-pct', pct + '%');
  }
  function paintLabels(level) {
    const c = LEVEL_COLORS[level] || '#8b949e';
    $('levelValue').textContent = String(level);
    $('levelValue').style.color = c;
    $('levelName').textContent = LEVEL_NAMES[level] || '';
    $('levelName').style.color = c;
    document.querySelectorAll('.tick').forEach(t =>
      t.classList.toggle('active', Number(t.dataset.level) === level));
  }

  function providerLabel(id) {
    const p = PROVIDERS.find(x => x.id === id);
    return p ? p.label : id;
  }

  function buildModelOptions(models, current, placeholder) {
    if (!models || models.length === 0) {
      if (current) {
        return '<option value="' + escAttr(current) + '" selected>' +
               escText(current) + ' (not installed)</option>';
      }
      return '<option value="">' + escText(placeholder || '(none available)') + '</option>';
    }
    let found = false;
    let html = '';
    for (const m of models) {
      const sel = m === current ? 'selected' : '';
      if (m === current) found = true;
      html += '<option value="' + escAttr(m) + '" ' + sel + '>' + escText(m) + '</option>';
    }
    if (current && !found) {
      html = '<option value="' + escAttr(current) + '" selected>' +
             escText(current) + ' (not installed)</option>' + html;
    } else if (!current) {
      html = '<option value="">' + escText(placeholder || 'Pick a model') + '</option>' + html;
    }
    return html;
  }

  function buildTaskRows(s) {
    const container = $('taskRows');
    const noKey = new Set(s.providersWithoutKeys || []);
    let html = '';

    for (const task of TASK_TYPES) {
      const profile = s.taskProfiles[task] || { provider: '', model: '' };
      const provider = profile.provider;
      const effectiveProvider = provider || s.provider;
      const needsKey = provider && noKey.has(provider);
      const models = s.providerModels[effectiveProvider] || [];

      let providerOpts = '<option value="">Main</option>';
      for (const p of PROVIDERS) {
        const sel = profile.provider === p.id ? 'selected' : '';
        providerOpts += '<option value="' + escAttr(p.id) + '" ' + sel + '>' +
                        escText(p.label) + '</option>';
      }

      const modelOptions = provider
        ? buildModelOptions(models, profile.model, models.length ? 'Pick a model' : 'No models')
        : '<option value="">Same as main</option>';

      html +=
        '<div class="task">' +
          '<div class="task-title">' + escText(TASK_LABELS[task]) + '</div>' +
          '<div class="task-desc">' + escText(TASK_DESCRIPTIONS[task]) + '</div>' +
          '<div class="task-grid">' +
            '<div><label>Provider</label>' +
              '<select class="task-provider" data-task="' + task + '">' + providerOpts + '</select>' +
            '</div>' +
            '<div><label>Model</label>' +
              '<select class="task-model" data-task="' + task + '"' +
                (provider ? '' : ' disabled') + '>' + modelOptions + '</select>' +
            '</div>' +
          '</div>' +
          (needsKey
            ? '<div class="key-warning small">' +
                '<span>' + escText(providerLabel(provider)) + ' needs a key.</span>' +
                '<button class="secondary task-set-key" data-provider="' + escAttr(provider) + '">Set</button>' +
              '</div>'
            : '') +
        '</div>';
    }
    container.innerHTML = html;

    container.querySelectorAll('.task-provider').forEach(el => {
      el.addEventListener('change', e => {
        const task = e.target.dataset.task;
        const newProvider = e.target.value;
        send('setTaskProfile', null, { task, provider: newProvider });
        if (newProvider && !modelsRequested.has(newProvider)) {
          modelsRequested.add(newProvider);
          send('loadProviderModels', null, { provider: newProvider });
        }
      });
    });

    container.querySelectorAll('.task-model').forEach(el => {
      el.addEventListener('change', e => {
        send('setTaskProfile', null, {
          task: e.target.dataset.task,
          model: e.target.value
        });
      });
    });

    container.querySelectorAll('.task-set-key').forEach(el => {
      el.addEventListener('click', e => {
        send('setApiKey', null, { provider: e.target.dataset.provider });
      });
    });
  }

  function applyState(s) {
    state = s;
    autoMode = s.skillLevel === 'auto';

    // Fix button + logic warning
    const fixBtn = $('fixAllBtn');
    const fixLabel = $('fixBtnLabel');
    const fixHint = $('fixHint');
    const lw = $('logicWarning');
    const hasAnything = s.totalIssues > 0;

    if (s.fixing) {
      fixBtn.disabled = true;
      fixLabel.textContent = 'Fixing…';
      fixHint.textContent = 'Working through the file';
    } else if (!hasAnything) {
      fixBtn.disabled = true;
      fixLabel.textContent = 'Fix';
      fixHint.textContent = 'No issues in the active file';
    } else {
      fixBtn.disabled = false;
      fixLabel.textContent = 'Fix';
      fixHint.textContent = 'Fix issues in the active file';
    }

    if (!s.fixing && s.logicCount > 0) {
      lw.style.display = 'flex';
      $('logicWarningText').textContent =
        s.logicCount + ' logic issue' +
        (s.logicCount === 1 ? '' : 's') +
        ' — click to view';
    } else {
      lw.style.display = 'none';
    }

    // Slider
    $('autoLevel').checked = autoMode;
    $('levelSlider').disabled = autoMode;
    const level = autoMode ? s.effectiveLevel : Number(s.skillLevel);
    $('levelSlider').value = String(level);
    lastPaintedLevel = level;
    paintColor(level);
    paintLabels(level);

    // Provider / model
    const pSelect = $('provider');
    let pHtml = '';
    for (const p of PROVIDERS) {
      const sel = p.id === s.provider ? 'selected' : '';
      pHtml += '<option value="' + escAttr(p.id) + '" ' + sel + '>' + escText(p.label) + '</option>';
    }
    pSelect.innerHTML = pHtml;

    $('modelSelect').innerHTML = buildModelOptions(
      s.availableModels, s.model, s.loadingModels ? 'Loading…' : '(no models)'
    );

    // Key warning
    const warn = $('keyWarning');
    if (s.providerRequiresKey && !s.apiKeySet) {
      warn.style.display = 'flex';
      $('keyWarningText').textContent =
        'API key required for ' + providerLabel(s.provider) + '.';
    } else {
      warn.style.display = 'none';
    }

    // Status
    const dot = $('statusDot');
    dot.className = 'status-dot ' + s.status;
    const line = $('statusLine');
    line.className = 'status-line ' +
      (s.status === 'ok' ? 'ok' :
       s.status === 'bad' ? 'bad' :
       s.status === 'checking' ? 'checking' : '');
    $('statusText').textContent =
      s.loadingModels ? 'Loading models…' : (s.statusMessage || 'Ready.');

    const testBtn = $('testProvider');
    testBtn.disabled = s.testing;
    testBtn.textContent = s.testing ? 'Testing…' : 'Test connection';

    // Advanced lock
    const lockScreen = $('lockScreen');
    const advContent = $('advancedContent');
    if (s.advancedLockEnabled && !s.advancedUnlocked) {
      lockScreen.style.display = 'block';
      advContent.style.display = 'none';
    } else {
      lockScreen.style.display = 'none';
      advContent.style.display = 'block';
    }

    // Advanced content fields (only matter when unlocked, but harmless to set)
    $('baseUrl').value = s.baseUrl;
    $('defaultUrl').textContent = 'Default: ' + s.defaultBaseUrl;
    $('useAI').checked = s.useAI;

    const keyRow = $('apiKeyRow');
    if (s.providerRequiresKey) {
      keyRow.style.display = 'flex';
      $('apiKeyStatus').textContent = s.apiKeySet ? '(set)' : '(not set)';
    } else {
      keyRow.style.display = 'none';
    }

    $('taskProfilesEnabled').checked = s.taskProfilesEnabled;
    $('taskBlock').style.display = s.taskProfilesEnabled ? 'block' : 'none';
    if (s.taskProfilesEnabled) buildTaskRows(s);

    // Lock management buttons
    $('lockManageActive').style.display = s.advancedLockEnabled ? 'flex' : 'none';
    $('lockManageInactive').style.display = s.advancedLockEnabled ? 'none' : 'flex';
  }

  // Action bar
  $('fixAllBtn').addEventListener('click', () => send('fixAll'));
  $('logicWarning').addEventListener('click', () => send('openProblems'));

  // Slider
  $('levelSlider').addEventListener('input', e => {
    const lv = Number(e.target.value);
    paintColor(lv);
    if (lv !== lastPaintedLevel) { lastPaintedLevel = lv; paintLabels(lv); }
  });
  $('levelSlider').addEventListener('change', e => {
    if (autoMode) return;
    send('setSkillLevel', String(e.target.value));
  });
  document.querySelectorAll('.tick').forEach(t => {
    t.addEventListener('click', () => {
      if (autoMode) return;
      const lv = Number(t.dataset.level);
      $('levelSlider').value = String(lv);
      lastPaintedLevel = lv;
      paintColor(lv);
      paintLabels(lv);
      send('setSkillLevel', String(lv));
    });
  });
  $('autoLevel').addEventListener('change', e => {
    if (e.target.checked) send('setSkillLevel', 'auto');
    else send('setSkillLevel', String(state ? state.effectiveLevel : 3));
  });

  // Model
  $('provider').addEventListener('change', e => send('setProvider', e.target.value));
  $('modelSelect').addEventListener('change', e => send('setModel', e.target.value));
  $('baseUrl').addEventListener('change', e =>
    send('setBaseUrl', e.target.value, { provider: state.provider }));
  $('resetUrl').addEventListener('click', () =>
    send('resetBaseUrl', null, { provider: state.provider }));
  $('useAI').addEventListener('change', e => send('setUseAI', e.target.checked));
  $('testProvider').addEventListener('click', () => send('testProvider'));
  $('refreshModels').addEventListener('click', () => {
    modelsRequested.clear();
    send('refreshModels');
  });

  // API keys  
  $('keyWarningBtn').addEventListener('click', () =>
    send('setApiKey', null, { provider: state.provider }));
  $('setApiKeyBtn').addEventListener('click', () =>
    send('setApiKey', null, { provider: state.provider }));
  $('clearApiKeyBtn').addEventListener('click', () =>
    send('clearApiKey', null, { provider: state.provider }));

  // Tasks
  $('taskProfilesEnabled').addEventListener('change', e =>
    send('setTaskProfilesEnabled', e.target.checked));

  // Lock
  $('unlockAdvancedBtn').addEventListener('click', () => send('unlockAdvanced'));
  $('lockNowBtn').addEventListener('click', () => send('lockAdvancedNow'));
  $('setPasswordBtn').addEventListener('click', () => send('setAdvancedPassword'));
  $('changePasswordBtn').addEventListener('click', () => send('setAdvancedPassword'));
  $('removePasswordBtn').addEventListener('click', () => send('removeAdvancedPassword'));

  // Other
  $('openSettings').addEventListener('click', () => send('openSettings'));
  $('clearCache').addEventListener('click', () => send('clearCache'));

  window.addEventListener('message', e => {
    const m = e.data;
    if (m && m.type === 'state') applyState(m.state);
  });

  send('ready');
</script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}