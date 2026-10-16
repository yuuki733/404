import * as vscode from 'vscode';

const MAX_RELATED_FILES = 4;
const MAX_FILE_CHARS = 2200;
const EXCLUDED = '**/{node_modules,.git,dist,out,build,coverage,.venv,venv,vendor,.next}/**';
const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs}';

export async function extractContext(
  document: vscode.TextDocument,
  range: vscode.Range,
  token?: vscode.CancellationToken
): Promise<string> {
  const config = vscode.workspace.getConfiguration('404Extension');
  const contextLines = Math.max(2, Math.min(20, config.get<number>('contextLines', 8)));
  const startLine = Math.max(0, range.start.line - contextLines);
  const endLine = Math.min(document.lineCount - 1, range.end.line + contextLines);
  const lines: string[] = [];

  for (let i = startLine; i <= endLine; i++) {
    if (token?.isCancellationRequested) break;
    const marker = i >= range.start.line && i <= range.end.line ? '>> ' : '   ';
    lines.push(`${marker}${i + 1}: ${document.lineAt(i).text}`);
  }

  const sections = [`CURRENT FILE: ${document.fileName}\n${lines.join('\n')}`];
  if (!config.get<boolean>('includeWorkspaceContext', true) || token?.isCancellationRequested) {
    return sections.join('\n\n');
  }

  const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspace) return sections.join('\n\n');

  const identifiers = extractIdentifiers(document.getText(), range);
  if (!identifiers.length) return sections.join('\n\n');

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspace, SOURCE_GLOB),
    EXCLUDED,
    150,
    token
  );

  let added = 0;
  for (const uri of files) {
    if (token?.isCancellationRequested || added >= MAX_RELATED_FILES) break;
    if (uri.toString() === document.uri.toString()) continue;

    const basename = uri.path.split('/').pop() ?? '';
    if (/\.(env|pem|key|crt|p12|pfx)$/i.test(basename) || /secret|credential/i.test(basename)) continue;

    let related: vscode.TextDocument;
    try { related = await vscode.workspace.openTextDocument(uri); }
    catch { continue; }

    const matchingLines = related.getText().split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter(item => identifiers.some(id =>
        new RegExp(`(^|[^\\w$])${escapeRegExp(id)}([^\\w$]|$)`).test(item.line)
      ))
      .slice(0, 8);

    if (!matchingLines.length) continue;
    const excerpt = matchingLines
      .map(item => `${item.index + 1}: ${item.line}`)
      .join('\n')
      .slice(0, MAX_FILE_CHARS);

    sections.push(`RELATED FILE: ${vscode.workspace.asRelativePath(uri)}\n${excerpt}`);
    added++;
  }

  return sections.join('\n\n').slice(0, 12000);
}

function extractIdentifiers(text: string, range: vscode.Range): string[] {
  const line = text.split(/\r?\n/).slice(range.start.line, range.end.line + 1).join('\n');
  const candidates = line.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
  const stop = new Set([
    'const','let','var','function','return','class','public','private',
    'this','null','true','false','undefined','async','await','import',
    'from','export','default','new','throw','catch','else','while',
    'for','if','string','number','boolean'
  ]);
  return [...new Set(candidates.filter(value => !stop.has(value)))].slice(0, 12);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}