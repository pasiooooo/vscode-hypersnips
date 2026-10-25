const { mkdirSync, writeFileSync } = require('fs');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const isolated = path.join(root, 'tmp', 'integration', String(Date.now()));
  const userData = path.join(isolated, 'user');
  const snippets = path.join(isolated, 'snippets');
  const workspace = path.join(isolated, 'workspace');
  const temp = path.join(isolated, 'tmp');
  for (const dir of [path.join(userData, 'User'), snippets, workspace, temp]) mkdirSync(dir, { recursive: true });
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
    'snippet tt "Text fixture" iAt', 'TEXT', 'endsnippet',
    'snippet manual "Manual fixture" w', 'MANUAL', 'endsnippet',
    'snippet dd "Dynamic fixture" w', '$1 = ``rv = (t[0] || "seed").toUpperCase()``$0', 'endsnippet', '',
  ].join('\n'));
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE,
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    cachePath: path.join(root, 'tmp', 'vscode-test'),
    extensionTestsEnv: { TEMP: temp, TMP: temp, TMPDIR: temp },
    extensionDevelopmentPath: process.env.VSCODE_TEST_EXTENSION_ROOT || root,
    extensionTestsPath: path.join(root, 'tmp/test-out/test/integration/suite.js'),
    launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', path.join(isolated, 'extensions'),
      '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu'],
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });


