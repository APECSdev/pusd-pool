# PUSD Shielded Pool — BCH Covenant Design

Status: covenant **BUILT + on-chain evaluation PASSING** (chipnet PoC), with the
**actionHash binding ENFORCED** (Option F / 253-bit SHA256). Grounded in:
- the **proven** `densless-msm` Groth16 verifier (PASS on BCH 2026 VM, 5 P2SH32
  inputs / 1 standard tx / 35,627 B / 24.40M op / 26 red-team runs rejected), re-spun
  on the **Option-F verifying key**, and
- the **Option-F circuit** (`circuits/pool.circom`): exactly TWO public inputs
  `[merkleRoot, actionHash]`, `actionHash = Bits2Num(253)(SHA256(nf0 | nf1 | cm0 |
  cm1 | publicValueAbs | publicValueSign | assetCategory | newMerkleRoot))` — each
  field a 32-byte big-endian encoding, the 256-bit digest truncated to **253 bits**.

The covenant (`asset-pool.cash`) compiles to 222 B and evaluates `accepted: true` on
the standard BCH 2026 VM as the 6th input of the combined transaction, on all three
paths (shield / transfer / unshield), within op-cost budget. It recomputes the
actionHash in-script (native `OP_SHA256`) and requires it to equal the proof's `n1`,
closing the divergence attack. See §7 for the full build-plan status and the
integration facts discovered during evaluation.

## 1. What the covenant must do

The Groth16 verifier proves *"the prover knows a valid state transition."* The
**covenant** is what makes that transition *real on-chain*: it holds the pool's
PUSD CashTokens and its state, and only allows a spend that (a) is accompanied by
a passing verifier and (b) applies exactly the transition the proof attests to.

Concretely the pool is a **single covenant UTXO** carrying:

- the pool's **PUSD CashToken balance** (fungible tokens of category
  `0x2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`), and
- the pool **state**, in a CashToken **NFT commitment** on the same UTXO:
  `{ merkleRoot, nullifierSet }`.

A spend of the pool UTXO is a **state transition**: old `{merkleRoot, nullifierSet,
balance}` → new `{merkleRoot', nullifierSet', balance'}`. The covenant enforces that
this transition matches a valid proof.

## 2. The verifier interface the covenant consumes

The verifier is **5 P2SH32 inputs in ONE transaction** (an intra-tx chain). The two
public inputs live in the **genesis step (input index 3)**:

| location | value | meaning |
| -------- | ----- | ------- |
| input 3, push 22 | `n0` = `merkleRoot` | pool note-tree root (public anchor) |
| input 3, push 21 | `n1` = `actionHash` | Poseidon binding of the whole action |

The verifier **recomputes `vk_x = IC0 + n0·IC1 + n1·IC2` in-script** (the GLV MSM)
and the pairing check passes only for a valid proof over exactly `(n0, n1)`. The
bench proves 9/9 mutated public inputs are rejected and all 26 red-team attacks fail
— so the covenant can **trust** that whatever `n0`/`n1` sit in a *passing* verifier's
genesis are the values the proof actually binds.

**The covenant does NOT re-verify the proof.** It reads the proven `(merkleRoot,
actionHash)` from the verifier input and enforces the *state transition* those two
values imply. The verifier's mere presence-and-passing is the soundness anchor.

## 3. The binding problem (and the solution)

The covenant must ensure the verifier in *this* tx is (a) present, (b) passing, and
(c) proving *this* pool's transition — not some unrelated proof pasted in.

BCH covenants use **introspection**: a covenant can read `tx.inputs[i]` and
`tx.outputs[i]` (locking bytecode, value, token category/amount/NFT commitment) but
**cannot read a sibling input's unlocking bytecode** (the witness). So the covenant
cannot directly "see" the verifier's `n0`/`n1` pushes.

**Solution — carry the public inputs in the pool covenant's own NFT commitment, and
make the verifier's genesis *be* the pool spend.** Two sub-decisions:

### 3a. The pool covenant is a SEPARATE 6th input (chosen)

