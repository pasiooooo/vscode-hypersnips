const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
  throw new Error('Commit the performance changes before packaging so the filename identifies the tested source.');
}
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const version = require('../package.json').version;
const output = path.join(root, 'dist', 'performance', 'vscode-hypersnips-' + version + '-perf.' + sha + '.vsix');
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--out', output], { cwd: root, stdio: 'inherit' });
console.log(output);

