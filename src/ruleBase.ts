import { Explanation } from './types';
import { TeachingDepth } from './mistakeTracker';

export { Explanation } from './types';

interface Rule {
  match: RegExp;
  explain: (
    code: string,
    match: RegExpMatchArray,
    depth: TeachingDepth
  ) => Explanation;
}

const KEYWORDS = new Set([
  'function','const','let','var','return','if','else','for','while','class',
  'new','this','async','await','import','from','export','default','typeof',
  'instanceof','null','true','false','undefined','throw','try','catch',
  'finally','switch','case','break','continue','do','in','of','void',
  'delete','yield','interface','type','enum','implements','extends','super',
  'static','public','private','protected','readonly','declare','namespace',
  'module','abstract','as','is','keyof','infer','asserts'
]);

function errorLine(code: string): string {
  const line = code.split('\n').find(l => l.trim().startsWith('>>'));
  if (!line) return '';
  const idx = line.indexOf(':');
  return idx >= 0 ? line.slice(idx + 1).trim() : line.trim();
}

function firstName(code: string): string {
  const line = errorLine(code);
  const matches = line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const word of matches) {
    if (!KEYWORDS.has(word)) return word;
  }
  return 'this value';
}

function firstCallName(code: string): string {
  const line = errorLine(code);
  const m = line.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  return m && !KEYWORDS.has(m[1]) ? m[1] : firstName(code);
}

