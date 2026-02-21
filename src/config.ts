import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  server: {
    port: parseInt(process.env.PORT || "3000"),
    boardPort: parseInt(process.env.BOARD_PORT || "3001"),
    environment: process.env.NODE_ENV || "development",
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    models: {
      heavy: process.env.HEAVY_MODEL || "deepseek-v3.1:671b-cloud",
      fast: process.env.FAST_MODEL || "qwen3.5:cloud",
    },
  },
  database: {
    checkpointPath: process.env.CHECKPOINT_PATH || "./checkpoints.db",
    dataPath: process.env.DATA_PATH || "./data.db",
  },
  chroma: {
    url: process.env.CHROMA_URL || "http://localhost:8000",
  },
  logging: {
    level: process.env.LOG_LEVEL || "info",
    file: process.env.LOG_FILE || "./logs/app.log",
  },
  security: {
    apiKeys: (process.env.API_KEYS || "").split(",").filter(Boolean),
    rateLimit: parseInt(process.env.RATE_LIMIT || "100"),
    rateWindow: parseInt(process.env.RATE_WINDOW || "60000"), // 1 minute
  },
};

// Create required directories
import fs from "fs";
const logsDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
