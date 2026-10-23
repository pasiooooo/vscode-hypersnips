import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';
import { parse } from '../src/parser';
import { parse as baseline } from './reference/parser';
import { parseSnippetDocument } from '../src/snippetDocument';
const evaluate = (fn: () => unknown) => { try { return fn(); } catch (error) { const e = error as Error; return { error: e.name, message: e.message }; } };
const normalize = (snippets: ReturnType<typeof parse>) => snippets.map(({generator, ...rest}) => ({...rest, outputs: [evaluate(() => generator(['a','b'], ['m','c'], 'w','p')), evaluate(() => generator(['c'], ['m'], 'x','y'))]}));
function parserChecks() {
  const fixtures = ['', 'snippet x\r\nline\r\nendsnippet', 'snippet empty\nendsnippet', 'snippet noend\nlast',
    'snippet multiline\nbefore ``\nrv = "value";\n`` after\nendsnippet',
    'snippet trailing\n``rv = "end";``endsnippet\nsnippet next\nnext\nendsnippet',
    'snippet slash\n\\alpha \\beta\nendsnippet',
    'global extra\nlet v = "ok";\nendglobal extra\npriority -3\nsnippet x\n``rv = v;``\nendsnippet extra',
    'priority invalid\nsnippet `a(.*)` "regex" M\n``rv = m[1] + t[1] + w + path;`` tail\nendsnippet'];
  for (const flags of ['', 'A','M','i','w','b','m','t','AMiwbmt']) fixtures.push(`priority 12\nsnippet flag "flag" ${flags}\n$1 \${2} $0\nendsnippet\nsnippet reset\nreset\nendsnippet`);
  for (let i=0;i<80;i++) fixtures.push(`global\nlet v=${i};\nendglobal\npriority ${i-40}\nsnippet r${i}\n$1 \`\`rv=String(++v);\`\` mid \`\`rv=t[0];\`\` end\nendsnippet\nsnippet b\n\`\`rv=String(++v);\`\`\nendsnippet`);
  for (const source of fixtures) assert.deepStrictEqual(normalize(parse(source)), normalize(baseline(source)), source);
  for (const source of ['global\nthrow new Error("synthetic");\nendglobal', 'snippet `[`\nbody\nendsnippet','snippet bad\n``rv=;``\nendsnippet']) { assert.throws(()=>parse(source)); assert.throws(()=>baseline(source)); }
  let shifts=0; const shift=Array.prototype.shift;
  Array.prototype.shift=function(){shifts++;return shift.call(this);};
  try { parse('snippet x\nbody\nendsnippet\n'.repeat(1000)); } finally { Array.prototype.shift=shift; }
  assert.strictEqual(shifts,0,'parser must not shift remaining source lines');
  const doc=parseSnippetDocument('snippet repeat A\nbody\nendsnippet\n'.repeat(1000));
  assert.strictEqual(doc.snippets.length,1000); assert.ok(doc.snippets.every(s=>s.diagnostics.length===2));
}
async function reloadChecks() {
  let profile='', reads=0, calls=0, failRead=false, timing='before', api:any;
  const content:Record<string,string>={all:'priority 3\nsnippet shared\nshared\nendsnippet',tex:'snippet old\nold\nendsnippet'};
  const errors:string[]=[]; const exports:any={};
  const vscode={ConfigurationTarget:{Global:1},workspace:{getConfiguration:()=>({get:()=>profile,update:async (_key:string,value:string)=>{profile=value;if(timing==='before'){await api.loadSnippetProfile();await api.loadSnippetProfile();}else if(timing==='during'){void api.loadSnippetProfile();void api.loadSnippetProfile();}}})},window:{showErrorMessage:(m:string)=>errors.push(m),showInformationMessage:()=>{},showQuickPick:async()=>({profile:'synthetic'})}};
  runInNewContext(readFileSync(path.join(__dirname,'../src/extension.js'),'utf8')+'\nexports.testing={loadSnippets,loadSnippetProfile,selectSnippetProfile,snippets:()=>SNIPPETS_BY_LANGUAGE};',{exports,console,setTimeout,clearTimeout,require:(name:string)=>{
    if(name==='vscode')return vscode;
    if(name==='fs')return {existsSync:()=>true,readFileSync:(file:string)=>{reads++;if(failRead&&file==='tex')throw Error('synthetic read failure');return content[file];}};
    if(name==='./utils')return {getSnippetDir:()=> 'synthetic-directory'};
    if(name==='./snippetProfiles')return {normalizeProfileName:(v:string)=>v,getSnippetFilesForProfile:()=>[{filePath:'all',language:'all'},{filePath:'tex',language:'tex'}],discoverSnippetProfiles:()=>['synthetic']};
    if(name==='./parser')return {parse:(source:string)=>{calls++;return parse(source);}};
    return name.startsWith('.')?{}:require(name);
  }});
  api=exports.testing;
  await Promise.all([api.loadSnippets(),api.loadSnippets(),api.loadSnippets()]);
  assert.strictEqual(reads,2,'duplicate reloads should read each file once');assert.strictEqual(calls,2);
  assert.deepStrictEqual(Array.from(api.snippets().get('tex'),(s:any)=>s.trigger),['shared','old']);
  await api.loadSnippets();assert.strictEqual(reads,4,'future reload must run globals again');
  const previous=api.snippets();
  content.tex='global\nthrow new Error("synthetic global failure");\nendglobal';await api.loadSnippets();assert.strictEqual(api.snippets(),previous);
  content.tex='snippet bad\n``rv=;``\nendsnippet';await api.loadSnippets();assert.strictEqual(api.snippets(),previous);
  failRead=true;await api.loadSnippets();assert.strictEqual(api.snippets(),previous);assert.strictEqual(errors.length,3);
  failRead=false;content.tex='snippet fresh\nnew\nendsnippet';await api.loadSnippets();assert.notStrictEqual(api.snippets(),previous);
  for(const nextTiming of ['before','during','none']){profile='';await api.loadSnippetProfile();timing=nextTiming;const readsBefore: number=reads;await api.selectSnippetProfile();assert.strictEqual(reads-readsBefore,2,`profile callback ${timing}`);if(timing==="none"){await api.loadSnippetProfile();assert.strictEqual(reads-readsBefore,2,"late configuration callback is coalesced");}await api.loadSnippets();assert.strictEqual(reads-readsBefore,4);}
  const independentReads: number = reads; await api.loadSnippetProfile(); assert.strictEqual(reads-independentReads,2,'unrelated future configuration must reload globals');
}
async function main(){
  const failures:unknown[]=[];
  for (const check of [parserChecks,reloadChecks]) { try { await check(); } catch(error) { failures.push(error);console.error(error); } }
  assert.strictEqual(failures.length,0,'focused snippet checks failed');
  console.log('Parser/reference, grouping and atomic/coalesced reload checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
