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

## Covenant deployment (chipnet, 2026-10-20)

The 7-arg Option-F covenant is funded and live on chipnet with its genesis state.

- **Covenant locking bytecode (P2SH32)**:
  `aa2075c371c36395d80fc9a7e8922babb58b9539f92fd199aa80cd497b72085d2ec287`
  (`OP_HASH256 <hash256(redeem)> OP_EQUAL`; redeem = ctor-push(assetCategory) +
  the 189-byte contract bytecode, 222 bytes total).
- **CashAddress (P2SH32, chipnet)**:
  `bchtest:qd6uxuwrvw2asr7f5l5fy2atkk9e2w0e9lgen25qe4yhkusgt5hvyhutcs9qm`
- **Funding tx**: `6ea1883d6faadfe6b5338025d9f6e23ad59aca83ed85ef62e7feb4c5292ac472`
  (vout 0 = the pool UTXO). Spends the two mint-key UTXOs from the sweep tx
  `be9a2911...`; vout 1 returns 995,000 sats change to the mint key; vout 2 returns
  the minting-capability NFT to the mint key so demo supply can be topped up.
- **Pool UTXO**: 1,000 sats + **100,000,000 fungible stand-in units** + a
  **mutable-capability NFT** carrying the 64-byte genesis state commitment:
  `3e1f1922dfb671d3f912f7ea461e0a88ee848fdde12b6c18ab1ad2c56ae73421` (genesis
  merkle root = depth-20 Poseidon zero tree, LE VM-number form) ‖ `00×32`
  (empty nullifier-set hash).
- Broadcast via `blockchain.transaction.broadcast` over `chipnet.imaginary.cash:50004`
  (raw `ws`; the `@electrum-cash/network` client swallows the broadcast result —
  use a raw WebSocket to read the txid/error).
- Explorer: `https://chipnet.chaingraph.cash/tx/6ea1883d6faadfe6b5338025d9f6e23ad59aca83ed85ef62e7feb4c5292ac472`.
