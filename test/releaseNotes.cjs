const assert = require('assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const { getReleaseNotes } = require('../scripts/release-notes.cjs');

const expected = [
  '## [1.2.3] - 2026-10-25', '', '### Changed', '',
  '- Preserve **Markdown** and `code`.', '  - Preserve nested details.', '',
  '### Fixed', '', '- Keep the selected version only.',
].join('\n') + '\n';
const changelog = [
  '# Changelog', '', '## [Unreleased]', '', '- Future changes.', '',
  '## [1.2.30] - 2026-10-25', '', '- A different version.', '',
  expected, '## [1.2.2] - 2026-10-20', '', '- Older changes.',
].join('\n');

for (const input of [changelog, changelog.replace(/\n/g, '\r\n')]) {
  assert.equal(getReleaseNotes(input, '1.2.3', 'v1.2.3'), expected);
}
assert.equal(getReleaseNotes(expected, '1.2.3', 'v1.2.3'), expected);
assert.equal(getReleaseNotes(expected + '\n## Maintenance\n\n- Other information.', '1.2.3', 'v1.2.3'), expected);
assert.throws(() => getReleaseNotes(changelog, '1.2.3', 'v1.2.4'), /tag.*package/i);
assert.throws(() => getReleaseNotes(changelog, '1.2.4', 'v1.2.4'), /exactly one/i);
assert.throws(() => getReleaseNotes(changelog + '\n' + expected, '1.2.3', 'v1.2.3'), /exactly one/i);
assert.throws(() => getReleaseNotes('## [1.2.3]\n\n- Undated.', '1.2.3', 'v1.2.3'), /date/i);
assert.throws(() => getReleaseNotes('## [1.2.3] - 2026-10-25\n\n### Changed\n', '1.2.3', 'v1.2.3'), /entry/i);
assert.throws(() => getReleaseNotes('## [1.2.3] - 2026-10-25\n\n## [Unreleased]\n\n- Future.', '1.2.3', 'v1.2.3'), /entry/i);

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const repositoryNotes = getReleaseNotes(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version, 'v' + version);
assert.ok(repositoryNotes.startsWith('## [' + version + '] - '));
assert.ok(!repositoryNotes.includes('## [Unreleased]'));
console.log('Release notes: exact version, Markdown, CRLF, invalid sections and repository changelog passed.');
