// circuits/pool.circom
//
// PUSD shielded pool — main joinsplit circuit (2 inputs, 2 outputs), BN254.
// One circuit serves SHIELD / TRANSFER / UNSHIELD by varying `publicValue`
// and padding unused note slots with zero-value dummy notes.
//
//   value conservation:  sumIn + publicValue == sumOut
//     SHIELD   : publicValue = +deposit  (sumIn=0 dummy notes, sumOut=deposit)
//                -> deposit enters pool; the covenant receives the public PUSD.
//     TRANSFER : publicValue = 0         (sumIn == sumOut, all inside pool)
//     UNSHIELD : publicValue = -withdraw (sumIn=withdraw, sumOut=0 dummy notes)
//                -> the covenant pays out the public PUSD.
//
// `publicValue` is encoded via `publicValueAbs` + `publicValueSign`
// (0 = shield/transfer, 1 = unshield); the circuit range-checks |publicValue|.
//
// PUBLIC-INPUT PACKING (Option 2): the on-chain densless-msm Groth16 verifier is
// hardcoded to exactly TWO public scalars (vk_x = IC0 + n0*IC1 + n1*IC2). To keep
// that battle-tested, red-team-hardened verifier UNCHANGED, this circuit exposes
// exactly TWO public inputs and binds all other logical values into the second:
//
//   pub[0] = merkleRoot   — the pool note-tree root. The covenant checks this
//                           against its stored state, so it MUST be a real public
//                           input (not just hashed).
//   pub[1] = actionHash   — Poseidon(nf0, nf1, cm0, cm1, publicValueAbs,
//                           publicValueSign, assetCategory). The covenant
//                           recomputes this same hash from the values it
//                           independently enforces (nullifier-set updates, new
//                           commitments, token balance delta, asset category) and
//                           requires the proof's pub[1] to match. The circuit
//                           constrains every packed value internally, so a valid
//                           proof binds all of them.
//
// => N_pub = 2  =>  on-chain MSM ic.length = 3  =>  2-scalar MSM (densless-msm as-is).

pragma circom 2.1.6;

include "./note.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/sha256/sha256.circom";

// FieldToBE256: convert a field element (< 2^254) to 256 BIG-ENDIAN bits, the
// bit order SHA256 expects (in[0] = MSB of byte 0). Num2Bits yields little-endian
// bits (out[i] = bit i, LSB-first), so we reverse: BE position p (0 = MSB) maps to
// value bit (255 - p); the top 2 value bits (254, 255) are always 0 because the
// field element is < 2^254. Verified bit-for-bit against the JS sha256 of the
// 32-byte big-endian encoding.
template FieldToBE256() {
    signal input in;
    signal output out[256];
    component n2b = Num2Bits(254);
    n2b.in <== in;
    for (var p = 0; p < 256; p++) {
        var valBit = 255 - p;
        if (valBit >= 254) {
            out[p] <== 0;
        } else {
            out[p] <== n2b.out[valBit];
        }
    }
}

