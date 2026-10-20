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

## Status (verified 2026-10-20)

- `eval-pool.mjs`: transfer/shield/unshield all accepted, op-cost within budget
  (65,885 / 65,893 / 65,981 vs 166,400 / 168,000 / 168,000).
- Bench + red-team gate (zk-verifier-bench `bch-groth16-intratx-pairfold5-densless-msm`):
  PASS — 5/5 invalid rejected, 9/9 mutated public inputs rejected, 26/26
  maintainer red-team runs rejected.
- **Live on chipnet**: fresh pool deployment (TX-P3/G3/B3) + first SHIELD
  (TX-S1) confirmed at block 328733 — see "On-chain demo" below. The full 8-input
  SHIELD tx (5 verifier inputs + pool covenant + public FT + sats) passes on the
  BCH 2026 VM, both consensus and standard (relayable under default mempool policy).

## Chipnet demo token (stand-in for PUSD, minted 2026-10-19)

PUSD itself (`0x2469ac...2544`) is mainnet-only, so a stand-in CashToken was
minted on chipnet for the demo pool (the covenant is asset-generic; pass this
category as the `assetCategory` constructor arg at deploy time):

- **category (display/BE)**: `479aeebabc682ddb90a3671bffd2a0bd918737de13f19a92231ed36a8580cc11`
- **category (on-chain/LE, as it appears in token prefixes)**: `11cc80856ad31e23929af113de378791bda0d2ff1b67a390db2d68bcbaee9a47`
- genesis tx `4257dbfb68540cc9afcf569da8e651790c82d3951bdff88f5232a372760ba977`
  (via the `chipnet.bch.ninja` faucet, PoW-gated `POST /api/challenge` + `/api/claim`),
  confirmed in chipnet block 328616.
- Minted payload: **100,000,000 fungible units + minting-capability NFT** (empty
  commitment), consolidated into one UTXO by sweep tx
  `be9a2911cf567f37821f777a073a9b59792b58791fa118a82925f66c67bb0ad8`
  (output 0: 100,000 sats + full token payload; output 1: 899,000 sats change).
- Mint key: HD wallet, path `m/44'/145'/0'/0/0`, address
  `bchtest:qpt2lckk5ck5x7rwcnl6ucj6z0h9njm0pvy5nudg50`
  (token-aware form `bchtest:zpt2lckk5ck5x7rwcnl6ucj6z0h9njm0pvr7qzrwtu`).
  Mnemonic/private key live ONLY in the gitignored secret store
  (`/Workspace/apecsdev/.secrets/pusd-pool-chipnet-mint.json`, chmod 600) —
  test funds, no value.
- Explorer: `https://chipnet.chaingraph.cash/tx/<txid>`.

### Fulcrum / signing caveats discovered during the mint (matter for wallet wiring)

1. **Token-bearing UTXOs are hidden from legacy Electrum queries.** Fulcrum's
   `blockchain.address.listunspent` / `get_balance` with default params return
   NOTHING for token outputs (the genesis output looked "missing" on 3 servers).
   Pass the second param `include_tokens` (or `tokens_only`) to see them.
2. **Spending a token-bearing UTXO requires covering its token prefix in the
   sighash** (2023 CashTokens signing-serialization change): with libauth, set
   `sourceOutputs[i].token` before `generateSigningSerializationBCH`, else the
   input fails NULLFAIL (`Signature must be zero for failed CHECK(MULTI)SIG`).
3. **libauth `outpointTransactionHash` is display/BE order** (it reverses internally
   in `encodeTransaction`). Passing it pre-reversed (LE) double-reverses it and the
   node rejects with "Missing inputs". This cost a debugging cycle during the pool
   funding broadcast — always pass the plain display txid to libauth.
4. **NFT commitment length**: 64-byte pool-state commitments broadcast fine on
   chipnet (the 2026 VM raised `maximumTokenCommitmentLength` to 128; the 2023
   limit of 40 is no longer enforced on chipnet — confirmed live).

## On-chain demo (chipnet, confirmed 2026-10-20)

A fresh, self-contained pool was deployed and the **first SHIELD transaction was
confirmed on chipnet block 328733**. (An earlier funding chain — funding tx
`6ea1883d...` — was superseded; the chain below is authoritative.)

### Pool deployment

