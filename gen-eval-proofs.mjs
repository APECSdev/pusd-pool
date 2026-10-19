// Generate one proof per eval scenario (transfer/shield/unshield), each with covenant
// args whose SHA256 actionHash == the proof's n1. Writes eval-proofs.json.
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { writeFileSync } from "fs";
import { createHash } from "node:crypto";

const be32 = (bi) => { const b = Buffer.alloc(32, 0); let x = BigInt(bi); for (let i = 31; i >= 0 && x > 0n; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
function actionHashSHA256(nf0,nf1,cm0,cm1,pvAbs,pvSign,category,newRoot){
  const pre=Buffer.concat([be32(nf0),be32(nf1),be32(cm0),be32(cm1),be32(pvAbs),be32(pvSign),be32(category),be32(newRoot)]);
  const h=createHash("sha256").update(pre).digest(); h[0]&=0x1f; return BigInt("0x"+h.toString("hex"));
}
function bigIntToVmNumber(value){let v=BigInt(value);if(v===0n)return new Uint8Array(0);const neg=v<0n;if(neg)v=-v;const b=[];while(v>0n){b.push(Number(v&0xffn));v>>=8n;}if(b[b.length-1]&0x80)b.push(neg?0x80:0);else if(neg)b[b.length-1]|=0x80;return Uint8Array.from(b);}

const TREE_DEPTH=20;
const poseidon=await buildPoseidon(); const F=poseidon.F;
const H=(...xs)=>F.toObject(poseidon(xs));
const commit=(v,o,rho,r)=>H(v,o,rho,r), nullifier=(nk,rho)=>H(nk,rho);
const zeros=[0n]; for(let d=1;d<=TREE_DEPTH;d++) zeros.push(H(zeros[d-1],zeros[d-1]));
function merklePath(leaves,index){const pe=[],pb=[];let idx=index,cur=new Map(leaves.map((v,i)=>[i,v]));
  for(let d=0;d<TREE_DEPTH;d++){const s=idx%2===0?idx+1:idx-1;pe.push(cur.get(s)??zeros[d]);pb.push(idx%2);
    const nx=new Map(),ks=new Set([...cur.keys()].map(k=>k>>1));ks.add(idx>>1);
    for(const k of ks){nx.set(k,H(cur.get(2*k)??zeros[d],cur.get(2*k+1)??zeros[d]));}cur=nx;idx>>=1;}
  return{pathElements:pe,pathBits:pb,root:cur.get(0)??zeros[TREE_DEPTH]};}

const assetCategory=0x2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544n;
const ownerPub=111n,nk0=222n,nk1=333n;

// Each scenario: in0,in1 values; out0,out1 values; publicValueAbs; publicValueSign.
// Constraint: in0+in1 + (sign? -pv : +pv) == out0+out1.
const scenarios=[
  { label:"transfer", inV:[60n,40n], outV:[70n,30n], pvAbs:0n, pvSign:0n },
  { label:"shield",   inV:[60n,40n], outV:[200n,150n], pvAbs:250n, pvSign:0n },
  { label:"unshield", inV:[300n,200n], outV:[60n,40n], pvAbs:400n, pvSign:1n },
];

const results=[];
for (const sc of scenarios){
  const in0={value:sc.inV[0],ownerPub,rho:1001n,r:5001n},in1={value:sc.inV[1],ownerPub,rho:1002n,r:5002n};
  const c0=commit(in0.value,ownerPub,in0.rho,in0.r),c1=commit(in1.value,ownerPub,in1.rho,in1.r);
  const p0=merklePath([c0,c1],0),p1=merklePath([c0,c1],1),merkleRoot=p0.root;
  const out0={value:sc.outV[0],ownerPub:444n,rho:2001n,r:6001n},out1={value:sc.outV[1],ownerPub:555n,rho:2002n,r:6002n};
  const cm0=commit(out0.value,out0.ownerPub,out0.rho,out0.r),cm1=commit(out1.value,out1.ownerPub,out1.rho,out1.r);
  const nf0=nullifier(nk0,in0.rho),nf1=nullifier(nk1,in1.rho);
  const newMerkleRoot=merklePath([c0,c1,cm0,cm1],0).root;
  const actionHash=actionHashSHA256(nf0,nf1,cm0,cm1,sc.pvAbs,sc.pvSign,assetCategory,newMerkleRoot);
  const input={merkleRoot:merkleRoot.toString(),actionHash:actionHash.toString(),
    nf:[nf0.toString(),nf1.toString()],cm:[cm0.toString(),cm1.toString()],
    publicValueAbs:sc.pvAbs.toString(),publicValueSign:sc.pvSign.toString(),assetCategory:assetCategory.toString(),
    newMerkleRoot:newMerkleRoot.toString(),
    inValue:[in0.value.toString(),in1.value.toString()],inOwnerPub:[ownerPub.toString(),ownerPub.toString()],
    inRho:[in0.rho.toString(),in1.rho.toString()],inR:[in0.r.toString(),in1.r.toString()],nk:[nk0.toString(),nk1.toString()],
    inPathElements:[p0.pathElements.map(String),p1.pathElements.map(String)],inPathBits:[p0.pathBits.map(String),p1.pathBits.map(String)],
    outValue:[out0.value.toString(),out1.value.toString()],outOwnerPub:[out0.ownerPub.toString(),out1.ownerPub.toString()],
    outRho:[out0.rho.toString(),out1.rho.toString()],outR:[out0.r.toString(),out1.r.toString()]};
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input,"build/pool_js/pool.wasm","build/pool_final.zkey");
  // covenant args (LE VM-number byte form) that hash to n1:
  const cov={
    nf0:Buffer.from(bigIntToVmNumber(nf0)).toString("hex"), nf1:Buffer.from(bigIntToVmNumber(nf1)).toString("hex"),
    cm0:Buffer.from(bigIntToVmNumber(cm0)).toString("hex"), cm1:Buffer.from(bigIntToVmNumber(cm1)).toString("hex"),
    newMerkleRoot:Buffer.from(bigIntToVmNumber(newMerkleRoot)).toString("hex"),
    publicValueAbs:sc.pvAbs.toString(), isUnshield:sc.pvSign.toString(),
  };
  results.push({ label:sc.label, proof, publicSignals, covenant:cov });
  console.log(sc.label, "proved. n1:", publicSignals[1].slice(0,20), "pvAbs:", sc.pvAbs.toString(), "sign:", sc.pvSign.toString());
}
writeFileSync("build/eval-proofs.json", JSON.stringify(results,null,2));
console.log("wrote build/eval-proofs.json with", results.length, "scenario proofs");
process.exit(0);
