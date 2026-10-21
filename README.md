<!-- README.md -->

# pusd-pool

Shielded pool for **PUSD** on BCH **Chipnet** — the zero-knowledge core of
[nito.cash](https://github.com/APECSdev/nito.cash) **Private Payments**
(BCH Blaze 2026 submission).

**Status: live on chipnet.** The full pool lifecycle — deploy, SHIELD,
shielded→shielded TRANSFER, and UNSHIELD — is confirmed on-chain
(blocks 328733 / 328740 / 328744).

## Documentation

| File | Contents |
| ---- | -------- |
| `CHIPNET.md` | Build record + on-chain demo: deployment, the SHIELD / TRANSFER / UNSHIELD worked examples, verifier patching, trusted setup |
| `CIRCUIT-DESIGN.md` | The Circom / Groth16 joinsplit circuit (note commitments, nullifiers, Merkle tree) |
| `COVENANT-DESIGN.md` | The CashScript pool covenant (state machine, action-hash binding) |

## Main README

The **main project README** lives at
**[APECSdev/nito.cash](https://github.com/APECSdev/nito.cash)**.