template Pool(TREE_DEPTH, VALUE_BITS) {
    // ---- public inputs (EXACTLY TWO — the on-chain verifier contract) ----
    signal input merkleRoot;
    signal input actionHash;

    // ---- private witnesses: the values packed into actionHash ----
    signal input nf[2];                 // input-note nullifiers (anti-double-spend)
    signal input cm[2];                 // output-note commitments (recorded on-chain)
    signal input publicValueAbs;        // |public PUSD moved| (shield=+, unshield=|−|)
    signal input publicValueSign;       // 0 => publicValue flows IN (shield/transfer); 1 => OUT (unshield)
    signal input assetCategory;         // PUSD CashToken category (binds proof to the asset)
    signal input newMerkleRoot;         // note-tree root after appending cm0, cm1 (bound via actionHash)

    // ---- private witnesses: input notes ----
    signal input inValue[2];
    signal input inOwnerPub[2];
    signal input inRho[2];
    signal input inR[2];
    signal input nk[2];                 // per-input nullifier (spending) key
    signal input inPathElements[2][TREE_DEPTH];
    signal input inPathBits[2][TREE_DEPTH];

    // ---- private witnesses: output notes ----
    signal input outValue[2];
    signal input outOwnerPub[2];        // recipient public key (may differ from sender)
    signal input outRho[2];
    signal input outR[2];

    // ---------- input notes: commitment + membership + nullifier + range ----------
    component inCommit[2];
    component inMerkle[2];
    component inNf[2];
    component inRange[2];
    for (var i = 0; i < 2; i++) {
        inRange[i] = RangeCheck(VALUE_BITS);
        inRange[i].in <== inValue[i];

        inCommit[i] = NoteCommitment();
        inCommit[i].value    <== inValue[i];
        inCommit[i].ownerPub <== inOwnerPub[i];
        inCommit[i].rho      <== inRho[i];
        inCommit[i].r        <== inR[i];

        // Membership (dummy zero-value notes still must sit in the tree OR be
        // gated; here we require membership for BOTH — caller inserts dummies).
        inMerkle[i] = MerkleProof(TREE_DEPTH);
        inMerkle[i].leaf <== inCommit[i].out;
        for (var d = 0; d < TREE_DEPTH; d++) {
            inMerkle[i].pathElements[d] <== inPathElements[i][d];
            inMerkle[i].pathBits[d]     <== inPathBits[i][d];
        }
        // Both input roots must equal the SAME public root.
        inMerkle[i].root === merkleRoot;

        inNf[i] = Nullifier();
        inNf[i].nk  <== nk[i];
        inNf[i].rho <== inRho[i];
        inNf[i].out === nf[i];          // pin to the (packed) nullifier
    }

    // ---------- output notes: commitment + range ----------
    component outCommit[2];
    component outRange[2];
    for (var j = 0; j < 2; j++) {
        outRange[j] = RangeCheck(VALUE_BITS);
        outRange[j].in <== outValue[j];

        outCommit[j] = NoteCommitment();
        outCommit[j].value    <== outValue[j];
        outCommit[j].ownerPub <== outOwnerPub[j];
        outCommit[j].rho      <== outRho[j];
        outCommit[j].r        <== outR[j];

        outCommit[j].out === cm[j];     // pin to the (packed) commitment
    }

    // ---------- public value: range + sign ----------
    publicValueSign * (publicValueSign - 1) === 0;   // boolean
    component pvRange = RangeCheck(VALUE_BITS);
    pvRange.in <== publicValueAbs;

    // ---------- value conservation ----------
    // signedPublic = publicValueSign==1 ? -publicValueAbs : +publicValueAbs
    signal signedPublic;
    signedPublic <== publicValueAbs * (1 - 2 * publicValueSign);

    signal sumIn  <== inValue[0] + inValue[1];
    signal sumOut <== outValue[0] + outValue[1];

    // Conservation: sumIn + signedPublic == sumOut
    //   shield  (sign=0, sumIn=0):       signedPublic = +dep  -> sumOut = dep ✓
    //   transfer(sign=0, publicValue=0): sumIn == sumOut ✓
    //   unshield(sign=1, sumOut=0):      sumIn - withdraw = 0 -> sumIn = withdraw ✓
    sumIn + signedPublic === sumOut;

    // ---------- action-hash binding (Option F: on-chain-recomputable SHA256) ----------
    // actionHash = SHA256(nf0|nf1|cm0|cm1|publicValueAbs|publicValueSign|assetCategory|
    //                     newMerkleRoot), each field a 32-byte BIG-ENDIAN encoding (256 bytes
    // total), truncated to 253 bits (top 3 bits of the BE hash cleared) so it fits the BN254
    // scalar field. The covenant recomputes this SAME SHA256 from the values it enforces
    // (nf0/nf1/publicValueAbs/publicValueSign/assetCategory/newMerkleRoot as args/constant,
    // plus cm0/cm1 supplied as covenant args), masks the top 3 bits, reverses to the LE
    // VM-number byte form, and requires equality with the proof's public input n1. Because
    // the covenant can recompute it cheaply (native OP_SHA256), every value the covenant
    // enforces is bound to the proof — closing the divergence attack (see COVENANT-DESIGN.md
    // §7 item 4). SHA256 is SNARK-unfriendly (~4 blocks here) but the ON-CHAIN side only
    // verifies the Groth16 proof; it never re-hashes inside the circuit's trust assumptions.
    component ahF[8];
    ahF[0] = FieldToBE256(); ahF[0].in <== nf[0];
    ahF[1] = FieldToBE256(); ahF[1].in <== nf[1];
    ahF[2] = FieldToBE256(); ahF[2].in <== cm[0];
    ahF[3] = FieldToBE256(); ahF[3].in <== cm[1];
    ahF[4] = FieldToBE256(); ahF[4].in <== publicValueAbs;
    ahF[5] = FieldToBE256(); ahF[5].in <== publicValueSign;
    ahF[6] = FieldToBE256(); ahF[6].in <== assetCategory;
    ahF[7] = FieldToBE256(); ahF[7].in <== newMerkleRoot;

    component ah = Sha256(2048);            // 8 fields x 256 bits = 2048-bit preimage
    for (var f = 0; f < 8; f++) {
        for (var b = 0; b < 256; b++) {
            ah.in[f * 256 + b] <== ahF[f].out[b];
        }
    }

    // Truncate the 256-bit hash to 253 bits (clear the top 3 bits, i.e. BE out bits 0, 1, 2)
    // and repack as a field element. 253 bits guarantees the result is ALWAYS < the BN254
    // scalar-field prime p (~2^253.6), so NO modular reduction is needed anywhere (circuit,
    // JS, or covenant) — unlike 254 bits, which can still exceed p and silently diverge.
    // Bits2Num(253) expects little-endian bits (in[0] = LSB), so we feed the BE hash bits in
    // reverse: field bit i = BE out bit (255 - i), for i in [0, 253); the top three BE bits
    // (out[0], out[1], out[2]) are dropped, which is the truncation.
    component pack = Bits2Num(253);
    for (var i = 0; i < 253; i++) {
        pack.in[i] <== ah.out[255 - i];
    }
    pack.out === actionHash;

    // ---------- authorization ----------
    // PoC: ownership is proven by knowledge of (nk, rho) reproducing the packed
    // nullifier for a note already in the tree. A stricter EdDSA-over-Poseidon
    // signature (circomlib eddsaposeidon) can be added for defense-in-depth;
    // omitted in the PoC to keep the circuit small and the MSM cheap.
}

component main {public [merkleRoot, actionHash]}
    = Pool(20, 64);
