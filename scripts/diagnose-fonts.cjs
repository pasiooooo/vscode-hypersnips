const { readFileSync } = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runInNewContext } = require('vm');
const { performance } = require('perf_hooks');

if (process.platform !== 'win32') process.exit(0);
const source = readFileSync(path.resolve(__dirname, '../tmp/test-out/src/fontMetrics.js'), 'utf8');
const exportsForProbe = {};
runInNewContext(source + '\nexports.script = measureScript;', {
  exports: exportsForProbe, require, Buffer, process, queueMicrotask,
});
const request = {
  font: { family: 'Consolas, monospace', size: 14, weight: 'normal', letterSpacing: 0 },
  characters: [...' \u793a\u4f8b iW', ...Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33))],
};
async function probe(timeout) {
  const start = performance.now();
  await new Promise(resolve => {
    const child = execFile(path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(exportsForProbe.script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      console.log(JSON.stringify({
        timeout, elapsedMs: performance.now() - start,
        error: error && { message: error.message, code: error.code, killed: error.killed, signal: error.signal },
        stdout, stderr,
      }));
      resolve();
    });
    child.stdin.on('error', error => console.log('stdin: ' + error.message));
    child.stdin.end(JSON.stringify(request));
  });
}
(async () => { await probe(5000); await probe(20000); })().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
