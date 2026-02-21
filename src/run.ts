// This is a plain JS file to avoid loader issues
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log("🚀 Starting Autonomous Multi-Agent Backend...");
console.log("Node version:", process.version);

// Use ts-node with the new register API
const serverProcess = spawn(
  "node",
  [
    "--import",
    'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("ts-node/esm", pathToFileURL("./"));',
    join(__dirname, "server.ts"),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  },
);

serverProcess.on("error", (error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

serverProcess.on("exit", (code) => {
  console.log(`Server process exited with code ${code}`);
  process.exit(code);
});
