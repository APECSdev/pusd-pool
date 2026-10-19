// eval-pool.mjs — evaluate the PUSD pool covenant as the 6th input of the
// combined shielded-pool transaction on the BCH 2026 VM.
//
// The transaction = the densless-msm verifier's 5 intra-tx inputs (untouched)
//                 + this pool covenant as input index 5 (token-threading mode).
// The pool covenant reads the proven merkleRoot (n0) from the verifier genesis
// sibling (input 3) witness at byte offset 1824 and enforces the pool transition.
//
// Usage: node eval-pool.mjs vectors.json poolArtifact.json
import { readFileSync } from 'node:fs';
import {
  createVirtualMachineBch, encodeDataPush, bigIntToVmNumber,
  decodeAuthenticationInstructions, encodeAuthenticationInstruction,
  sha256,
} from '@bitauth/libauth';

const [, , vectorsPath, artifactPath] = process.argv;
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

// ── pool constants ────────────────────────────────────────────────────────────
const PUSD_CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const VERIFIER_INPUT_INDEX = 3n;   // genesis step
const N0_OFFSET = 1824n;           // byte offset of n0 (merkleRoot) in genesis unlocking

// ── build the pool covenant locking bytecode (P2SH32 of the compiled contract) ──
// constructor: (bytes32 assetCategory, int verifierInputIndex)
// CashScript P2SH32 locking = OP_HASH256 <32-byte script hash> OP_EQUAL; the redeem
// script = constructor args (encoded) + contract bytecode. For the benchmark we
// evaluate the contract bytecode directly as the "locking" program with the
// constructor args + function args as the witness (the harness Step model).
const contractBytecode = Buffer.from(artifact.debug.bytecode, 'hex');

// witness for spend(nf0, nf1, newMerkleRoot, publicValueAbs, isUnshield):
// constructor args are pushed first (they're part of the redeem in real P2SH, but
// the harness Step model evaluates locking=contractBytecode with the full witness).
const nf0 = Buffer.alloc(32, 0x11);
const nf1 = Buffer.alloc(32, 0x22);

// read the proven merkleRoot (n0) from the verifier genesis witness (LE byte form)
const genesisUnlocking = Buffer.from(vectors.steps[VERIFIER_INPUT_INDEX].unlocking, 'hex');
const provenRoot = genesisUnlocking.subarray(Number(N0_OFFSET), Number(N0_OFFSET) + 32);

// current pool state: stored root == provenRoot (so the root binding passes);
// nullifierSetHash = 32 zero bytes (genesis state); balance = 1000 PUSD.
const storedRoot = provenRoot;                       // LE byte form, matches n0 push
const oldNullifierHash = Buffer.alloc(32, 0);
const currentBalance = 1000n;
const inCommitment = Buffer.concat([storedRoot, oldNullifierHash]);

// the transition: a TRANSFER (publicValueAbs=0, isUnshield=0) that appends two
// notes, advancing the root to newMerkleRoot and folding nf0/nf1.
const newMerkleRoot = Buffer.alloc(32, 0x33);        // LE byte form of the new root
const publicValueAbs = 0n;
const isUnshield = 0n;
const newNullifierHash = Buffer.from(sha256.hash(Buffer.concat([oldNullifierHash, nf0, nf1])));
const outCommitment = Buffer.concat([newMerkleRoot, newNullifierHash]);
const newBalance = currentBalance + publicValueAbs - 2n * isUnshield * publicValueAbs;

// encode the covenant witness: constructor args then function args (push order:
// cashscript pushes function args then constructor args are appended in the redeem;
// for direct evaluation we push constructor args first, then function args, matching
// the stack order the compiled bytecode expects: [..fnArgs, ..ctorArgs] with ctor on top).
const push = (bytes) => Buffer.from(encodeDataPush(bytes));
const num = (n) => Buffer.from(encodeDataPush(bigIntToVmNumber(n)));
const unlocking = Buffer.concat([
  // function args (in ABI order)
  push(nf0), push(nf1), push(newMerkleRoot), num(publicValueAbs), num(isUnshield),
  // constructor args (appended; the compiled code OP_PICKs them from below)
  push(Buffer.from(PUSD_CATEGORY, 'hex')), num(VERIFIER_INPUT_INDEX),
]);

// ── build the full 6-input transaction ───────────────────────────────────────
const category = Buffer.from(PUSD_CATEGORY, 'hex');
const mkToken = (capability, commitment, amount) => ({
  amount, category, nft: { capability, commitment },
});

// the 5 verifier inputs (intra-tx) + the pool covenant input (index 5)
const verifierInputs = vectors.steps.map((s, n) => ({
  outpointTransactionHash: new Uint8Array(32),
  outpointIndex: n,
  sequenceNumber: 0,
  unlockingBytecode: Buffer.from(s.unlocking, 'hex'),
}));
const poolInput = {
  outpointTransactionHash: new Uint8Array(32),
  outpointIndex: 5,
  sequenceNumber: 0,
  unlockingBytecode: unlocking,
};
const allInputs = [...verifierInputs, poolInput];

// source outputs: verifier inputs are plain P2SH32; the pool input carries the NFT
const sourceOutputs = [
  ...vectors.steps.map((s) => ({ lockingBytecode: Buffer.from(s.locking, 'hex'), valueSatoshis: 1000n })),
  { lockingBytecode: contractBytecode, valueSatoshis: 1000n, token: mkToken('mutable', inCommitment, currentBalance) },
];

// outputs: output 0 = the perpetuated pool (new state + new balance, same locking)
const outputs = [
  { lockingBytecode: contractBytecode, valueSatoshis: 1000n, token: mkToken('mutable', outCommitment, newBalance) },
];

const program = {
  inputIndex: 5, // evaluate the POOL covenant input
  sourceOutputs,
  transaction: { version: 2, inputs: allInputs, outputs, locktime: 0 },
};

// ── evaluate on the BCH 2026 VM ───────────────────────────────────────────────
const vm = createVirtualMachineBch();
const state = vm.evaluate(program);
const top = state.stack[state.stack.length - 1];
const accepted = state.error === undefined && state.stack.length === 1 &&
  top !== undefined && top.length === 1 && top[0] === 1;

console.log(JSON.stringify({
  accepted,
  error: state.error ?? null,
  stackDepth: state.stack.length,
  poolUnlockingBytes: unlocking.length,
  poolBytecodeBytes: contractBytecode.length,
  metrics: state.metrics ?? null,
}, null, 2));
process.exit(accepted ? 0 : 1);
