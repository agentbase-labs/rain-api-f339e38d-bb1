import { Rain } from "@buidlrrr/rain-sdk";

const USDT_BY_ENV = {
  production: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  stage: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  development: "0xCa4f77A38d8552Dd1D5E44e890173921B67725F4",
};

/** @returns {'development' | 'stage' | 'production'} */
export function getRainEnvironment() {
  const e = process.env.RAIN_ENVIRONMENT || "production";
  if (!["development", "stage", "production"].includes(e)) {
    throw new Error(`Invalid RAIN_ENVIRONMENT: ${e}`);
  }
  return e;
}

export function createRain() {
  const environment = getRainEnvironment();
  const rpcUrl = process.env.ARBITRUM_RPC_URL?.trim() || undefined;
  const subgraphApiKey = process.env.SUBGRAPH_API_KEY?.trim() || undefined;
  return new Rain({ environment, rpcUrl, subgraphApiKey });
}

/** Base USDT (or dev USDT) for current `RAIN_ENVIRONMENT`. */
export function getUsdtTokenAddress() {
  const env = getRainEnvironment();
  return USDT_BY_ENV[env];
}
