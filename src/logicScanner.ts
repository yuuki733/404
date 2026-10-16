import * as vscode from 'vscode';
import { resolveTarget, getProvider } from './providers/registry';

export interface LogicIssue {
  ruleId: string;
  line: number;
  startCol: number;
  endCol: number;
  message: string;
  suggestion?: string;
}

interface LogicRule {
  id: string;
  languages: string[];
  check: (lines: string[]) => LogicIssue[];
}

const JS_LANGS = [
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact'
];

const LOGIC_RULES: LogicRule[] = [
  {
    id: 'assignment-in-condition',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      const re = /\b(if|while)\s*\(([^)]*)\)/g;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
          .replace(/\/\/.*$/, '')
          .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
          const inner = m[2];
          const assignMatch = inner.match(/(^|[^=!<>])=(?!=)/);
          if (assignMatch) {
            const start = m.index;
            issues.push({
              ruleId: 'assignment-in-condition',
              line: i,
              startCol: start,
              endCol: start + m[0].length,
              message:
                'Assignment inside a condition. This assigns rather than compares.',
              suggestion:
                'Did you mean `===` or `==`? In JavaScript, `=` assigns.'
            });
          }
        }
      }
      return issues;
    }
  },

  {
    id: 'nan-compare',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/[=!]==?\s*NaN\b/.test(line) || /\bNaN\s*[=!]==?/.test(line)) {
          const idx = line.indexOf('NaN');
          issues.push({
            ruleId: 'nan-compare',
            line: i,
            startCol: Math.max(0, idx - 4),
            endCol: Math.min(line.length, idx + 4),
            message: 'Comparing with NaN using === always returns false.',
            suggestion: 'Use `Number.isNaN(x)` instead.'
          });
        }
      }
      return issues;
    }
  },

  {
    id: 'off-by-one',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      const re = /for\s*\([^;]+;\s*(\w+)\s*<=\s*([\w.]+)\.length/;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
          const start = lines[i].indexOf('for');
          issues.push({
            ruleId: 'off-by-one',
            line: i,
            startCol: start,
            endCol: start + m[0].length,
            message: `Loop uses \`${m[1]} <= ${m[2]}.length\` — one iteration too many.`,
            suggestion: `Use \`${m[1]} < ${m[2]}.length\`.`
          });
        }
      }
      return issues;
    }
  },

  {
    id: 'parseint-no-radix',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const re = /parseInt\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const start = m.index + m[0].length;
          let depth = 1;
          let j = start;
          let hasComma = false;
          while (j < line.length && depth > 0) {
            if (line[j] === '(') depth++;
            else if (line[j] === ')') depth--;
            else if (line[j] === ',' && depth === 1) {
              hasComma = true;
              break;
            }
            j++;
          }
          if (!hasComma) {
            issues.push({
              ruleId: 'parseint-no-radix',
              line: i,
              startCol: m.index,
              endCol: start,
              message: '`parseInt` without a radix can misparse strings like "08".',
              suggestion: 'Pass a base: `parseInt(x, 10)`.'
            });
          }
        }
      }
      return issues;
    }
  },

  {
    id: 'map-without-return',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/\.(map|filter|flatMap|reduce)\s*\(\s*\w+\s*=>\s*\{/);
        if (!m) continue;
        const lookahead = lines
          .slice(i, Math.min(i + 20, lines.length))
          .join('\n');
        const bodyStart = lookahead.indexOf('{');
        let depth = 0;
        let bodyEnd = -1;
        for (let k = bodyStart; k < lookahead.length; k++) {
          if (lookahead[k] === '{') depth++;
          else if (lookahead[k] === '}') {
            depth--;
            if (depth === 0) {
              bodyEnd = k;
              break;
            }
          }
        }
        const body =
          bodyEnd > 0
            ? lookahead.slice(bodyStart + 1, bodyEnd)
            : lookahead.slice(bodyStart + 1);
        if (!/\breturn\b/.test(body)) {
          issues.push({
            ruleId: 'map-without-return',
            line: i,
            startCol: m.index ?? 0,
            endCol: line.length,
            message: `.${m[1]}() callback has a body but no \`return\`.`,
            suggestion:
              'Add `return`, or remove the braces for an implicit return.'
          });
        }
      }
      return issues;
    }
  },

  {
    id: 'foreach-async',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const idx = line.indexOf('.forEach');
        if (idx < 0) continue;
        if (!/\.forEach\s*\(\s*async\b/.test(line)) continue;
        issues.push({
          ruleId: 'foreach-async',
          line: i,
          startCol: idx,
          endCol: line.length,
          message: '`forEach` with an async callback does not wait for promises.',
          suggestion:
            'Use `for...of` with `await`, or `await Promise.all(arr.map(async ...))`.'
        });
      }
      return issues;
    }
  },

  {
    id: 'empty-catch',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const idx = line.indexOf('catch');
        if (idx < 0) continue;
        if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line)) {
          issues.push({
            ruleId: 'empty-catch',
            line: i,
            startCol: idx,
            endCol: line.length,
            message: 'Empty catch block silently swallows errors.',
            suggestion:
              'Log the error, re-throw it, or add a comment explaining why it is safe to ignore.'
          });
        }
      }
      return issues;
    }
  },

  {
    id: 'sort-no-compare',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const idx = line.indexOf('.sort');
        if (idx < 0) continue;
        if (/\.sort\s*\(\s*\)/.test(line)) {
          issues.push({
            ruleId: 'sort-no-compare',
            line: i,
            startCol: idx,
            endCol: line.length,
            message: '`sort()` without a comparator sorts elements as strings.',
            suggestion: 'For numbers, pass `(a, b) => a - b`.'
          });
        }
      }
      return issues;
    }
  },

  {
    id: 'return-in-foreach',
    languages: JS_LANGS,
    check: (lines) => {
      const issues: LogicIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!/\.forEach\s*\(/.test(lines[i])) continue;
        const lookahead = lines.slice(i, Math.min(i + 12, lines.length));
        for (let k = 1; k < lookahead.length; k++) {
          if (/^\s*return\b/.test(lookahead[k])) {
            issues.push({
              ruleId: 'return-in-foreach',
              line: i + k,
              startCol: 0,
              endCol: lookahead[k].length,
              message: '`return` inside `forEach` does not stop the loop.',
              suggestion:
                'Use `.some()`, `.find()`, `.every()`, or a `for` loop if you need to break early.'
            });
            break;
          }
        }
      }
      return issues;
    }
  }
];

