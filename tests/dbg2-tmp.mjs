import { readFileSync } from "node:fs";
import pkg from "pngjs";
const { PNG } = pkg;
import { extractFromPixels } from "../dist/src/lib/extract.js";
function canon(g){const m=new Map();let n=0;return g.map(r=>r.map(v=>{if(!m.has(v))m.set(v,n++);return m.get(v);}));}
for (const name of ["image.png","image241.png","image56.png","image10.png"]) {
  const p = PNG.sync.read(readFileSync("test_fixtures/"+name));
  const res = extractFromPixels(new Uint8ClampedArray(p.data), p.width, p.height);
  const exp = JSON.parse(readFileSync("test_fixtures/"+name.replace(".png",".expected.json"),"utf8"));
  console.log("==="+name+" got n="+res.boardSize+" exp n="+exp.size);
  if(!res.puzzle) continue;
  const a=canon(res.puzzle.regions), b=canon(exp.regions);
  for(let r=0;r<Math.max(a.length,b.length);r++){
    const ar=a[r]?a[r].join(""):"-", br=b[r]?b[r].join(""):"-";
    console.log(" got "+ar+" | exp "+br+(ar===br?"":"  <== DIFF"));
  }
}
