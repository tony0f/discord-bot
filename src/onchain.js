// Minimal on-chain helper: resolve the sender (proposer wallet) of a
// proposal transaction. Polymarket lives on Polygon; Predict.fun on Blast.
const { JsonRpcProvider } = require("ethers");

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

// Best effort: returns the tx sender address or null (never throws).
async function getTxSender(txHash, creationSource) {
  if (!txHash) return null;
  try {
    const tx = await withTimeout(providerFor(creationSource).getTransaction(txHash), 8000);
    return tx?.from || null;
  } catch (err) {
    console.warn(`[Onchain] Sender lookup failed for ${txHash}:`, err.message);
    return null;
  }
}

// Explorer base URL matching the market's chain
function explorerFor(creationSource) {
  return creationSource === "predict.fun"
    ? "https://blastscan.io"
    : "https://polygonscan.com";
}

module.exports = { getTxSender, explorerFor };
