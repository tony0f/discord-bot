// Minimal on-chain helper: resolve the REAL proposer of a proposal tx.
// Polymarket lives on Polygon; Predict.fun on Blast.
//
// tx.from is NOT the proposer in general (relayers, multisigs, contracts
// calling proposePriceFor). The Optimistic Oracle emits ProposePrice with
// the proposer it registered — authoritative in every case, equivalent to
// reading getRequest().proposer but from the receipt we already fetch.
const { JsonRpcProvider, id, getAddress } = require("ethers");

// ProposePrice(requester indexed, proposer indexed, identifier, timestamp,
// ancillaryData, proposedPrice, expirationTimestamp, currency) — OOv2/MOOV2
// (verified live against MOOV2 0x2C0367…58B1 on Polygon)
const PROPOSE_PRICE_TOPICS = new Set([
  id("ProposePrice(address,address,bytes32,uint256,bytes,int256,uint256,address)"),
]);

const RPC_BY_SOURCE = {
  polymarket: "https://polygon.drpc.org",
  "predict.fun": "https://rpc.blast.io",
};

const providers = new Map();

function providerFor(source) {
  const url = RPC_BY_SOURCE[source] || RPC_BY_SOURCE.polymarket;
  if (!providers.has(url)) {
    providers.set(url, new JsonRpcProvider(url));
  }
  return providers.get(url);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

// Best effort: returns the REAL proposer from the tx's ProposePrice event,
// falling back to the tx sender when no event matches. Never throws.
async function getProposer(txHash, creationSource) {
  if (!txHash) return null;
  try {
    const receipt = await withTimeout(
      providerFor(creationSource).getTransactionReceipt(txHash),
      8000,
    );
    if (!receipt) return null;
    for (const log of receipt.logs) {
      if (PROPOSE_PRICE_TOPICS.has(log.topics[0]) && log.topics[2]) {
        return getAddress("0x" + log.topics[2].slice(26));
      }
    }
    console.warn(`[Onchain] No ProposePrice event in ${txHash}; falling back to tx.from.`);
    return receipt.from || null;
  } catch (err) {
    console.warn(`[Onchain] Proposer lookup failed for ${txHash}:`, err.message);
    return null;
  }
}

// Explorer base URL matching the market's chain
function explorerFor(creationSource) {
  return creationSource === "predict.fun"
    ? "https://blastscan.io"
    : "https://polygonscan.com";
}

module.exports = { getProposer, explorerFor };
