import * as vscode from 'vscode';
import { Explanation } from './types';
import { SkillLevel } from './skillTracker';
import { TaskType, TASK_ROLE_PROMPTS } from './taskRouter';
import { resolveTarget, getProvider } from './providers/registry';

export { Explanation } from './types';

export class OllamaClient {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async explain(
    errorMessage: string,
    codeContext: string,
    skillLevel: SkillLevel,
    taskType: TaskType,
    timesSeen: number,
    token?: vscode.CancellationToken
  ): Promise<Explanation> {
    const target = await resolveTarget(this.context, taskType);
    const provider = getProvider(target.providerId);

    const prompt = this.buildPrompt(
      errorMessage,
      codeContext,
      skillLevel,
      taskType,
      timesSeen
    );

    let raw: string;
    try {
      raw = await provider.generate({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        prompt,
        expectJson: true,
        token
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`Provider "${target.providerId}" failed: ${msg}`);
    }

    const cleaned = stripCodeFences(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('The AI did not return valid JSON.');
    }

    if (
      !isRecord(parsed) ||
      typeof parsed.what !== 'string' ||
      typeof parsed.why !== 'string' ||
      typeof parsed.fix !== 'string'
    ) {
      throw new Error('The AI response is missing required fields.');
    }

    return {
      what: parsed.what.slice(0, 1000),
      why: parsed.why.slice(0, 2000),
      fix: parsed.fix.slice(0, 3000),
      concept:
        typeof parsed.concept === 'string' ? parsed.concept.slice(0, 500) : undefined
    };
  }

  private buildPrompt(
    errorMessage: string,
    codeContext: string,
    skillLevel: SkillLevel,
    taskType: TaskType,
    timesSeen: number
  ): string {
    const style = this.styleForLevel(skillLevel);
    const role = TASK_ROLE_PROMPTS[taskType];
    const repetition = this.repetitionDirective(timesSeen);

    return `${role}

The student's code caused this error:

"${errorMessage.slice(0, 800)}"

Code around the error (>> marks the error line):

${codeContext.slice(0, 6000)}

STUDENT LEVEL: ${skillLevel}/5 — ${style.description}

${style.rules}

${repetition}

Return ONLY valid JSON (no markdown fences, no explanation):
{
  "what": "The exact mistake, one sentence.",
  "why": "Why it happened, one sentence.",
  "fix": "Concrete steps. Show BEFORE/AFTER code when short.",
  "concept": "One short sentence naming the idea."
}`;
  }

  /**
   * How many times the user has hit the same kind of error before this one.
   * The prompt gets more concrete as the count goes up.
   */
  private repetitionDirective(timesSeen: number): string {
    if (timesSeen === 0) {
      return `REPETITION: This is the first time the student has made this exact mistake. Just name it and show the fix.`;
    }
    if (timesSeen <= 2) {
      return `REPETITION: The student has made this exact mistake ${timesSeen} time${
        timesSeen === 1 ? '' : 's'
      } before. Add a short concrete example in the fix — do not be vague. Start the "what" field with a brief reminder that they've seen this before.`;
    }
    if (timesSeen <= 5) {
      return `REPETITION: The student keeps making this mistake (${timesSeen} times). Be very explicit. In the "fix" field, list the 2–3 most common concrete forms using real syntax. Explain the underlying rule, not just this instance.`;
    }
    return `REPETITION: The student has made this exact mistake ${timesSeen} times and is not learning it. Slow down completely. Write as if they have never heard of the concept. Include a worked example with real values, list the common syntax variations, and end with a checklist they can follow every time they write this kind of code. Do not assume prior knowledge.`;
  }

  private styleForLevel(level: SkillLevel): { description: string; rules: string } {
    switch (level) {
      case 1:
        return {
          description: 'never written code before',
          rules: `RULES:
- Define every technical term the first time you use it.
- Use everyday analogies where helpful.
- Short sentences. No jargon without explanation.
- In "fix", always show full BEFORE and AFTER using the student's real code.`
        };
      case 2:
        return {
          description: 'early learner',
          rules: `RULES:
- Simple language. Avoid jargon where possible.
- Explain terms a first-month learner might not know.
- In "fix", show BEFORE and AFTER using the student's real code.`
        };
      case 3:
        return {
          description: 'intermediate',
          rules: `RULES:
- Technical terms are fine, but define any that aren't everyday.
- Be concise but complete.
- In "fix", show BEFORE and AFTER using the student's real code.`
        };
      case 4:
        return {
          description: 'comfortable with the language',
          rules: `RULES:
- Assume the student knows the basics.
- Skip obvious context. Focus on the actual mistake.
- In "fix", show a short BEFORE/AFTER or just the corrected line.`
        };
      case 5:
        return {
          description: 'expert',
          rules: `RULES:
- Be terse. Assume deep familiarity.
- Just name the mistake and the fix.
- In "fix", a one-line correction is enough.`
        };
    }
  }
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}