The verifier uses the **`intraTx` model**: its 5 inputs carry the pairing computation
forward by reading each other's witnesses (`OP_INPUTBYTECODE`), passing state as raw
byte blobs — **no NFT commitment, no `tx.outputs` perpetuation**. The pool covenant,
by contrast, uses the **`covenant` (token-threading) model**: its state lives in an
NFT commitment, perpetuated via `tx.outputs[0]`.

These are two different state-passing mechanisms, and they **coexist as separate
inputs of one transaction**: the verifier's 5 inputs run in `intraTx` mode; the pool
covenant is a **6th input** running in `covenant` mode (its own NFT thread). The only
coupling is that the pool covenant reads the proven `[merkleRoot, actionHash]` — and
it CAN, because a covenant may introspect a **sibling input's unlocking bytecode**
(`tx.inputs[3].unlockingBytecode`, confirmed in the cashscript fork). The genesis
input's `n0`/`n1` sit at fixed witness offsets, so the pool covenant slices them out
directly.

**This keeps the proven verifier 100% untouched** (no re-benchmark of its 5 inputs'
op-cost/standardness) and adds the pool as an independent 6th input with its own
generous op-cost budget (~8M, since its unlocking is small). The earlier idea of
merging the pool logic INTO the genesis redeem (via the `carrier()` pattern) was
rejected: it would force a re-run of the verifier's delicate fixed-point build and
re-benchmark, for no benefit over the clean 6th-input split.

### 3b. State carried in the NFT commitment

The pool UTXO (the genesis input's *output* from the previous tx, and its own
continuing output) carries an NFT with commitment encoding:

```
commitment = encode( merkleRoot[32] | nullifierSetHash[32] | version[1] )
```

- `merkleRoot` — current note-tree root (must equal the proof's `n0` for a spend).
- `nullifierSetHash` — a hash/commitment to the set of spent nullifiers. For the PoC
  this is a **Poseidon/SHA256 rolling hash over the sorted nullifier list**; the full
  set is held off-chain by the indexer, the covenant only needs to *update* it.

## 4. The state transition the covenant enforces

On a spend, the covenant (genesis input) checks, via introspection:

1. **Continuity (covenant perpetuation).** Output 0 pays back to `this.lockingBytecode`
   (the pool covenant) — the pool cannot be drained to an arbitrary script.
2. **State update.** Output 0's NFT commitment encodes the NEW state
   `{merkleRoot', nullifierSetHash'}` where:
   - `merkleRoot'` = the root after appending the two new commitments `cm0, cm1`.
     The covenant does NOT recompute the Poseidon Merkle tree on-chain (too costly);
     instead it trusts the proof's binding (below) and records `merkleRoot'` supplied
     as a covenant parameter, **provided** the actionHash ties it to `cm0/cm1`.
   - `nullifierSetHash'` = `H(nullifierSetHash, nf0, nf1)` — fold the two new spent
     nullifiers into the set hash. (Double-spend prevention: the indexer rejects any
     tx whose `nf0`/`nf1` is already in the off-chain set; the covenant's rolling hash
     makes the on-chain state commit to that set.)
3. **Token conservation (per op).** Let `B = this` input's PUSD amount,
   `B' = output 0`'s PUSD amount, and `publicValue` the signed public flow:
   - **SHIELD** (`publicValueSign=0`, `publicValueAbs=dep`): the tx has an additional
     public PUSD input of `dep`; covenant requires `B' == B + dep`.
   - **TRANSFER** (`publicValueAbs=0`): `B' == B`.
   - **UNSHIELD** (`publicValueSign=1`, `publicValueAbs=wd`): the tx has a public PUSD
     output of `wd` to the recipient; covenant requires `B' == B - wd` and that a
     `wd`-amount PUSD output exists.
4. **Asset binding.** The PUSD token category on input and output 0 equals the pinned
   `assetCategory` constant.
5. **actionHash recomputation.** The covenant recomputes
   `Poseidon(7)(nf0, nf1, cm0, cm1, publicValueAbs, publicValueSign, assetCategory)`
   from the values it enforced in steps 2–4 and requires it to equal the proof's
   `n1` (push 21). This is the **linchpin**: it binds the on-chain state transition
   to the proof, so the proof cannot attest to one transition while the covenant
   applies another.

> **On-chain Poseidon cost note.** Step 5 requires evaluating Poseidon(7) in
> CashScript. Poseidon is SNARK-friendly but NOT opcode-friendly (many field muls).
> This is the covenant's main op-cost risk and is addressed in §6.

## 5. Why this is sound

- **Proof soundness** — the verifier only passes for a valid Groth16 proof over
  `(merkleRoot, actionHash)` (bench: 5/5 valid accepted, 9/9 mutated rejected, 26/26
  red-team rejected).
- **Binding** — the covenant recomputes `actionHash` from the *actual* enforced
  transition and requires equality with the proven `n1`. A prover cannot make the
  covenant apply a transition the proof didn't attest to (they'd need a proof whose
  `actionHash` matches a *different* set of `(nf, cm, publicValue, category)` — a
  Poseidon preimage/collision).