function firstPropertyName(code: string): string {
  const line = errorLine(code);
  const m = line.match(/\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
  return m ? m[1] : 'that property';
}

const rules: Rule[] = [
  // ============================ TYPE ANNOTATIONS ============================
  // These are the mistakes a beginner makes most often. They adapt.

  {
    match: /Parameter '([^']+)' implicitly has an 'any' type/i,
    explain: (_c, m, depth) => {
      const name = m[1];
      return whatNeedsAType(name, depth);
    }
  },

  {
    match: /Variable '([^']+)' implicitly has an 'any' type/i,
    explain: (_c, m, depth) => {
      const name = m[1];
      return whatNeedsAType(name, depth);
    }
  },

  {
    match: /implicitly has an 'any' type/i,
    explain: (code, _m, depth) => {
      const name = firstName(code);
      return whatNeedsAType(name, depth);
    }
  },

  // ============================ NON-ADAPTIVE RULES ==========================
  // These give the same answer every time. They're either rare,
  // environment-specific, or already specific enough.

  {
    match: /Object is possibly 'undefined'/i,
    explain: (code) => {
      const name = firstName(code);
      return {
        what: `\`${name}\` might be empty at this point.`,
        why: `TypeScript sees that \`${name}\` could be \`undefined\` here, and you're using it like it's always there.`,
        fix: `Check first:\n\n\`\`\`ts\nif (${name}) {\n  // use ${name} safely here\n}\n\`\`\`\n\nOr use optional chaining: \`${name}?.something\`.`,
        concept: 'Checking for missing values'
      };
    }
  },

  {
    match: /Object is possibly 'null'/i,
    explain: (code) => {
      const name = firstName(code);
      return {
        what: `\`${name}\` might be \`null\` here.`,
        why: `The value could be empty when this line runs.`,
        fix: `Check before using:\n\n\`\`\`ts\nif (${name} !== null) {\n  // safe to use ${name}\n}\n\`\`\``,
        concept: 'Null checks'
      };
    }
  },

  {
    match: /Property '([^']+)' does not exist on type '([^']+)'/i,
    explain: (_c, m) => ({
      what: `\`${m[2]}\` has no property called \`${m[1]}\`.`,
      why: `Either the name is spelled wrong or it belongs to a different type.`,
      fix: `Check the spelling of \`${m[1]}\`.`,
      concept: 'Properties on a type'
    })
  },

  {
    match: /Property '([^']+)' is missing in type '([^']+)' but required in type '([^']+)'/i,
    explain: (_c, m) => ({
      what: `\`${m[2]}\` is missing the required property \`${m[1]}\`.`,
      why: `The type \`${m[3]}\` requires \`${m[1]}\`.`,
      fix: `Add \`${m[1]}\` to the object, or make it optional: \`${m[1]}?\`.`,
      concept: 'Required vs optional properties'
    })
  },

  {
    match: /Type '([^']+)' is not assignable to type '([^']+)'/i,
    explain: (_c, m) => ({
      what: `You're giving a \`${m[1]}\` where a \`${m[2]}\` is expected.`,
      why: `The value's type doesn't match.`,
      fix: `Convert the value, or loosen the target type to accept \`${m[1]}\`.`,
      concept: 'Type compatibility'
    })
  },

  {
    match: /Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/i,
    explain: (_c, m) => ({
      what: `You passed a \`${m[1]}\` where the function expects a \`${m[2]}\`.`,
      why: `The value's type doesn't match the parameter type.`,
      fix: `Convert the value before passing it.`,
      concept: 'Function parameter types'
    })
  },

  {
    match: /Expected (\d+) arguments?, but got (\d+)/i,
    explain: (_c, m) => ({
      what: `This function expects ${m[1]} argument(s), but you gave ${m[2]}.`,
      why: `Wrong number of arguments.`,
      fix: `Add the missing argument(s) or remove the extra one(s).`,
      concept: 'Function signatures'
    })
  },

  {
    match: /Variable '([^']+)' is used before being assigned/i,
    explain: (_c, m) => ({
      what: `\`${m[1]}\` is used before it's given a value.`,
      why: `Nothing has been assigned to it yet on this path.`,
      fix: `Give \`${m[1]}\` a value before this line runs.`,
      concept: 'Definite assignment'
    })
  },

  {
    match: /Duplicate identifier '([^']+)'/i,
    explain: (_c, m) => ({
      what: `\`${m[1]}\` is defined more than once.`,
      why: `Two declarations with the same name in the same scope.`,
      fix: `Rename one or remove the duplicate.`,
      concept: 'Unique names in a scope'
    })
  },

  {
    match: /This expression is not callable/i,
    explain: (code) => {
      const name = firstCallName(code);
      return {
        what: `You called \`${name}\` like a function, but it isn't one.`,
        why: `\`${name}\` is a value, not a function.`,
        fix: `Check what \`${name}\` is:\n\n\`\`\`ts\nconsole.log(typeof ${name});\n\`\`\``,
        concept: 'Callable values'
      };
    }
  },

  {
    match: /Cannot read propert(y|ies) .* of (undefined|null)/i,
    explain: (code) => {
      const name = firstName(code);
      const prop = firstPropertyName(code);
      return {
        what: `You tried to read \`${prop}\` from something that is \`undefined\` or \`null\`.`,
        why: `\`${name}\` hasn't been set yet.`,
        fix: `Check before using:\n\n\`\`\`js\nif (${name}) {\n  ${name}.${prop}\n}\n\`\`\``,
        concept: 'Handling missing values safely'
      };
    }
  },

  {
    match: /(is not a function|is not a constructor)/i,
    explain: (code) => {
      const name = firstCallName(code);
      return {
        what: `\`${name}\` isn't a function.`,
        why: `You called \`${name}(...)\` but it's something else.`,
        fix: `Check the spelling. If it comes from a library, confirm the import.`,
        concept: 'Calling the right thing'
      };
    }
  },

  {
    match: /Cannot find name '([^']+)'/i,
    explain: (_c, m) => ({
      what: `\`${m[1]}\` isn't defined here.`,
      why: `TypeScript can't find a variable, function, or import with that name.`,
      fix: `Check the spelling. If it should come from another file, add an \`import\`.`,
      concept: 'Names must exist before they are used'
    })
  },

  {
    match: /(ReferenceError|is not defined)/i,
    explain: (code) => {
      const name = firstName(code);
      return {
        what: `\`${name}\` isn't defined.`,
        why: `You used a name that hasn't been created or imported.`,
        fix: `Check the spelling. If it's from another file, import it.`,
        concept: 'Scope and imports'
      };
    }
  },

  {
    match: /Cannot assign to '([^']+)' because it is a constant/i,
    explain: (_c, m) => ({
      what: `You tried to change \`${m[1]}\`, but it was declared with \`const\`.`,
      why: `\`const\` values can't be reassigned.`,
      fix: `Change \`const ${m[1]}\` to \`let ${m[1]}\` if the value needs to change.`,
      concept: 'const vs let'
    })
  },

  {
    match: /Assignment to constant variable/i,
    explain: (code) => {
      const name = firstName(code);
      return {
        what: `You tried to change \`${name}\` after declaring it with \`const\`.`,
        why: `\`const\` values can't be reassigned.`,
        fix: `Change \`const ${name}\` to \`let ${name}\`.`,
        concept: 'const vs let'
      };
    }
  },

  {
    match: /Cannot access '([^']+)' before initialization/i,
    explain: (_c, m) => ({
      what: `\`${m[1]}\` is used before it's ready.`,
      why: `\`let\` and \`const\` can't be used before their declaration line.`,
      fix: `Move the declaration of \`${m[1]}\` above this line.`,
      concept: 'Temporal dead zone'
    })
  },

  {
    match: /Maximum call stack size exceeded/i,
    explain: () => ({
      what: `A function called itself forever.`,
      why: `Infinite recursion.`,
      fix: `Add a stop condition (base case).`,
      concept: 'Recursion and base cases'
    })
  },

  {
    match: /Invalid left-hand side in assignment/i,
    explain: () => ({
      what: `The left side of \`=\` can't be assigned to.`,
      why: `You wrote something like \`a + b = c\`.`,
      fix: `Make sure the left side is a variable: \`myVar = value\`.`,
      concept: 'Assignment targets'
    })
  },

  {
    match: /(JSON\.parse|Unexpected token .* in JSON|Unexpected end of JSON)/i,
    explain: () => ({
      what: `\`JSON.parse\` got something that isn't valid JSON.`,
      why: `The string has a typo.`,
      fix: `Log the string: \`console.log(str)\`, then check it in jsonlint.com.`,
      concept: 'Valid JSON'
    })
  },

  {
    match: /Each child in a list should have a unique "?key"? prop/i,
    explain: () => ({
      what: `A list item is missing its \`key\` prop.`,
      why: `React needs a stable \`key\` on each item.`,
      fix: `Add \`key={item.id}\` to the outer element inside \`.map()\`.`,
      concept: 'React list keys'
    })
  },

  {
    match: /Rendered (more|fewer) hooks than during the previous render/i,
    explain: () => ({
      what: `You called a different number of hooks between renders.`,
      why: `Hooks must always run in the same order.`,
      fix: `Move all hooks to the top of the component, before any \`if\` or loop.`,
      concept: 'Rules of hooks'
    })
  },

  {
    match: /Cannot find module '([^']+)' or its corresponding type declarations/i,
    explain: (_c, m) => ({
      what: `Package or type definitions for \`${m[1]}\` are missing.`,
      why: `Either the library or its types aren't installed.`,
      fix: `Run:\n\n\`\`\`bash\nnpm install ${m[1]}\n\`\`\``,
      concept: 'Installing packages and their types'
    })
  },

  {
    match: /Cannot find module '([^']+)'/i,
    explain: (_c, m) => ({
      what: `Can't find the module \`${m[1]}\`.`,
      why: `Package not installed or path is wrong.`,
      fix: `If it's a package, run \`npm install ${m[1]}\`.`,
      concept: 'Resolving imports'
    })
  },

  {
    match: /ENOENT: no such file or directory/i,
    explain: () => ({
      what: `A file or folder was expected, but it isn't there.`,
      why: `The path is wrong or the file was moved.`,
      fix: `Log the path with \`console.log(path)\` and check it on disk.`,
      concept: 'File paths'
    })
  },

  {
    match: /EADDRINUSE/i,
    explain: () => ({
      what: `The port you're trying to use is already taken.`,
      why: `Another program is on that port.`,
      fix: `Kill the other process or change the port.`,
      concept: 'Network ports'
    })
  },

  {
    match: /(EPERM|EACCES|permission denied)/i,
    explain: () => ({
      what: `Permission denied.`,
      why: `The file is protected or in use.`,
      fix: `Close programs using the file. On Windows, run the terminal as Administrator.`,
      concept: 'File permissions'
    })
  },

  {
    match: /Expected ['`]([^'`]+)['`] but found/i,
    explain: (_c, m) => ({
      what: `A \`${m[1]}\` is missing here.`,
      why: `There's a small syntax mistake.`,
      fix: `Look at the line just above this one. The real problem is often one line up.`,
      concept: 'Matching brackets and quotes'
    })
  },

  {
    match: /Missing semicolon/i,
    explain: () => ({
      what: `A semicolon is missing at the end of this line.`,
      why: `Some styles require a \`;\` to end statements.`,
      fix: `Add \`;\` at the end of the line.`,
      concept: 'Statement terminators'
    })
  },

  {
    match: /'([^']+)' is declared but its value is never read/i,
    explain: (_c, m) => ({
      what: `You declared \`${m[1]}\` but never used it.`,
      why: `This is dead code.`,
      fix: `Either use it, or delete the declaration.`,
      concept: 'Dead code'
    })
  },

  {
    match: /Unexpected token/i,
    explain: () => ({
      what: `There's an unexpected symbol here.`,
      why: `The file has a syntax problem.`,
      fix: `Look at the line above this one.`,
      concept: 'Syntax errors'
    })
  },

  {
    match: /Unexpected end of input/i,
    explain: () => ({
      what: `The file ended too early.`,
      why: `Something is missing at the end — usually a closing bracket or quote.`,
      fix: `Check that every \`{\` has a matching \`}\` and every \`[\` has a matching \`]\`.`,
      concept: 'Balanced brackets'
    })
  }
];

