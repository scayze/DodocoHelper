import { readFileSync } from "node:fs";
import pkg from "pngjs";
const { PNG } = pkg;
import { debugExtract } from "../dist/src/lib/extract.js";
const name = process.argv[2] || "image56.png";
const p = PNG.sync.read(readFileSync("test_fixtures/"+name));
const { result, debug } = debugExtract(new Uint8ClampedArray(p.data), p.width, p.height);
console.log(name, "best n=", debug.best?.n);
if (debug.best) {
  const b = debug.best;
  for (let r=0;r<b.n;r++){let row="";for(let c=0;c<b.n;c++){const i=r*b.n+c;row+=b.assign[i].toString(16);}console.log(row);}
  console.log("labs:");
  for (let r=0;r<b.n;r++){let row=[];for(let c=0;c<b.n;c++){const i=r*b.n+c;row.push(b.lab[i].map(v=>Math.round(v)).join(","));}console.log(row.join(" | "));}
  console.log("quads:", debug.hypos.map(h=>h.quad.map(q=>Math.round(q.x)+","+Math.round(q.y)).join(" ")).join(" || "));
}
