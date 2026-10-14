import { execFile } from 'child_process';
import * as path from 'path';

export interface EditorFont {
  family: string;
  size: number;
  weight: string;
  letterSpacing: number;
}

let cachedFont = '';
let widths = new Map<string, number>();
let pending: Promise<void> = Promise.resolve();

// The script is constant; font settings and characters travel as JSON on stdin.
const measureScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
$installed = @([System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name })
$family = 'Consolas'
foreach ($candidate in ($request.font.family -split ',')) {
  $candidate = $candidate.Trim().Trim([char]34, [char]39)
  if ($installed -contains $candidate) { $family = $candidate; break }
}
$style = [System.Drawing.FontStyle]::Regular
if ($request.font.weight -eq 'bold' -or $request.font.weight -match '^[6-9]00$') {
  $style = [System.Drawing.FontStyle]::Bold
}
$font = [System.Drawing.Font]::new($family, $request.font.size, $style, [System.Drawing.GraphicsUnit]::Pixel)
$bitmap = [System.Drawing.Bitmap]::new(1, 1)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
try {
  $space = $graphics.MeasureString(' ', $font, [System.Drawing.PointF]::Empty, $format).Width + $request.font.letterSpacing
  $result = [System.Collections.Generic.Dictionary[string,double]]::new([System.StringComparer]::Ordinal)
  foreach ($character in $request.characters) {
    $width = $graphics.MeasureString($character, $font, [System.Drawing.PointF]::Empty, $format).Width + $request.font.letterSpacing
    $result[$character] = $width / $space
  }
  ConvertTo-Json -InputObject $result -Compress
} finally {
  $format.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  $font.Dispose()
}
`;

export async function getFontCharacterWidths(font: EditorFont, text: string) {
  // shortcut: local Windows font metrics; other hosts retain Unicode column widths.
  if (process.platform != 'win32') return new Map<string, number>();
  let key = JSON.stringify(font);
  if (key != cachedFont) {
    cachedFont = key;
    widths = new Map();
  }
  let fontWidths = widths;
  let characters = [...new Set(' ' + text + Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33)).join(''))]
    .filter((char) => !/[\p{Mark}\p{Control}]/u.test(char));
  pending = pending.then(async () => {
    let missing = characters.filter((char) => !fontWidths.has(char));
    if (!missing.length) return;
    try {
      let measured = await new Promise<Record<string, number>>((resolve, reject) => {
        let executable = path.join(process.env.SystemRoot || 'C:\\Windows',
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        let child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(measureScript, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          if (error) { reject(error); return; }
          try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
        child.stdin!.on('error', reject);
        child.stdin!.end(JSON.stringify({ font, characters: missing }));
      });
      for (let char of missing) {
        let width = measured[char];
        if (!Number.isFinite(width) || width <= 0) throw new Error('Invalid font width');
        // Remove measurement noise for fonts whose glyphs are exact multiples of a space.
        fontWidths.set(char, Math.abs(width - Math.round(width)) < 0.01 ? Math.round(width) : width);
      }
    } catch {
      // Avoid repeatedly spawning a blocked or unavailable font service while typing.
      for (let char of missing) fontWidths.set(char, 0);
    }
  });
  await pending;
  return new Map([...fontWidths].filter(([, width]) => width > 0));
}
