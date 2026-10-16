import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';
import { extractContext } from './contextExtractor';
import { SkillTracker, SkillLevel, levelName } from './skillTracker';
import { lookup as ruleLookup } from './ruleBase';
import { ExplanationCache, signatureFor } from './cache';
import { Explanation } from './types';
import { classifyTask, TASK_LABELS } from './taskRouter';
import { resolveTarget } from './providers/registry';
import { MistakeTracker, TeachingDepth } from './mistakeTracker';

type Source = 'cache' | 'rule' | 'ai' | 'generic';

export class ErrorExplanationHoverProvider implements vscode.HoverProvider {
  private readonly client: OllamaClient;
  private readonly cache: ExplanationCache;

  constructor(
    private readonly skillTracker: SkillTracker,
    private readonly mistakeTracker: MistakeTracker,
    private readonly context: vscode.ExtensionContext
  ) {
    this.cache = new ExplanationCache(context);
    this.client = new OllamaClient(context);
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const diagnostics = vscode.languages
      .getDiagnostics(document.uri)
      .filter(
        d =>
          d.severity !== vscode.DiagnosticSeverity.Information &&
          d.severity !== vscode.DiagnosticSeverity.Hint &&
          (d.range.contains(position) ||
            (d.range.isEmpty && d.range.start.line === position.line))
      );

    if (diagnostics.length === 0) return undefined;

    const diagnostic = diagnostics.sort((a, b) => {
      const lenA =
        (a.range.end.line - a.range.start.line) * 10000 +
        a.range.end.character - a.range.start.character;
      const lenB =
        (b.range.end.line - b.range.start.line) * 10000 +
        b.range.end.character - b.range.start.character;
      return lenA - lenB;
    })[0];

    const level: SkillLevel = this.skillTracker.getLevel();
    const contextText = await extractContext(document, diagnostic.range, token);

    if (token.isCancellationRequested) return undefined;

    // How many times has the user seen THIS kind of mistake?
    const timesSeen = this.mistakeTracker.countBefore(diagnostic.message);
    const depth: TeachingDepth = this.mistakeTracker.depthFor(timesSeen);

    const taskType = classifyTask(diagnostic.message, contextText);
    const target = await resolveTarget(this.context, taskType);

    // Cache key includes depth so a deeper explanation isn't served
    // when the user has levelled up.
    const signature = signatureFor(
      diagnostic.message,
      contextText,
      document.languageId,
      `${level}|${taskType}|${target.providerId}|${target.model}|d${depth}`
    );

    let explanation: Explanation | undefined;
    let source: Source = 'generic';

    explanation = this.cache.get(signature);
    if (explanation) source = 'cache';

    // Rules pass the depth so they can produce adaptive text.
    if (!explanation) {
      explanation = ruleLookup(diagnostic.message, contextText, depth);
      if (explanation) source = 'rule';
    }

    if (!explanation) {
      const useAI = vscode.workspace
        .getConfiguration('404Extension')
        .get<boolean>('useAI', true);

      if (useAI) {
        try {
          explanation = await this.client.explain(
            diagnostic.message,
            contextText,
            level,
            taskType,
            timesSeen,
            token
          );
          if (explanation) source = 'ai';
        } catch {
          // fall through
        }
      }

      if (!explanation) {
        explanation = genericExplanation(diagnostic);
      }

      if (!token.isCancellationRequested) {
        await this.cache.set(signature, explanation);
      }
    }

    if (token.isCancellationRequested) return undefined;

    // Record the mistake so the next occurrence goes deeper.
    await this.mistakeTracker.record(diagnostic.message);

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.supportThemeIcons = true;

    md.appendMarkdown(`## $(sparkle) 404 Extension\n\n`);
    md.appendMarkdown(`---\n\n`);

    md.appendMarkdown(`### $(warning) What's wrong?\n\n`);
    md.appendMarkdown(`${formatHoverText(explanation.what)}\n\n`);

    md.appendMarkdown(`### $(info) Why did this happen?\n\n`);
    md.appendMarkdown(`${formatHoverText(explanation.why)}\n\n`);

    md.appendMarkdown(`### $(tools) How to fix it\n\n`);
    md.appendMarkdown(`${formatHoverText(explanation.fix)}\n\n`);

    if (explanation.concept) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`### $(lightbulb) Remember this\n\n`);
      md.appendMarkdown(`> ${formatHoverText(explanation.concept)}\n\n`);
    }

    md.appendMarkdown(`---\n\n`);

    // Show the repetition count when the user has seen this before.
    const repeatLabel =
      timesSeen > 0
        ? ` · seen ${timesSeen + 1}× · depth ${depth}/4`
        : ` · first time`;

    md.appendMarkdown(
      `$(book) *404 Extension* · *${sourceLabel(source)}* · *Level ${level}/5 (${levelName(level)})*${repeatLabel}`
    );

    if (source === 'ai' || source === 'cache') {
      md.appendMarkdown(` · *${TASK_LABELS[taskType]}*`);
    }

    if (source !== 'cache') {
      await this.skillTracker.record();
    }

    return new vscode.Hover(md, diagnostic.range);
  }
}

function sourceLabel(source: Source): string {
  switch (source) {
    case 'cache': return 'cached';
    case 'rule': return 'instant';
    case 'ai': return 'AI';
    default: return 'general';
  }
}

function formatHoverText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      out.push(line.trim());
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      out.push('');
      continue;
    }
    const listMatch = line.match(/^(\s*(?:\d+[.)]|[-*])\s+)(.*)$/);
    if (listMatch) {
      out.push(listMatch[1] + formatHoverInline(listMatch[2]));
    } else {
      out.push(formatHoverInline(line));
    }
  }
  return out.join('\n');
}

function formatHoverInline(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((part, index) => {
      if (index % 2 === 1 && part.startsWith('`') && part.endsWith('`')) return part;
      return escapeHoverMarkdown(part);
    })
    .join('');
}

function escapeHoverMarkdown(text: string): string {
  return text.replace(/([*_`\[\]<>])/g, '\\$1');
}

function genericExplanation(diagnostic: vscode.Diagnostic): Explanation {
  const msg = diagnostic.message;
  const line = diagnostic.range.start.line + 1;
  const shortWhat = msg.length > 120 ? msg.slice(0, 120) + '…' : msg;

  if (/import|module/i.test(msg)) {
    return {
      what: `An import or module problem.`,
      why: `The code can't find something it's trying to use.`,
      fix: `Check the file path and the package name. If it's a package, run \`npm install\` in the terminal.`,
      concept: 'Resolving imports'
    };
  }
  if (/type/i.test(msg)) {
    return {
      what: `A type mismatch.`,
      why: `A value's type doesn't match what this part of the code expects.`,
      fix: `Look at line ${line}. Compare the value's type with what's expected.`,
      concept: 'Type compatibility'
    };
  }
  return {
    what: shortWhat,
    why: `The editor flagged this on line ${line}.`,
    fix: `Hover the squiggle to read the full message. It usually names the exact symbol or type that's wrong.`,
    concept: 'Reading error messages carefully'
  };
}