| Tx | txid | Role |
| -- | ---- | ---- |
| TX-P3 | `8c73ff150fbc5d1599d2de187c3382c5926cc5c9c2621cdc2cac1fc14cd93144` | token-category genesis for the demo PUSD stand-in |
| TX-G3 | `3fd526e9cc5119cd11ef76615ad0c9e1b6187910aeaae1ed178b48c96897656b` | mint 100,000,000 fungible units (vout 2) |
| TX-B3 | `0738f33d8e83492f1ae7276f16e49e15741e75bff6d0ec0e05e3039b85859020` | pool init — pool UTXO (vout 0) carries 0 FT + mutable NFT with genesis state `{seededRoot ‖ 00×32}` |
| TX-V3 | `473f9e484e5c83a45ddd0003c6c3260c30f385be48e2ae72fa5a503f4637bf14` | funds the 5 verifier P2SH32 lockings (vouts 0–4) + sats change |

- **Covenant locking bytecode (P2SH32)**:
  `aa206f456fbb14df6384ef148a7596693a55e368f727b2662494e6fdf2e753e7505887`
- **CashAddress (P2SH32, chipnet)**: `bchtest:pdh52mamzn0k8p80zj98t9nf8f27x68hy7exvfy5um7l9e6nuag9sktq4tflt`
  (token-aware `bchtest:rdh52mamzn0k8p80zj98t9nf8f27x68hy7exvfy5um7l9e6nuag9sycu5jgxq`)
- **Pool UTXO (TX-B3:vout0)**: 1,000 sats + **0 fungible units** + mutable NFT with the
  64-byte genesis state commitment = seeded merkle root
  `2c0f533600a77df705b7a23481a16bbc2baa9e9abb6a2943857931faa3f44525` (LE) ‖ `00×32`.

### SHIELD transaction (TX-S1) — the first private payment

- **txid**: `d3a442f3d3145cba3d1d6fd626164e077fa92b02720b882e3e98b40e70f4188c`
- **confirmed**: chipnet block **328733**
- **shape**: 8 inputs (5 verifier: TX-V3 vouts 0–4 = executor×3 + genesis + terminal; pool
  covenant TX-B3:vout0; public FT TX-G3:vout2; sats TX-V3:vout5), 8 outputs
  (pool continuity ‖ executor×3 ‖ terminal ‖ genesis ‖ public-FT change ‖ sats change),
  36,999 bytes, 40,000-sat fee.
- **result**: pool balance goes 0 → **1,000,000 shielded PUSD** (pool continuity vout 0
  carries 1M FT + mutable NFT with the new state `newMerkleRoot ‖ sha256(00×32 ‖ nf0 ‖ nf1)`);
  public-FT change (vout 6) = 99,000,000 units back to the mint key.
- **VM**: all 8 inputs pass on `createVirtualMachineBch2026`, **both consensus and
  standard** — relayable under default mempool policy.
- **Explorer**: `https://chipnet.chaingraph.cash/tx/d3a442f3d3145cba3d1d6fd626164e077fa92b02720b882e3e98b40e70f4188c`

### Verifier patching required to compose with the covenant

The stock `densless-msm` verifier's **terminal step hard-pins `tx.inputs.length == 5`**
(`densless-recovered/terminal.mjs`: `OP_5 OP_EQUALVERIFY`), which structurally rejects
any additional sibling input. The pool covenant and the public-FT input must join the
same transaction as extra inputs (indices ≥ 5), so the terminal's input-count check is
relaxed to `tx.inputs.length >= 5` (`OP_5 OP_GREATERTHANOREQUAL OP_VERIFY`). All other
topology pins are unchanged: the terminal stays at input index 4 with `outpointIndex ==
activeInputIndex`, and the 3 executor + 1 genesis worker lockings are still bound by the
baked-in `workerLockingRoot`. The genesis step's public-input witness pushes stay at
**byte offsets 1825 (n0 = merkleRoot) and 1792 (n1 = actionHash)** — the deployed pool
covenant reads exactly these, so no pool redeploy is needed.

- **New terminal locking**: `aa20fe0301c69d4f570ff0d07dd664172b026cbb2eec8c7682dd297b75cfa7d5527e87`
- **New executor locking**: `aa20003bd8d3fef9c20cb345f9ec00e5c4b5e8d09dd589ffb4344a076acfd366d88187`
- **New genesis locking**: `aa20a4c97d7a380bf67b9c24d61119ced47209a7a5e1f3ad5a3d914e167a89d74ef687`

(The patched `terminal.mjs` and the full build records live in `deploy-meta-s1.json` on
the build box; backup `terminal.mjs.bak` preserved.)