- **Conservation** — token amounts are checked by introspection; the circuit
  separately constrains `sumIn + signedPublic == sumOut`. Neither can mint/burn PUSD.
- **Double-spend** — `nf0/nf1` are folded into `nullifierSetHash`; the circuit ties
  each `nf` to a real note in `merkleRoot` (membership) and the owner key. Re-using a
  note reproduces the same `nf`, which the indexer/covenant reject as already-spent.

## 5b. Measured headroom for the pool logic (from the bench)

The BCH 2026 VM op-cost budget is **per-input**: `(41 + unlockingLen) × 800`, capped
at the 10,000-byte script size → max ≈ **8,032,800 op-cost per input**. From the
bench step profile of our verifier:

| input | step | cumulative op-cost | this input's op-cost | redeem size |
| ----- | ---- | ------------------ | -------------------- | ----------- |
| 0 | executor-start | 4,552,353 | ~4.55M | 364 B |
| 1 | miller-interior | 8,654,772 | ~4.10M | 364 B |
| 2 | miller-interior | 13,017,502 | ~4.36M | 364 B |
| 3 | **vkx-subgroup (genesis)** | 18,663,177 | **~5.65M** | **5,909 B** |
| 4 | pairing-close (terminal) | 24,554,500 | ~5.89M | 4,157 B |

The **genesis input (input 3)** — where the pool logic must live, since it already
carries `n0`/`n1` — uses ~5.65M op-cost and 5,909 B, leaving **≈2.4M op-cost and
≈4 KB** of headroom in that input. Introspection-based checks (token category/amount,
output locking bytecode, NFT commitment compare, SHA256 state fold) are a handful of
opcodes each and fit comfortably. **On-chain Poseidon(7) does NOT fit** in 2.4M
op-cost (BN254 field muls are hundreds-to-thousands of op-cost each; Poseidon(7) needs
hundreds of muls) — this is the concrete reason §6 recommends option 3 for the PoC.

## 6. Open cost risk: on-chain Poseidon

The covenant's actionHash recomputation (step 5) needs Poseidon(7) in CashScript.
BN254 field arithmetic on BCH VM is expensive (no native 254-bit mul). Options, in
order of preference:

1. **Move actionHash off the covenant's critical path.** The covenant does NOT need
   to recompute Poseidon if it instead reads `nf0/nf1/cm0/cm1/publicValue/category`
   from its *own* NFT commitment + parameters and lets the **proof's binding** do the
   work — but then the covenant can't independently verify the link. (Weakens §5's
   independent binding; the proof still binds them, so this may be acceptable: the
   covenant enforces the *token* conservation by introspection, and trusts the proof
   for the *note-level* validity, which is exactly the trust split Zcash uses.)
