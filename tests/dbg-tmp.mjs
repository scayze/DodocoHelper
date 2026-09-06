import { readFileSync } from "node:fs";
import pkg from "pngjs";
const { PNG } = pkg;
import { debugExtract } from "../dist/src/lib/extract.js";
for (const name of ["image10.png","image56.png","image.png","image241.png"]) {
  const buf = readFileSync("test_fixtures/"+name);
  const p = PNG.sync.read(buf);
  const data = new Uint8ClampedArray(p.data);
  const { result, debug } = debugExtract(data, p.width, p.height);
  console.log("==="+name, p.width+"x"+p.height, "ok="+result.ok, "n="+result.boardSize, "err="+result.error);
  for (const h of debug.hypos) console.log("  area="+Math.round(h.area),"strict="+h.strict, h.grid?("n="+h.grid.n+" score="+h.grid.score.toFixed(2)+" v="+h.grid.v.join(",")+" h="+h.grid.h.join(",")) : ("FAIL "+h.gridError));
  if (debug.best) { console.log("  best v pitch:", debug.best.v.map((v,i,a)=>i? v-a[i-1]:0).join(",")); }
}
