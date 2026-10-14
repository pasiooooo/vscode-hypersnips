import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';

export async function testAutoAlignSetting() {
  let enabled = true;
  let edits = 0;
  let measurements = 0;
  let timer: (() => Promise<void>) | undefined;
  let change: (event: any) => Promise<void>;
  let configure: (event: any) => void;
  let finishMeasurement: (() => void) | undefined;
  let holdMeasurement = false;
  let text = '\\begin{matrix}\n  a&b \\\\\n  longer&c \\\\\n\\end{matrix}';
  let document = {
    uri: {}, languageId: 'latex', version: 1,
    getText: () => text,
    offsetAt: (position: number) => position,
    positionAt: (offset: number) => offset,
  };
  let cursor = text.indexOf('a&');
  let editor = {
    document, options: { tabSize: 4 },
    selection: { active: cursor }, selections: [{ anchor: cursor, active: cursor }],
    edit: async () => { edits++; return true; },
  };
  let disposable = () => ({ dispose() {} });
  let vscode = {
    Disposable: class { constructor(public dispose: () => void) {} },
    Range: class { constructor(public start: number, public end: number) {} },
    window: {
      activeTextEditor: editor,
      onDidChangeVisibleTextEditors: disposable,
      onDidChangeActiveTextEditor: disposable,
      onDidChangeTextEditorSelection: disposable,
    },
    workspace: {
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key == 'autoAlign.enabled' ? enabled : fallback }),
      onDidSaveTextDocument: disposable,
      onDidChangeTextDocument: (handler: typeof change) => { change = handler; return disposable(); },
      onDidChangeConfiguration: (handler: typeof configure) => { configure = handler; return disposable(); },
    },
    commands: { executeCommand: () => Promise.resolve(), registerCommand: disposable, registerTextEditorCommand: disposable },
    languages: { registerCompletionItemProvider: disposable },
    env: {},
  };
  let exported: { activate?: (context: { subscriptions: unknown[] }) => void } = {};
  let extensionPath = path.join(__dirname, '../src/extension.js');
  runInNewContext(readFileSync(extensionPath, 'utf8'), {
    exports: exported, console,
    setTimeout: (callback: typeof timer) => { timer = callback; return 1; },
    clearTimeout: () => { timer = undefined; },
    require: (name: string) => {
      if (name == 'vscode') return vscode;
      if (name == 'fs') return { existsSync: () => true };
      if (name == './utils') return { getSnippetDir: () => 'unused-test-directory' };
      if (name == './snippetProfiles') return { normalizeProfileName: () => '', getSnippetFilesForProfile: () => [] };
      if (name == './snippetManager') return { registerSnippetManager() {} };
      if (name == './environmentConvert') return { createEnvironmentNameSyncPlan: () => ({ handled: false }) };
      if (name == './fontMetrics') return { getFontCharacterWidths: async () => {
        measurements++;
        if (holdMeasurement) await new Promise<void>((resolve) => { finishMeasurement = resolve; });
        return new Map();
      } };
      if (name == './latexEdit' || name == './latexAlignment') return require(path.join(__dirname, '../src', name));
      return {};
    },
  });
  exported.activate!({ subscriptions: [] });
  let event = { document, contentChanges: [{ rangeOffset: cursor, rangeLength: 0, text: 'ab' }] };
  enabled = false;
  await change!(event);
  assert.strictEqual(timer, undefined, 'disabled alignment must not schedule work');
  assert.strictEqual(measurements, 0);
  enabled = true;
  await change!(event);
  await timer!();
  assert.strictEqual(edits, 1, 'enabled alignment applies edits');
  await change!(event);
  enabled = false;
  configure!({ affectsConfiguration: (key: string) => key == 'hsnips.autoAlign' });
  assert.strictEqual(timer, undefined, 'turning alignment off cancels pending work');
  enabled = true;
  holdMeasurement = true;
  await change!(event);
  let running = timer!();
  enabled = false;
  finishMeasurement!();
  await running;
  assert.strictEqual(edits, 1, 'turning alignment off during measurement prevents edits');
}
