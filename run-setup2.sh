#!/bin/bash
set -e
cd ~/pusd-shielded-pool
SJ=node_modules/.bin/snarkjs
# reuse the EXISTING properly-prepared pot_final.ptau (2^15, still >= 26189 constraints? 2^15=32768 yes)
echo "[$(date -u +%T)] verify existing ptau..."
$SJ powersoftau verify build/ptau/pot_final.ptau 2>&1 | grep -iE "WARN|Ok" | head -1
echo "[$(date -u +%T)] groth16 setup (new circuit)..."
$SJ groth16 setup build/pool.r1cs build/ptau/pot_final.ptau build/pool_0.zkey
echo "[$(date -u +%T)] SETUP_OK"
$SJ zkey contribute build/pool_0.zkey build/pool_final.zkey --name="nito poc 1of1" -e="$(head -c32 /dev/urandom|xxd -p -c64)" 2>&1 | tail -1
echo "[$(date -u +%T)] CONTRIBUTE_OK"
$SJ zkey export verificationkey build/pool_final.zkey build/verification_key.json 2>&1 | tail -1
echo "[$(date -u +%T)] VK_OK"
node -e 'const vk=require("/home/ubuntu/pusd-shielded-pool/build/verification_key.json");console.log("ic.length:",vk.IC.length,"=> public inputs =",vk.IC.length-1)'
echo "ALL_DONE"
