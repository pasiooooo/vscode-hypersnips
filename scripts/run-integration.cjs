const { mkdirSync, writeFileSync } = require('fs');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const isolated = path.join(root, 'dist', 'integration', String(Date.now()));
  const userData = path.join(isolated, 'user');
  const snippets = path.join(isolated, 'snippets');
  const workspace = path.join(isolated, 'workspace');
  for (const dir of [path.join(userData, 'User'), snippets, workspace]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'hsnips.windows': snippets.replace(/\\/g, '/'), 'hsnips.linux': snippets, 'hsnips.mac': snippets,
    'hsnips.autoAlign.enabled': false, 'editor.autoClosingBrackets': 'never',
    'editor.autoClosingQuotes': 'never', 'editor.formatOnType': false,
    'editor.wordBasedSuggestions': 'off', 'files.autoSave': 'off',
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
    'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
  }));
  writeFileSync(path.join(snippets, 'latex.hsnips'), [
    'snippet zz "Automatic fixture" iA', 'EXPANDED', 'endsnippet',
    'snippet mm "Math fixture" iAm', 'MATH', 'endsnippet',
    'snippet tt "Text fixture" iAt', 'TEXT', 'endsnippet', '',
  ].join('\n'));
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE,
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, '.test-out/test/integration/suite.js'),
    extensionTestsEnv: { HSNIPS_TEST_WORKSPACE: workspace },
    launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', path.join(isolated, 'extensions'),
      '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu'],
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });


