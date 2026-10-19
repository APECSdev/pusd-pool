// Generate densless-msm public-fixtures.json from OUR PUSD VK + 5 distinct real proofs.
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "node:crypto";

// Option F actionHash: SHA256(nf0|nf1|cm0|cm1|publicValueAbs|publicValueSign|assetCategory|
// newMerkleRoot), each field a 32-byte BIG-ENDIAN encoding, truncated to 254 bits (top 2 bits
// of the BE hash cleared) so it fits the BN254 scalar field. This MUST match the circuit's
// FieldToBE256 + Sha256(2048) + Bits2Num(253) truncation exactly (verified bit-for-bit).
const be32 = (bi) => { const b = Buffer.alloc(32, 0); let x = BigInt(bi); for (let i = 31; i >= 0 && x > 0n; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
function actionHashSHA256(nf0, nf1, cm0, cm1, pvAbs, pvSign, category, newRoot) {
  const preimage = Buffer.concat([be32(nf0), be32(nf1), be32(cm0), be32(cm1), be32(pvAbs), be32(pvSign), be32(category), be32(newRoot)]);
  const h = createHash("sha256").update(preimage).digest();
  h[0] &= 0x1f; // truncate to 253 bits (clear top 3 bits => always < BN254 prime p, no mod-p reduction)
  return BigInt("0x" + h.toString("hex"));
}

const TREE_DEPTH = 20;
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (...xs) => F.toObject(poseidon(xs));
const commit=(v,o,rho,r)=>H(v,o,rho,r), nullifier=(nk,rho)=>H(nk,rho);
const zeros=[0n]; for(let d=1;d<=TREE_DEPTH;d++) zeros.push(H(zeros[d-1],zeros[d-1]));
function merklePath(leaves,index){const pe=[],pb=[];let idx=index,cur=new Map(leaves.map((v,i)=>[i,v]));
  for(let d=0;d<TREE_DEPTH;d++){const s=idx%2===0?idx+1:idx-1;pe.push(cur.get(s)??zeros[d]);pb.push(idx%2);
    const nx=new Map(),ks=new Set([...cur.keys()].map(k=>k>>1));ks.add(idx>>1);
    for(const k of ks){nx.set(k,H(cur.get(2*k)??zeros[d],cur.get(2*k+1)??zeros[d]));}cur=nx;idx>>=1;}
  return{pathElements:pe,pathBits:pb,root:cur.get(0)??zeros[TREE_DEPTH]};}

const assetCategory=0x2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544n;

// Build one TRANSFER fixture from a seed (varies notes -> distinct proof + public inputs).
async function makeFixture(seed) {
  const ownerPub=111n+seed, nk0=222n+seed, nk1=333n+seed;
  const v0=60n+seed, v1=40n;
  const in0={value:v0,ownerPub,rho:1001n+seed,r:5001n+seed}, in1={value:v1,ownerPub,rho:1002n+seed,r:5002n+seed};
  const c0=commit(in0.value,ownerPub,in0.rho,in0.r), c1=commit(in1.value,ownerPub,in1.rho,in1.r);
  const p0=merklePath([c0,c1],0), p1=merklePath([c0,c1],1), merkleRoot=p0.root;
  const o0=v0+ v1-30n, o1=30n; // conserve
  const out0={value:o0,ownerPub:444n+seed,rho:2001n+seed,r:6001n+seed}, out1={value:o1,ownerPub:555n+seed,rho:2002n+seed,r:6002n+seed};
  const cm0=commit(out0.value,out0.ownerPub,out0.rho,out0.r), cm1=commit(out1.value,out1.ownerPub,out1.rho,out1.r);
  const nf0=nullifier(nk0,in0.rho), nf1=nullifier(nk1,in1.rho);
  const publicValueAbs=0n, publicValueSign=0n;
  // newMerkleRoot = the root after appending the two new commitments cm0, cm1 to the tree.
  const newMerkleRoot=merklePath([c0,c1,cm0,cm1],0).root;
  const actionHash=actionHashSHA256(nf0,nf1,cm0,cm1,publicValueAbs,publicValueSign,assetCategory,newMerkleRoot);
  const input={merkleRoot:merkleRoot.toString(),actionHash:actionHash.toString(),
    nf:[nf0.toString(),nf1.toString()],cm:[cm0.toString(),cm1.toString()],
    publicValueAbs:publicValueAbs.toString(),publicValueSign:publicValueSign.toString(),assetCategory:assetCategory.toString(),
    newMerkleRoot:newMerkleRoot.toString(),
    inValue:[in0.value.toString(),in1.value.toString()],inOwnerPub:[ownerPub.toString(),ownerPub.toString()],
    inRho:[in0.rho.toString(),in1.rho.toString()],inR:[in0.r.toString(),in1.r.toString()],nk:[nk0.toString(),nk1.toString()],
    inPathElements:[p0.pathElements.map(String),p1.pathElements.map(String)],inPathBits:[p0.pathBits.map(String),p1.pathBits.map(String)],
    outValue:[out0.value.toString(),out1.value.toString()],outOwnerPub:[out0.ownerPub.toString(),out1.ownerPub.toString()],
    outRho:[out0.rho.toString(),out1.rho.toString()],outR:[out0.r.toString(),out1.r.toString()]};
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input,"build/pool_js/pool.wasm","build/pool_final.zkey");
  return { proof, publicSignals };
}

const vk = JSON.parse(readFileSync("build/verification_key.json","utf8"));
const g1=(p)=>({x:p[0],y:p[1]});
const g2=(p)=>({x:{c0:p[0][0],c1:p[0][1]},y:{c0:p[1][0],c1:p[1][1]}}); // snarkjs G2 = [[x_c0,x_c1],[y_c0,y_c1]] (real-first)

const fixtures=[];
for (let s=0n; s<5n; s++) {
  const { proof, publicSignals } = await makeFixture(s);
  if (!(await snarkjs.groth16.verify(vk,publicSignals,proof))) throw new Error("fixture "+s+" self-verify failed");
  fixtures.push({ fixture:Number(s), publicInputs: publicSignals,
    proof:{ a:g1(proof.pi_a), b:g2(proof.pi_b), c:g1(proof.pi_c) } });
  console.log("fixture", s.toString(), "ok, root:", publicSignals[0].slice(0,16)+"...");
}

const out={
  artifactSha256:"pusd-pool-option2",
  vk:{ alpha:g1(vk.vk_alpha_1), beta:g2(vk.vk_beta_2), gamma:g2(vk.vk_gamma_2), delta:g2(vk.vk_delta_2), ic: vk.IC.map(g1) },
  fixtures,
  provenance:"nito pusd-pool (Option 2: 2 public inputs = [merkleRoot, actionHash]); 5 distinct TRANSFER proofs",
  mapping:"Genesis public inputs pushes 37,36; A=(header2,-header3), B=header8..11, C=header6..7. Public MSM reproduces header4/5 for every fixture."
};
writeFileSync("build/pusd-public-fixtures.json", JSON.stringify(out,null,2));
console.log("wrote build/pusd-public-fixtures.json with", fixtures.length, "fixtures, ic.length", out.vk.ic.length);
process.exit(0); // snarkjs keeps the event loop alive; force a clean exit after writing.
