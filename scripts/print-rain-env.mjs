import dotenv from "dotenv";
/**
 * Prints effective Rain SDK environment (API + on-chain collateral).
 * Run: npm run rain:print-env
 * Optional: RAIN_ENVIRONMENT=development npm run rain:print-env
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env") });

const envModulePath = path.join(
  backendRoot,
  "node_modules",
  "@buidlrrr",
  "rain-sdk",
  "dist",
  "config",
  "environments.js",
);
const { ENV_CONFIG } = await import(pathToFileURL(envModulePath).href);

const name = process.env.RAIN_ENVIRONMENT || "production";
const cfg = ENV_CONFIG[name];

console.log("--- Rain environment (backend) ---");
console.log("RAIN_ENVIRONMENT:", name, cfg ? "✓" : "✗ unknown");
if (!cfg) {
  console.log("Allowed:", Object.keys(ENV_CONFIG).join(", "));
  process.exit(1);
}
console.log("API:", cfg.apiUrl);
console.log("Market factory:", cfg.market_factory_address);
console.log("Collateral token (USDT / dev USDT):", cfg.usdt_token, `(${cfg.usdt_symbol})`);
console.log("");
if (name === "development") {
  console.log("development: uses dev USDT on-chain — get tokens from Rain dev tooling / docs.");
  console.log("You still pay Arbitrum ETH for gas unless using full gas abstraction.");
} else {
  console.log(`${name}: uses Arbitrum One mainnet USDT (${cfg.usdt_token}).`);
  console.log(
    "Creating a market spends real USDT + gas. `stage`/`development` only change API endpoints — not free on-chain.",
  );
}
console.log("");
console.log("Docs: https://rain.one/docs/For-Developers/Rain-SDK/Environments-and-Configuration");
