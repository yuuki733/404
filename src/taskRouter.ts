export type TaskType = 'debug' | 'reasoning' | 'math' | 'code';

export const TASK_TYPES: TaskType[] = ['debug', 'reasoning', 'math', 'code'];

export const TASK_LABELS: Record<TaskType, string> = {
  debug: 'Debug',
  reasoning: 'Reasoning',
  math: 'Math',
  code: 'Code'
};

export const TASK_DESCRIPTIONS: Record<TaskType, string> = {
  debug: 'General errors (default fallback)',
  reasoning: 'Type flows, generics, async logic',
  math: 'NaN, division by zero, numeric parsing',
  code: 'Syntax errors, dead code, linting'
};

export const TASK_ROLE_PROMPTS: Record<TaskType, string> = {
  debug: 'You are a debugging assistant. Focus on what went wrong and how to fix it.',
  reasoning:
    'You are a logic and type-system expert. Focus on why the types or logic do not line up.',
  math:
    'You are a numerical computing expert. Focus on the arithmetic or numeric edge case.',
  code:
    'You are a code-quality expert. Focus on the syntax or style problem.'
};

export function classifyTask(errorMessage: string, _codeContext: string): TaskType {
  const msg = errorMessage;

  if (/(NaN|Infinity|division by zero|divide by zero|parseFloat|parseInt|toFixed|toPrecision|Number is not|arithmetic|modulo|numeric)/i.test(msg)) {
    return 'math';
  }
  if (/(is not assignable|no overload matches|generic|type argument|conditional type|infer|Promise<|async|await|thenable|not awaited)/i.test(msg)) {
    return 'reasoning';
  }
  if (/(syntax error|unexpected token|unexpected end|Expected .+ but found|missing semicolon|declared but its value is never read|unused|duplicate identifier)/i.test(msg)) {
    return 'code';
  }
  return 'debug';
}