export class LogicScanner {
  private collection: vscode.DiagnosticCollection;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.collection = vscode.languages.createDiagnosticCollection('404-logic');
    context.subscriptions.push(this.collection);

    // Clear stale findings when a file changes so we don't show outdated issues.
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.collection.delete(e.document.uri);
      })
    );
  }

  clear(uri?: vscode.Uri): void {
    if (uri) this.collection.delete(uri);
    else this.collection.clear();
  }

  /**
   * Fast pass — deterministic rules only. No network calls. Safe to run
   * on file open and on save.
   */
  scanRulesOnly(document: vscode.TextDocument): vscode.Diagnostic[] {
    const lines = document.getText().split('\n');
    const lang = document.languageId;

    const issues: LogicIssue[] = [];
    for (const rule of LOGIC_RULES) {
      if (!rule.languages.includes(lang)) continue;
      try {
        issues.push(...rule.check(lines));
      } catch {
        // Skip broken rule.
      }
    }

    const diagnostics = this.toDiagnostics(document, dedupe(issues));
    this.collection.set(document.uri, diagnostics);
    return diagnostics;
  }

  /**
   * Full pass — deterministic rules plus an AI code review.
   * Used by the Fix flow, not by background scanning.
   */
  async scan(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): Promise<vscode.Diagnostic[]> {
    const lines = document.getText().split('\n');
    const lang = document.languageId;

    const issues: LogicIssue[] = [];
    for (const rule of LOGIC_RULES) {
      if (!rule.languages.includes(lang)) continue;
      try {
        issues.push(...rule.check(lines));
      } catch {
        // Skip broken rule.
      }
    }

    if (!token?.isCancellationRequested) {
      try {
        const aiIssues = await this.aiReview(document, token);
        issues.push(...aiIssues);
      } catch {
        // AI unavailable; proceed with what we have.
      }
    }

    const diagnostics = this.toDiagnostics(document, dedupe(issues));
    this.collection.set(document.uri, diagnostics);
    return diagnostics;
  }

  private toDiagnostics(
    document: vscode.TextDocument,
    issues: LogicIssue[]
  ): vscode.Diagnostic[] {
    const out: vscode.Diagnostic[] = [];
    for (const issue of issues) {
      const line = Math.max(0, Math.min(issue.line, document.lineCount - 1));
      const lineText = document.lineAt(line).text;
      const startCol = Math.max(0, Math.min(issue.startCol, lineText.length));
      const endCol = Math.max(
        startCol + 1,
        Math.min(issue.endCol || lineText.length, lineText.length)
      );
      const range = new vscode.Range(line, startCol, line, endCol);
      const diag = new vscode.Diagnostic(
        range,
        issue.message,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = '404 (logic)';
      diag.code = issue.ruleId;
      if (issue.suggestion) {
        diag.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(document.uri, range),
            `Suggestion: ${issue.suggestion}`
          )
        ];
      }
      out.push(diag);
    }
    return out;
  }

  private async aiReview(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): Promise<LogicIssue[]> {
    const text = document.getText();
    if (text.length < 20 || text.length > 20000) return [];

    const target = await resolveTarget(this.context, 'reasoning');
    if (target.providerId !== 'ollama-local' && !target.apiKey) return [];

    const prompt = `You are a code reviewer. Read the following ${document.languageId} code and find LOGICAL bugs — cases where the code compiles and runs but produces the wrong result.

Focus on:
- Wrong operator (= vs ===, + vs -, < vs <=)
- Off-by-one errors
- Conditions that can never be true or always true
- Missing null/undefined checks that would crash at runtime
- Loops that don't do what they claim
- Branches that return the wrong value
- Async code that doesn't wait
- State mutated when it shouldn't be
- Wrong variable used (i when j was meant)

IGNORE: style, formatting, naming, missing types, missing comments.

CODE (line numbers start at 1):
${text
  .split('\n')
  .slice(0, 400)
  .map((l, i) => `${i + 1}: ${l}`)
  .join('\n')}

Return ONLY valid JSON:
{
  "issues": [
    {
      "line": 12,
      "message": "Short description of the bug",
      "suggestion": "How to fix it"
    }
  ]
}

If you find no logical bugs, return { "issues": [] }.
Do not wrap in JSON code fences.`;

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
      return [];
    }

    const cleaned = raw
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed: { issues?: unknown };
    try {
      parsed = JSON.parse(cleaned) as { issues?: unknown };
    } catch {
      return [];
    }

    if (!Array.isArray(parsed.issues)) return [];

    const out: LogicIssue[] = [];
    for (const item of parsed.issues) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.line !== 'number' || typeof obj.message !== 'string') {
        continue;
      }
      const line0 = Math.floor(obj.line) - 1;
      if (line0 < 0 || line0 >= document.lineCount) continue;
      out.push({
        ruleId: 'ai-review',
        line: line0,
        startCol: 0,
        endCol: document.lineAt(line0).text.length,
        message: obj.message.slice(0, 200),
        suggestion:
          typeof obj.suggestion === 'string'
            ? obj.suggestion.slice(0, 300)
            : undefined
      });
    }
    return out;
  }
}

function dedupe(issues: LogicIssue[]): LogicIssue[] {
  const seen = new Set<string>();
  const out: LogicIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.line}|${issue.ruleId}|${issue.message.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}