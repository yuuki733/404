import * as vscode from 'vscode';
import { ErrorExplanationHoverProvider } from './hoverProvider';
import { SkillTracker, SkillSetting } from './skillTracker';
import { SidebarProvider } from './sidebarProvider';
import { AutoFixer } from './autoFixer';
import { LogicScanner } from './logicScanner';
import { AdvancedLock } from './advancedLock';
import { PROVIDERS, PROVIDER_IDS, ProviderId } from './providers/types';
import { setApiKey, deleteApiKey, hasApiKey } from './providers/registry';
import { MistakeTracker } from './mistakeTracker';

const SUPPORTED_LANGUAGES: vscode.DocumentSelector = [
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'javascriptreact' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'untitled', language: 'javascript' },
  { scheme: 'untitled', language: 'typescript' }
];

const SUPPORTED_LANG_IDS = new Set([
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact'
]);

export function activate(context: vscode.ExtensionContext): void {
  const skillTracker = new SkillTracker(context);
const mistakeTracker = new MistakeTracker(context);
const hoverProvider = new ErrorExplanationHoverProvider(
  skillTracker,
  mistakeTracker,
  context
);
  const autoFixer = new AutoFixer(context);
  const logicScanner = new LogicScanner(context);
  const advancedLock = new AdvancedLock(context);
  const sidebarProvider = new SidebarProvider(
    context,
    skillTracker,
    advancedLock
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SUPPORTED_LANGUAGES, hoverProvider)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      sidebarProvider
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!SUPPORTED_LANG_IDS.has(doc.languageId)) return;
      try {
        logicScanner.scanRulesOnly(doc);
      } catch {
        // ignore
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!SUPPORTED_LANG_IDS.has(doc.languageId)) return;
      try {
        logicScanner.scanRulesOnly(doc);
      } catch {
        // ignore
      }
    })
  );

  if (vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    if (SUPPORTED_LANG_IDS.has(doc.languageId)) {
      try {
        logicScanner.scanRulesOnly(doc);
      } catch {
        // ignore
      }
    }
  }

  context.subscriptions.push(
    // ============ FIX ALL ============
    vscode.commands.registerCommand('404Extension.fixAll', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage(
          '404 Extension: Open a file before running Fix.'
        );
        return;
      }

      const diagCount = vscode.languages
        .getDiagnostics(editor.document.uri)
        .filter(
          d =>
            d.severity === vscode.DiagnosticSeverity.Error ||
            d.severity === vscode.DiagnosticSeverity.Warning
        ).length;

      if (diagCount === 0) {
        void vscode.window.showInformationMessage(
          '404 Extension: Nothing to fix in this file.'
        );
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `404 Extension will fix ${diagCount} issue${
          diagCount === 1 ? '' : 's'
        } in this file. ` +
          'Some AI fixes may be imperfect — you can undo with Ctrl+Z.',
        { modal: true },
        'Fix all'
      );
      if (confirm !== 'Fix all') return;

      sidebarProvider.setFixing(true);

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: '404 Extension',
            cancellable: true
          },
          async (progress, token) => {
            progress.report({ message: 'Scanning for logic issues…' });
            await logicScanner.scan(editor.document, token);

            progress.report({ message: 'Fixing…' });
            const result = await autoFixer.fixActiveFile(
              p => {
                progress.report({
                  message: `${p.message} (${p.current}/${p.total})`,
                  increment: (1 / Math.max(p.total, 1)) * 100
                });
              },
              token
            );

            if (result.total === 0) {
              void vscode.window.showInformationMessage(
                '404 Extension: Nothing to fix.'
              );
              return;
            }

            const fixed = result.fixedByLanguageServer + result.fixedByAI;
            const summary = `Fixed ${fixed} of ${result.total} issue${
              result.total === 1 ? '' : 's'
            }.`;

            if (result.skipped > 0) {
              void vscode.window.showWarningMessage(
                `${summary} ${result.skipped} skipped. ` +
                  'Review the changes and undo with Ctrl+Z if needed.'
              );
            } else {
              void vscode.window.showInformationMessage(
                `${summary} Review the changes.`
              );
            }
          }
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `404 Extension fix failed: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`
        );
      } finally {
        sidebarProvider.setFixing(false);
      }
    }),

    // ============ ADVANCED LOCK ============
    vscode.commands.registerCommand(
      '404Extension.setAdvancedPassword',
      async () => {
        const existing = await advancedLock.isEnabled();

        if (existing) {
          const current = await vscode.window.showInputBox({
            prompt: 'Enter your current advanced password',
            password: true,
            ignoreFocusOut: true
          });
          if (current === undefined) return;
          const ok = await advancedLock.verify(current);
          if (!ok) {
            void vscode.window.showErrorMessage(
              '404 Extension: Incorrect password.'
            );
            return;
          }
        }

        const p1 = await vscode.window.showInputBox({
          prompt: 'Choose a new password (min 4 characters)',
          password: true,
          ignoreFocusOut: true,
          validateInput: v =>
            v && v.length >= 4 ? undefined : 'At least 4 characters.'
        });
        if (!p1) return;

        const p2 = await vscode.window.showInputBox({
          prompt: 'Confirm the new password',
          password: true,
          ignoreFocusOut: true,
          validateInput: v => (v === p1 ? undefined : 'Passwords do not match.')
        });
        if (!p2) return;

        try {
          await advancedLock.setPassword(p2);
          sidebarProvider.refresh();
          void vscode.window.showInformationMessage(
            '404 Extension: Advanced settings password set.'
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `404 Extension: ${
              err instanceof Error ? err.message : 'Could not set password.'
            }`
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      '404Extension.removeAdvancedPassword',
      async () => {
        if (!(await advancedLock.isEnabled())) {
          void vscode.window.showInformationMessage(
            '404 Extension: No advanced password is set.'
          );
          return;
        }

        const current = await vscode.window.showInputBox({
          prompt: 'Enter your current password to remove it',
          password: true,
          ignoreFocusOut: true
        });
        if (current === undefined) return;

        const ok = await advancedLock.verify(current);
        if (!ok) {
          void vscode.window.showErrorMessage(
            '404 Extension: Incorrect password.'
          );
          return;
        }

        await advancedLock.clear();
        sidebarProvider.refresh();
        void vscode.window.showInformationMessage(
          '404 Extension: Advanced password removed.'
        );
      }
    ),

    // ============ SCAN / API KEYS / OTHER ============
    vscode.commands.registerCommand('404Extension.scanLogic', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage(
          '404 Extension: Open a file before scanning.'
        );
        return;
      }

      const findings = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '404 Extension: Scanning for logic issues…',
          cancellable: true
        },
        (_progress, token) => logicScanner.scan(editor.document, token)
      );

      if (findings.length === 0) {
        void vscode.window.showInformationMessage(
          '404 Extension: No logic issues found in this file.'
        );
        return;
      }

      void vscode.window.showInformationMessage(
        `404 Extension: Found ${findings.length} logic issue${
          findings.length === 1 ? '' : 's'
        }. Check the Problems panel.`
      );

      await vscode.commands.executeCommand('workbench.actions.view.problems');
    }),

    vscode.commands.registerCommand('404Extension.clearLogicFindings', () => {
      logicScanner.clear();
      void vscode.window.showInformationMessage(
        '404 Extension: Cleared logic findings.'
      );
    }),

    vscode.commands.registerCommand('404Extension.setApiKey', async () => {
      const items = PROVIDER_IDS.filter(id => PROVIDERS[id].requiresKey).map(
        id => ({
          label: PROVIDERS[id].label,
          description: PROVIDERS[id].description,
          id
        })
      );

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Which provider is this API key for?'
      });
      if (!picked) return;

      const key = await vscode.window.showInputBox({
        prompt: `Paste your ${picked.label} API key`,
        password: true,
        ignoreFocusOut: true,
        validateInput: v =>
          v && v.trim().length > 8 ? undefined : 'Key looks too short.'
      });
      if (!key) return;

      await setApiKey(context, picked.id as ProviderId, key);
      sidebarProvider.refresh();
      void vscode.window.showInformationMessage(`${picked.label} API key saved.`);
    }),

    vscode.commands.registerCommand('404Extension.clearApiKey', async () => {
      const items: Array<vscode.QuickPickItem & { id: ProviderId }> = [];
      for (const id of PROVIDER_IDS) {
        if (!PROVIDERS[id].requiresKey) continue;
        const has = await hasApiKey(context, id);
        items.push({
          label: `${has ? '$(key) ' : '$(circle-slash) '}${PROVIDERS[id].label}`,
          id
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Clear which API key?'
      });
      if (!picked) return;
      await deleteApiKey(context, picked.id);
      sidebarProvider.refresh();
      void vscode.window.showInformationMessage(
        `${PROVIDERS[picked.id].label} API key removed.`
      );
    }),

    vscode.commands.registerCommand('404Extension.resetSkill', async () => {
  await skillTracker.reset();
  await mistakeTracker.reset();
  sidebarProvider.refresh();
  void vscode.window.showInformationMessage('404 Extension progress reset.');
}),

    vscode.commands.registerCommand(
      '404Extension.explainCurrentError',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const position = editor.selection.active;
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        const diagnostic = diagnostics.find(
          d =>
            d.severity !== vscode.DiagnosticSeverity.Information &&
            d.severity !== vscode.DiagnosticSeverity.Hint &&
            (d.range.contains(position) ||
              (d.range.isEmpty && d.range.start.line === position.line))
        );
        if (!diagnostic) {
          void vscode.window.showInformationMessage(
            '404 Extension: No error at cursor.'
          );
          return;
        }
        await vscode.commands.executeCommand('editor.action.showHover');
      }
    ),

    vscode.commands.registerCommand('404Extension.clearCache', async () => {
      await context.globalState.update('404Extension.cache', {});
      sidebarProvider.refresh();
      void vscode.window.showInformationMessage('404 Extension cache cleared.');
    }),

    vscode.commands.registerCommand('404Extension.openSidebar', async () => {
      await vscode.commands.executeCommand('404extension-sidebar.focus');
    }),

    vscode.commands.registerCommand('404Extension.setSkillLevel', async () => {
      const current = vscode.workspace
        .getConfiguration('404Extension')
        .get<SkillSetting>('skillLevel', 'auto');

      const items: (vscode.QuickPickItem & { value: SkillSetting })[] = [
        { label: 'Auto', description: 'Adjust automatically', value: 'auto' },
        { label: 'Level 1', description: 'Never coded before', value: '1' },
        { label: 'Level 2', description: 'Early learner', value: '2' },
        { label: 'Level 3', description: 'Intermediate', value: '3' },
        { label: 'Level 4', description: 'Comfortable', value: '4' },
        { label: 'Level 5', description: 'Expert', value: '5' }
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Current: ${current}. Pick a skill level.`
      });
      if (!picked) return;

      await skillTracker.setManualLevel(picked.value);
      sidebarProvider.refresh();
    })
  );
}

export function deactivate(): void {}