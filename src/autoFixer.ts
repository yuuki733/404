import * as vscode from 'vscode';
import { classifyTask } from './taskRouter';
import { resolveTarget, getProvider } from './providers/registry';

export interface FixProgress {
  current: number;
  total: number;
  message: string;
}

export interface FixOutcome {
  total: number;
  fixedByLanguageServer: number;
  fixedByAI: number;
  skipped: number;
  details: string[];
}

export class AutoFixer {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Fix all errors/warnings in the active file.
   * Phase 1: built-in quick fixes from the language server (safe, fast).
   * Phase 2: AI fixes for anything still broken.
   */
  async fixActiveFile(
    onProgress: (p: FixProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<FixOutcome> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('No active editor.');

    const document = editor.document;

    const initialDiagnostics = this.getErrorDiagnostics(document.uri);
    const total = initialDiagnostics.length;

    if (total === 0) {
      return {
        total: 0,
        fixedByLanguageServer: 0,
        fixedByAI: 0,
        skipped: 0,
        details: ['No errors or warnings found in this file.']
      };
    }

    onProgress({ current: 0, total, message: 'Applying built-in quick fixes…' });

    const fixedByLanguageServer = await this.applyBuiltinFixes(
      editor,
      initialDiagnostics,
      onProgress,
      token
    );

    if (token?.isCancellationRequested) {
      return this.buildOutcome(total, fixedByLanguageServer, 0, document.uri);
    }

    const remaining = this.getErrorDiagnostics(document.uri);

    let fixedByAI = 0;
    if (remaining.length > 0) {
      onProgress({
        current: 0,
        total: remaining.length,
        message: 'Asking AI to repair remaining errors…'
      });
      fixedByAI = await this.applyAiFixes(editor, remaining, onProgress, token);
    }

    return this.buildOutcome(total, fixedByLanguageServer, fixedByAI, document.uri);
  }

  private getErrorDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
    return vscode.languages
      .getDiagnostics(uri)
      .filter(
        d =>
          d.severity === vscode.DiagnosticSeverity.Error ||
          d.severity === vscode.DiagnosticSeverity.Warning
      );
  }

  private buildOutcome(
    total: number,
    lspFixed: number,
    aiFixed: number,
    uri: vscode.Uri
  ): FixOutcome {
    const remaining = this.getErrorDiagnostics(uri).length;
    const fixed = lspFixed + aiFixed;
    const details: string[] = [];

    if (lspFixed > 0) details.push(`${lspFixed} fixed by the language server.`);
    if (aiFixed > 0) details.push(`${aiFixed} fixed by AI.`);
    if (remaining > 0) details.push(`${remaining} could not be fixed automatically.`);

    return {
      total,
      fixedByLanguageServer: lspFixed,
      fixedByAI: aiFixed,
      skipped: remaining,
      details
    };
  }

  /**
   * Apply quick fixes provided by installed language servers.
   * Process from the last error to the first so line numbers stay valid.
   */
  private async applyBuiltinFixes(
    editor: vscode.TextEditor,
    diagnostics: vscode.Diagnostic[],
    onProgress: (p: FixProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<number> {
    const sorted = [...diagnostics].sort(
      (a, b) => b.range.start.line - a.range.start.line
    );

    let fixed = 0;
    let index = 0;

    for (const diag of sorted) {
      if (token?.isCancellationRequested) break;
      index++;

      onProgress({
        current: index,
        total: sorted.length,
        message: 'Applying built-in quick fixes…'
      });

      try {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          editor.document.uri,
          diag.range,
          vscode.CodeActionKind.QuickFix.value
        );

        if (!actions || actions.length === 0) continue;

        // Prefer a "Fix all" action if one exists, otherwise the first.
        const fixAll = actions.find(a => /fix all/i.test(a.title));
        const chosen = fixAll ?? actions[0];

        if (chosen.edit) {
          const applied = await vscode.workspace.applyEdit(chosen.edit);
          if (applied) {
            fixed++;
            // Let VS Code settle the document state before continuing.
            await delay(25);
          }
        } else if (chosen.command) {
          // Some actions only provide a command — invoke it.
          try {
            await vscode.commands.executeCommand(
              chosen.command.command,
              ...(chosen.command.arguments ?? [])
            );
            fixed++;
            await delay(50);
          } catch {
            // ignore command failures
          }
        }
      } catch {
        // Skip this diagnostic; try the next one.
      }
    }

    return fixed;
  }

  /**
   * For diagnostics the language server can't fix, ask the AI to return a
   * corrected code window. Only the window around the error is replaced.
   */
  private async applyAiFixes(
    editor: vscode.TextEditor,
    diagnostics: vscode.Diagnostic[],
    onProgress: (p: FixProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<number> {
    const sorted = [...diagnostics].sort(
      (a, b) => b.range.start.line - a.range.start.line
    );

    let fixed = 0;
    let index = 0;

    for (const diag of sorted) {
      if (token?.isCancellationRequested) break;
      index++;

      onProgress({
        current: index,
        total: sorted.length,
        message: `AI fixing error ${index} of ${sorted.length}…`
      });

      const document = editor.document;
      const lines = document.getText().split('\n');

      const padding = 8;
      const startLine = Math.max(0, diag.range.start.line - padding);
      const endLine = Math.min(lines.length - 1, diag.range.end.line + padding);

      const windowText = lines.slice(startLine, endLine + 1).join('\n');
      const errorLineOffset = diag.range.start.line - startLine + 1;

      const replacement = await this.askAI(
        diag.message,
        windowText,
        errorLineOffset,
        token
      );

      if (!replacement) continue;

      // Sanity check: replacement should be roughly the same size.
      // Reject anything that looks like a full rewrite.
      if (
        replacement.length > windowText.length * 2 ||
        replacement.length < windowText.length * 0.3
      ) {
        continue;
      }

      const fullRange = new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, lines[endLine].length)
      );

      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullRange, replacement);

      try {
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
          fixed++;
          await delay(40);
        }
      } catch {
        // Skip.
      }
    }

    return fixed;
  }

  private async askAI(
    errorMessage: string,
    codeWindow: string,
    errorLine: number,
    token?: vscode.CancellationToken
  ): Promise<string | undefined> {
    const taskType = classifyTask(errorMessage, codeWindow);
    const target = await resolveTarget(this.context, taskType);

    if (target.providerId !== 'ollama-local' && !target.apiKey) {
      return undefined;
    }

    const prompt = `You repair code errors. Fix ONLY the error described below.

The code below is a window of consecutive lines. Line ${errorLine} is where the error was flagged.

ERROR:
${errorMessage.slice(0, 600)}

CODE WINDOW:
${codeWindow.slice(0, 4000)}

Return ONLY valid JSON with this exact shape:
{
  "replacement": "the same code window, error fixed"
}

STRICT RULES:
- Keep the same number of lines when possible. Do not add or delete unrelated lines.
- Preserve indentation exactly.
- Do not reformat or reorder anything.
- Do not add comments.
- Do not rename variables unless the error requires it.
- If you cannot fix the error confidently, return { "replacement": "" }.
- Do not wrap the JSON in code fences.`;

    let raw: string;
    try {
      const provider = getProvider(target.providerId);
      raw = await provider.generate({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        prompt,
        expectJson: true,
        token
      });
    } catch {
      return undefined;
    }

    const cleaned = stripFences(raw);
    try {
      const parsed = JSON.parse(cleaned) as { replacement?: unknown };
      if (typeof parsed.replacement !== 'string') return undefined;
      const trimmed = parsed.replacement.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}