2. **Implement Poseidon(7) in CashScript** and measure op-cost against the 2026 VM
   limits (the verifier already uses 24.5M of the budget; Poseidon must fit in the
   *genesis input's* separate budget — each input has its own op-cost allowance).
3. **Use a cheaper on-chain hash** for the covenant's *internal* state commitment
   (SHA256, native opcode) while keeping Poseidon only inside the circuit. The
   actionHash binding then happens entirely in-circuit + in the verifier, and the
   covenant checks token conservation + state continuity with SHA256 commitments.

**Decision for the PoC:** start with option 3 (cheapest, no Poseidon on-chain), and
treat option 2 as the hardening step if the budget allows. The token-conservation and
covenant-continuity checks (the parts that protect *value*) are pure introspection
and cost almost nothing; the Poseidon binding is defense-in-depth for the note layer.

## 7. Concrete build plan — status

1. **CashScript pool covenant — DONE.** Written as **`asset-pool.cash`** (asset-generic;
   the PUSD category is a constructor param, so the same contract serves any CashToken
   category). Implements §4 steps 0–4 (root binding, continuity, state update, token
   conservation, asset binding) with a SHA256 state commitment, compiled with the
   `compiler-optimizations-8` fork (cashc **0.14.0**, pragma `^0.14.0`). Final contract:
   `contract AssetPool(bytes32 assetCategory)` with
   `function spend(bytes32 nf0, bytes32 nf1, bytes32 cm0, bytes32 cm1, bytes32 newMerkleRoot, int publicValueAbs, int isUnshield)`.
   Compiled bytecode **222 bytes**. Artifacts: `artifacts/asset-pool.cash`,
   `artifacts/asset-pool.artifact.json`.
2. **Integrate with the verifier — DONE (as a SEPARATE 6th input, per §3a).** The pool
   covenant is **not** merged into the genesis input; it is an independent 6th input
   (index 5) running in `covenant` (token-threading) mode alongside the verifier's 5
   `intraTx` inputs. The verifier is 100% untouched (no fixed-point rebuild, no
   re-benchmark of its 5 inputs). Coupling: the pool reads the proven `n0` (merkleRoot)
   from the genesis sibling's witness at the fixed byte offset below.
3. **Re-benchmark / on-chain evaluation — DONE (PASS).** `artifacts/eval-pool.mjs`
   builds the full 6-input transaction and evaluates the pool input on the **standard
   BCH 2026 VM** (`createVirtualMachineBch2026(true)` — the same VM the bench grades the
   `densless-msm` verifier on; our impl does NOT require the proposed `bch-spec` VM).
   All three covenant paths evaluate `accepted: true` and within the per-input op-cost
   budget `(41 + unlockingLen) × 800`:
   - transfer (`isUnshield=0, publicValueAbs=0`) — op-cost 65,885 / budget 166,400
   - shield (`isUnshield=0, publicValueAbs=250` deposit) — op-cost 65,893 / budget 168,000
   - unshield (`isUnshield=1, publicValueAbs=400` payout) — op-cost 65,981 / budget 168,000
   Pool unlocking ≈ 167–169 B; redeem 222 B. (Op-costs rose from the original ~34.8k
   because the covenant now also recomputes the actionHash SHA256 + the extra cm0/cm1
   args; still ~2.5× under budget.)

   **Integration facts discovered during evaluation (load-bearing for the wallet builder):**
   - **n0 byte offset = 1825** (not 1824). Byte 1824 of the genesis unlocking is the
     `0x20` (OP_PUSHBYTES_32) opcode; the 32-byte n0 **data payload** starts at 1825.
     Stable across all 5 fixtures. n1 (actionHash) data starts at 1792 (opcode at 1791).
   - **`tx.inputs[i].tokenCategory` returns 33 bytes**: the 32-byte category in
     **on-chain (reversed) byte order** concatenated with the NFT capability byte
     (`0x01` mutable / `0x02` minting). A **fungible-only** token output returns the
     bare 32-byte category (no capability byte). So the pool state NFT (mutable)
     compares `tokenCategory == assetCategory + 0x01`, while the unshield payout output
     (fungible-only) compares `tokenCategory == assetCategory`. The constructor arg
     `assetCategory` is supplied in **on-chain (reversed) byte order** to match
     introspection.
   - The standard BCH 2026 VM does **not** enforce the legacy 520-byte stack-element
     limit on `OP_INPUTBYTECODE` results, so reading the 7,769-byte genesis witness
     in-script is fine (this is what the verifier itself relies on).
4. **Wire the actionHash binding** — **DONE (Option F, 253-bit SHA256).**
   The constraint space was fully mapped (on-chain Poseidon infeasible; MSM fixed at
   2 public inputs; the weak trust-split unsound — see the git history for the full
   analysis). **Chosen direction (Option F):** make `actionHash` a **SHA256 the
   covenant can recompute** over the covenant-visible tuple, exposed as the 2nd public
   input:
   `n1 = SHA256(nf0 | nf1 | cm0 | cm1 | publicValueAbs | publicValueSign | category |
   newMerkleRoot)`, each field a 32-byte big-endian encoding, the 256-bit digest
   **truncated to 253 bits**, computed in-circuit. The covenant recomputes the same
   SHA256 from its args (`nf0/nf1/cm0/cm1/newMerkleRoot/publicValueAbs/isUnshield`)
   and its constant (`category`), and checks `== n1`. This keeps the MSM at 2 public
   inputs and binds every enforced value to the proof. **Implemented + verified:**
   circuit recompiled (183,469 constraints / 181,956 wires / 2 public inputs), new
   2^18 phase-2 trusted setup (`build/pool_final.zkey` + `build/verification_key.json`,
   3 IC points), verifier re-benchmarked (PASS, 26 red-team rejected), covenant
   recompiled (222 B) and re-evaluated (3/3 accepted, in budget).

   **Two field-encoding bugs were found and fixed during integration (both verified
   against the proof's publicSignals):**
   - **actionHash field-overflow (the subtle one).** The original design truncated the
     SHA256 digest to **254 bits** (`byte[0] &= 0x3f`). But the BN254 scalar-field
     prime is `p ≈ 2^253.6 < 2^254`, so a masked 254-bit value can still be `≥ p`.
     The circuit's `Bits2Num(254)` packs the bits into a *field signal*, which
     **auto-reduces mod p**; the JS generators and the covenant used plain integer
     masking (`& 0x3f`) with **no mod-p reduction**. For preimages whose masked digest
     was `< p` (e.g. the transfer fixture) the two coincidentally agreed; for digests
     `≥ p` (shield/unshield) they silently diverged and the covenant rejected a valid
     proof. **Fix (Option 2):** truncate to **253 bits** (`byte[0] &= 0x1f`,
     `Bits2Num(253)`). Since `2^253 < p`, the truncated value is *always* a valid
     field element, so **no modular reduction is ever needed** on any side (circuit,
     JS, or covenant) — cleaner than adding a mod-p conditional subtract everywhere.
     This changed the circuit's R1CS, so it required a **new phase-2 trusted setup**
     (phase-1 `pot18_final.ptau` was reused — it is circuit-agnostic).
   - **assetCategory byte order.** The covenant hashes `assetCategory` into the
     actionHash preimage. The constructor arg is supplied in **on-chain (reversed)
     byte order** (to match `tx.inputs[i].tokenCategory` introspection), but the
     circuit hashes the **natural big-endian integer** encoding. The covenant must
     therefore use `assetCategory.reverse()` in the SHA256 preimage to recover the
     natural BE form. (The field-element args `nf0/nf1/cm0/cm1/newMerkleRoot` arrive
     as 32-byte LE VM numbers and are `.reverse()`d to BE; `publicValueAbs`/`isUnshield`
     are small ints via `toPaddedBytes(x, 32).reverse()`.)
5. **Indexer** (Fulcrum + Chaingraph) tracks `nullifierSet` + the Merkle tree and
   serves membership proofs to the wallet — **PENDING** (infra on `bch-infra`).

## 8. What is NOT in the PoC (deferred)

- EdDSA owner-signature in-circuit (PoC uses knowledge-of-`(nk, rho)`; see
  `pool.circom` §authorization).
- A real sparse-Merkle nullifier set on-chain (PoC uses a rolling hash + indexer).
- Mainnet MPC trusted setup (chipnet uses the disclosed 1-of-1).
- Multi-asset pools (PoC is PUSD-only; `assetCategory` is a pinned constant).
