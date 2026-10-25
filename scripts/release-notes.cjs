const { mkdirSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');

function getReleaseNotes(changelog, version, tag) {
  if (tag !== 'v' + version) throw new Error('Release tag must match the package.json version: v' + version);
  const text = changelog.replace(/\r\n/g, '\n');
  const headings = Array.from(text.matchAll(/^## .+$/gm));
  const matches = headings.filter(heading => heading[0].startsWith('## [' + version + ']'));
  if (matches.length !== 1) throw new Error('CHANGELOG.md must contain exactly one section for [' + version + ']');
  const heading = matches[0];
  if (!/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/.test(heading[0])) {
    throw new Error('Release section must include a date: ## [' + version + '] - YYYY-MM-DD');
  }
  const end = headings[headings.indexOf(heading) + 1]?.index ?? text.length;
  const body = text.slice(heading.index + heading[0].length, end);
  if (!/^[-*] +\S/m.test(body)) throw new Error('Release section must contain at least one changelog entry');
  return text.slice(heading.index, end).trim() + '\n';
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const version = require('../package.json').version;
    const notes = getReleaseNotes(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version, process.argv[2]);
    const output = path.join(root, 'dist', 'release-notes.md');
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, notes, 'utf8');
    console.log('Release notes written to ' + output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { getReleaseNotes };
