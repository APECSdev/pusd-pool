# pusd-pool

Shielded pool for PUSD (ParyonUSD) on BCH **Chipnet** — the core of the
[nito.cash](https://github.com/APECSdev/nito.cash) "Private Payments" feature
(BCH Blaze 2026 submission).

- **Circuit** (`circuits/`): Circom 2.1.6, Groth16/BN254, 2-in/2-out joinsplit,
  Poseidon note commitments + nullifiers, Merkle depth 20. 183,469 constraints;
  2 public inputs `[merkleRoot, actionHash]` (253-bit truncated). See `CIRCUIT-DESIGN.md`.
- **Covenant** (`asset-pool.cash`): CashScript covenant carrying the pool state
  (SHA256 on-chain state, asset-generic). See `COVENANT-DESIGN.md`.
- **Verifier**: the pool proof is verified on-chain by the chunked BN254 Groth16
  verifier from [`mr-zwets/groth16_cashscript`](https://github.com/mr-zwets/groth16_cashscript)
  (bench harness: `mr-zwets/zk-verifier-bench`), evaluated with mr-zwets'
  CashScript fork (branch-aware loop inlining).

## Trusted setup

- **Phase 1**: public [Perpetual Powers of Tau](https://pse.dev/projects/powers-of-tau)
  `ppot_0080_18.ptau` (302,083,218 bytes; 86 participants incl. the nito.cash
  operator as #0023). Download from the PSE S3 bucket; not committed (size).
- **Phase 2**: currently a **disclosed 1-of-1 placeholder**
  (`setup.log`, `setup2.log`), to be replaced by a community MPC ceremony
  before any mainnet value. Full text: nito.cash `apps/docs/private-payments/trusted-setup.md`.

## Layout

| Path | Contents |
| ---- | -------- |
| `circuits/` | `pool.circom` (joinsplit), `note.circom` (commitment/nullifier/Merkle primitives) |
| `asset-pool.cash` | the pool covenant (CashScript) |
| `artifacts/` | **gitignored** — stale pre-PPOT snapshot kept on the build box |
| `build/` | current PPOT-derived outputs: `verification_key.json`, `pusd-public-fixtures.json`, `pusd-vectors.json`, `eval-proofs.json` (committed); big binaries (gitignored) |
| `gen-vectors.mjs`, `gen-fixtures.mjs`, `gen-eval-proofs.mjs`, `e2e.mjs`, `eval-pool.mjs` | generators + end-to-end evaluation drivers |
| `run-setup.sh`, `run-setup2.sh`, `setup.log`, `setup2.log` | phase-2 placeholder ceremony run + logs |

## Regenerating `build/` (gitignored binaries)

On the `runner` build box (`~/pusd-pool`), with `pnpm install --frozen-lockfile` done:

1. `ppot_0080_18.ptau` — re-download from the PSE S3 bucket (289 MB, byte-verified).
2. Circuit compile + phase 2: `run-setup.sh` / `run-setup2.sh`
   (produces `build/pool.r1cs`, `build/pool_js/pool.wasm`, `build/pool_0000.zkey`,
   `build/pool_final.zkey`, `build/verification_key.json`).
3. Fixtures/vectors: `node gen-fixtures.mjs`, `node gen-vectors.mjs`.
4. Eval proofs: `node gen-eval-proofs.mjs` → `build/eval-proofs.json`
   (transfer/shield/unshield, all `proved`).

The current zkey (`build/pool_final.zkey`, 94 MB) and wasm live on the build
box; publish via a GitHub Release if external distribution is needed.

## Status (verified 2026-10-19)

- `eval-pool.mjs`: transfer/shield/unshield all accepted, op-cost within budget
  (65,885 / 65,893 / 65,981 vs 166,400 / 168,000 / 168,000).
- Bench + red-team gate (zk-verifier-bench `bch-groth16-intratx-pairfold5-densless-msm`):
  PASS — 5/5 invalid rejected, 9/9 mutated public inputs rejected, 26/26
  maintainer red-team runs rejected.