/**
 * The adaptive explanation for "you need a type annotation".
 * It gets more concrete each time the user makes the same mistake.
 */
function whatNeedsAType(name: string, depth: TeachingDepth): Explanation {
  switch (depth) {
    case 1:
      return {
        what: `TypeScript doesn't know what type \`${name}\` is.`,
        why: `You didn't tell TypeScript what kind of value \`${name}\` holds.`,
        fix: `Add a type right after the name:\n\n\`\`\`ts\n${name}: string\n\`\`\``,
        concept: 'Telling TypeScript what type a value is'
      };

    case 2:
      return {
        what: `\`${name}\` needs a type annotation.`,
        why: `Same as before — TypeScript can't guess the type, so you have to write it.`,
        fix: `Put a colon and a type right after the name:\n\n\`\`\`ts\n${name}: string\n\`\`\`\n\nYou've seen this error before. The pattern is always: \`name: type\`.`,
        concept: 'A colon declares the type'
      };

    case 3:
      return {
        what: `Every parameter and variable needs an explicit type in TypeScript. \`${name}\` doesn't have one.`,
        why: `TypeScript has strict mode on, which requires you to write the type yourself. It won't guess.`,
        fix: `Add the type after the name, separated by a colon:\n\n\`\`\`ts\n${name}: string       // text\n${name}: number       // any number\n${name}: boolean      // true or false\n${name}: string[]     // list of strings\n\`\`\`\n\nPick the one that matches what \`${name}\` will hold.`,
        concept: 'All TypeScript values must have a declared type'
      };

    case 4:
      return {
        what: `You're repeatedly forgetting to declare a type for variables and parameters — \`${name}\` is the latest case.`,
        why: `TypeScript requires every value to have a type. When you don't write one, TypeScript falls back to \`any\`, which turns off all type checking. Strict mode doesn't allow that.`,
        fix: `Add a type after every variable and parameter name using a colon. The common types:\n\n\`\`\`ts\nconst name: string = "Alice";\nconst age: number = 30;\nconst active: boolean = true;\nconst names: string[] = ["Alice", "Bob"];\nconst anything: any = ...;       // any — no checking, use sparingly\nconst maybe: string | null = null;  // string or null\n\`\`\`\n\nFor functions:\n\n\`\`\`ts\nfunction greet(name: string, times: number): string {\n  return name.repeat(times);\n}\n\`\`\`\n\nThe pattern is always: \`name: type\`. Get in the habit of writing it whenever you declare anything.`,
        concept: 'Every value must have a declared type'
      };
  }
}

export function lookup(
  errorMessage: string,
  code: string,
  depth: TeachingDepth = 1
): Explanation | undefined {
  for (const rule of rules) {
    const m = errorMessage.match(rule.match);
    if (m) return rule.explain(code, m, depth);
  }
  return undefined;
}