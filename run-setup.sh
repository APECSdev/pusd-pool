#!/bin/bash
set -e
cd ~/pusd-shielded-pool
SJ=node_modules/.bin/snarkjs
echo "[$(date -u +%T)] prepare phase2..."
$SJ powersoftau prepare phase2 build/ptau/pot_1.ptau build/ptau/pot_final.ptau
echo "[$(date -u +%T)] PREP_OK"
$SJ powersoftau verify build/ptau/pot_final.ptau 2>&1 | grep -iE "WARN|OK" | head -2
echo "[$(date -u +%T)] groth16 setup..."
$SJ groth16 setup build/pool.r1cs build/ptau/pot_final.ptau build/pool_0.zkey
echo "[$(date -u +%T)] SETUP_OK"
$SJ zkey contribute build/pool_0.zkey build/pool_final.zkey --name="nito poc 1of1" -e="$(head -c32 /dev/urandom|xxd -p -c64)"
echo "[$(date -u +%T)] CONTRIBUTE_OK"
$SJ zkey export verificationkey build/pool_final.zkey build/verification_key.json
echo "[$(date -u +%T)] VK_OK"
echo "ALL_DONE"
