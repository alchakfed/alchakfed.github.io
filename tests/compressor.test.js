const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const OUT = path.resolve(process.cwd(), 'processed_dynmap');
function exists(p){ try { fs.accessSync(p); return true; } catch { return false; } }
function todayName(){ const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
if (!exists(OUT)) fs.mkdirSync(OUT,{recursive:true});
fs.writeFileSync(path.join(OUT,'sample1.json'), JSON.stringify([{player:'t',x:1,z:2}]))
fs.writeFileSync(path.join(OUT,'sample2.json'), JSON.stringify([{player:'u',x:3,z:4}]))
const res = spawnSync(process.execPath, ['sigma.js','compress-now'], {stdio:'inherit'});
const fname = `${todayName()}_compressed.json`;
const fpath = path.join(OUT, fname);
assert.ok(exists(fpath));
const js = JSON.parse(fs.readFileSync(fpath,'utf8'));
assert.ok(Array.isArray(js.data));
assert.ok(js.meta && js.meta.originalFileCount>=1);
const idx = JSON.parse(fs.readFileSync(path.join(OUT,'index.json'),'utf8'));
assert.ok(Array.isArray(idx.files));
assert.ok(idx.files.includes(fname));
process.exit(0);
