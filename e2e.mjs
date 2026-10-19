// End-to-end (Option 2): 2 public inputs [merkleRoot, actionHash].
// Build a valid 2-in/2-out TRANSFER witness, prove, verify; then negative tests.
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { readFileSync } from "fs";

const TREE_DEPTH = 20;
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (...xs) => F.toObject(poseidon(xs));

const commit = (value, ownerPub, rho, r) => H(value, ownerPub, rho, r);
const nullifier = (nk, rho) => H(nk, rho);

const zeros = [0n];
for (let d = 1; d <= TREE_DEPTH; d++) zeros.push(H(zeros[d-1], zeros[d-1]));

function merklePath(leaves, index) {
  const pathElements = [], pathBits = [];
  let idx = index;
  let cur = new Map(leaves.map((v,i)=>[i,v]));
  for (let d = 0; d < TREE_DEPTH; d++) {
    const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    pathElements.push(cur.get(sibIdx) ?? zeros[d]);
    pathBits.push(idx % 2);
    const next = new Map();
    const keys = new Set([...cur.keys()].map(k => k >> 1));
    keys.add(idx >> 1);
    for (const k of keys) {
      const l = cur.get(2*k) ?? zeros[d];
      const r = cur.get(2*k+1) ?? zeros[d];
      next.set(k, H(l, r));
    }
    cur = next;
    idx = idx >> 1;
  }
  const root = cur.get(0) ?? zeros[TREE_DEPTH];
  return { pathElements, pathBits, root };
}

// --- two input notes (owned by us) ---
const ownerPub = 111n, nk0 = 222n, nk1 = 333n;
const in0 = { value: 60n, ownerPub, rho: 1001n, r: 5001n };
const in1 = { value: 40n, ownerPub, rho: 1002n, r: 5002n };
const c0 = commit(in0.value, in0.ownerPub, in0.rho, in0.r);
const c1 = commit(in1.value, in1.ownerPub, in1.rho, in1.r);

const leaves = [c0, c1];
const p0 = merklePath(leaves, 0);
const p1 = merklePath(leaves, 1);
if (p0.root !== p1.root) throw new Error("root mismatch");
const merkleRoot = p0.root;

// --- TRANSFER: 100 in -> 70 + 30 out, publicValue = 0 ---
const out0 = { value: 70n, ownerPub: 444n, rho: 2001n, r: 6001n };
const out1 = { value: 30n, ownerPub: 555n, rho: 2002n, r: 6002n };
const cm0 = commit(out0.value, out0.ownerPub, out0.rho, out0.r);
const cm1 = commit(out1.value, out1.ownerPub, out1.rho, out1.r);

const nf0 = nullifier(nk0, in0.rho);
const nf1 = nullifier(nk1, in1.rho);

const assetCategory = 0x2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544n;
const publicValueAbs = 0n, publicValueSign = 0n;

// actionHash = Poseidon(nf0, nf1, cm0, cm1, publicValueAbs, publicValueSign, assetCategory)
const actionHash = H(nf0, nf1, cm0, cm1, publicValueAbs, publicValueSign, assetCategory);

const input = {
  // public
  merkleRoot: merkleRoot.toString(),
  actionHash: actionHash.toString(),
  // packed (private) values
  nf: [nf0.toString(), nf1.toString()],
  cm: [cm0.toString(), cm1.toString()],
  publicValueAbs: publicValueAbs.toString(),
  publicValueSign: publicValueSign.toString(),
  assetCategory: assetCategory.toString(),
  // input notes
  inValue: [in0.value.toString(), in1.value.toString()],
  inOwnerPub: [in0.ownerPub.toString(), in1.ownerPub.toString()],
  inRho: [in0.rho.toString(), in1.rho.toString()],
  inR: [in0.r.toString(), in1.r.toString()],
  nk: [nk0.toString(), nk1.toString()],
  inPathElements: [p0.pathElements.map(x=>x.toString()), p1.pathElements.map(x=>x.toString())],
  inPathBits: [p0.pathBits.map(String), p1.pathBits.map(String)],
  // output notes
  outValue: [out0.value.toString(), out1.value.toString()],
  outOwnerPub: [out0.ownerPub.toString(), out1.ownerPub.toString()],
  outRho: [out0.rho.toString(), out1.rho.toString()],
  outR: [out0.r.toString(), out1.r.toString()],
};

console.log("merkleRoot =", merkleRoot.toString().slice(0,20)+"...");
console.log("actionHash =", actionHash.toString().slice(0,20)+"...");

const wasm = "build/pool_js/pool.wasm";
const zkey = "build/pool_final.zkey";
const vk = JSON.parse(readFileSync("build/verification_key.json","utf8"));

console.time("fullProve");
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
console.timeEnd("fullProve");
console.log("publicSignals (should be 2):", publicSignals.length, publicSignals.map(s=>s.slice(0,16)+"..."));

console.time("verify");
const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
console.timeEnd("verify");
console.log("VERIFY_RESULT:", ok ? "VALID ✓" : "INVALID ✗");

// negative test 1: tamper merkleRoot (pub[0]) -> must FAIL
const t0 = [...publicSignals]; t0[0] = (BigInt(t0[0]) + 1n).toString();
console.log("TAMPER_ROOT:", (await snarkjs.groth16.verify(vk, t0, proof)) ? "ACCEPTED (BAD!)" : "REJECTED ✓");

// negative test 2: tamper actionHash (pub[1]) -> must FAIL
const t1 = [...publicSignals]; t1[1] = (BigInt(t1[1]) + 1n).toString();
console.log("TAMPER_ACTIONHASH:", (await snarkjs.groth16.verify(vk, t1, proof)) ? "ACCEPTED (BAD!)" : "REJECTED ✓");

// negative test 3: a DIFFERENT valid-looking actionHash (recompute over different nf) -> must FAIL
const fakeNf0 = nullifier(999n, in0.rho);
const fakeAction = H(fakeNf0, nf1, cm0, cm1, publicValueAbs, publicValueSign, assetCategory);
const t2 = [...publicSignals]; t2[1] = fakeAction.toString();
console.log("FORGED_ACTIONHASH:", (await snarkjs.groth16.verify(vk, t2, proof)) ? "ACCEPTED (BAD!)" : "REJECTED ✓");

const pass = ok && publicSignals.length === 2;
console.log(pass ? "E2E PASS (2 public inputs)" : "E2E FAIL");
process.exit(pass ? 0 : 1);
