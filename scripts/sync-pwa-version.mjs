import {createHash} from 'node:crypto';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
const root=resolve('public'),hash=createHash('sha256');
async function files(dir){const list=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())list.push(...await files(path));else if(entry.name!=='sw.js')list.push(path);}return list;}
for(const file of (await files(root)).sort()){hash.update(relative(root,file).replaceAll('\\','/'));hash.update('\0');hash.update(await readFile(file));hash.update('\0');}
const version=hash.digest('hex').slice(0,16),packageJson=JSON.parse(await readFile('package.json','utf8')),prefix=packageJson.name==='wastapp-mensageria'?'mensageria-static':'central-vps-static';
const file=resolve(root,'sw.js'),old=await readFile(file,'utf8');
if(!/const CACHE = '[^']+';/.test(old))throw Error('service_worker_cache_marker_missing');
const updated=old.replace(/const CACHE = '[^']+';/,`const CACHE = '${prefix}-${version}';`);
if(updated!==old)await writeFile(file,updated);
console.log(`PWA ${prefix}: ${version}`);
