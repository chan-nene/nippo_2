import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
await build({entryPoints:['rich-text.js'],bundle:true,format:'iife',target:'chrome100',outfile:'../web/rich-text.js',minify:true,legalComments:'eof'});
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const notices=[];
for (const [directory,metadata] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))) {
  if (!directory || metadata.dev) continue;
  let license='';
  for (const filename of ['LICENSE.md','LICENSE','LICENSE.txt','license']) {
    try {license=await readFile(`${directory}/${filename}`,'utf8');break;} catch {}
  }
  if (!license) throw new Error(`License file missing: ${directory}`);
  notices.push(`${directory.replace(/^node_modules\//,'')} ${metadata.version}\n${license.trim()}`);
}
await writeFile('../web/rich-text.LICENSES.txt',notices.join('\n\n----------------------------------------\n\n')+'\n');
