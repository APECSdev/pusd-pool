// circuits/note.circom
//
// PUSD shielded pool — note primitives (BN254 scalar field, Poseidon hashes).
//
// A note commits to:  C = Poseidon(value, ownerPub, rho, r)
// Its nullifier is:   nf = Poseidon(nk, rho)          (nk = nullifier key)
//
// All arithmetic is in the BN254 Fr scalar field. Values are constrained to
// [0, MAX] by the caller via range checks. Poseidon is SNARK-friendly and is
// safe here because the ON-CHAIN side only verifies the Groth16 proof — it
// never re-hashes the tree.

pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Note commitment: Poseidon(value, ownerPub, rho, r)  (4-to-1 Poseidon)
template NoteCommitment() {
    signal input value;     // note value (PUSD base units), range-checked by caller
    signal input ownerPub;  // owner public key (Fr element, x-coord of BabyJub pk)
    signal input rho;       // note uniqueness seed (random)
    signal input r;         // commitment randomness (blinding)
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== value;
    h.inputs[1] <== ownerPub;
    h.inputs[2] <== rho;
    h.inputs[3] <== r;
    out <== h.out;
}

// Nullifier: Poseidon(nk, rho)  — deterministic per (spending key, note),
// so the same note always yields the same nullifier -> double-spend is caught.
template Nullifier() {
    signal input nk;    // nullifier (spending) key, private
    signal input rho;   // the note's rho
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== nk;
    h.inputs[1] <== rho;
    out <== h.out;
}

// Merkle membership proof: recompute the root from (leaf, pathElements, pathBits)
// using Poseidon(a, b) at each level. pathBits selects left/right ordering.
// TREE_DEPTH is a compile-time constant; smaller = cheaper. 20 levels ~ 1M notes.
template MerkleProof(TREE_DEPTH) {
    signal input leaf;
    signal input pathElements[TREE_DEPTH];
    signal input pathBits[TREE_DEPTH];   // 0: leaf is left child, 1: right child
    signal output root;

    component hash[TREE_DEPTH];
    component mux[TREE_DEPTH];
    signal level[TREE_DEPTH + 1];
    level[0] <== leaf;

    for (var i = 0; i < TREE_DEPTH; i++) {
        // pathBits[i] must be boolean
        pathBits[i] * (pathBits[i] - 1) === 0;

        mux[i] = Mux1();
        mux[i].c[0] <== level[i];          // when bit=0: (level, sibling)
        mux[i].c[1] <== pathElements[i];   // when bit=1: (sibling, level)
        mux[i].s <== pathBits[i];

        hash[i] = Poseidon(2);
        hash[i].inputs[0] <== mux[i].out;            // left
        // right = sibling when bit=0, level when bit=1
        hash[i].inputs[1] <== pathElements[i] + level[i] - mux[i].out;

        level[i + 1] <== hash[i].out;
    }
    root <== level[TREE_DEPTH];
}

// Range check: 0 <= in <= MAX, where MAX = 2^BITS - 1. Uses Num2Bits to force
// the value to fit in BITS bits (sound because Fr is ~254 bits > BITS).
template RangeCheck(BITS) {
    signal input in;
    component n2b = Num2Bits(BITS);
    n2b.in <== in;   // constrains in < 2^BITS, i.e. in-range and non-negative
}
