import "dotenv/config";
import express from "express";
import { getGraphApp } from "./index.js";
import axios from "axios";

const server = express();
server.use(express.json());

// Initialize the app once
const teamGraph = await getGraphApp();

/**
 * Trigger a Multi-Agent Mission
 * @body {string} query - The user request
 * @body {string} threadId - Unique ID for session persistence
 */
server.post("/api/mission", async (req, res) => {
  const { query, threadId } = req.body;

  if (!query || !threadId) {
    return res.status(400).json({ error: "Missing query or threadId" });
  }

  const config = { configurable: { thread_id: threadId } };

  try {
    const finalState = await teamGraph.invoke({ input: query }, config);
    res.json({ success: true, threadId, data: finalState.results });
  } catch (error) {
    console.error("Critical Backend Error:", error);
    res
      .status(500)
      .json({ error: "The multi-agent team encountered a failure." });
  }
});

server.post("/api/mission/retry", async (req, res) => {
  const { threadId } = req.body;

  console.log("Retrying mission with threadId:", threadId);

  if (!threadId) {
    return res.status(400).json({ error: "Missing threadId to retry." });
  }

  const config = { configurable: { thread_id: threadId } };

  try {
    /**
     * TRICK: Pass 'null' or an empty object to .invoke()
     * LangGraph looks at the SQLite checkpoint for 'threadId'.
     * It sees the graph stopped at a specific node and RE-RUNS that node.
     */
    const currentState = await teamGraph.invoke(null, config);

    res.json({
      success: true,
      recovered: true,
      data: currentState.results,
    });
  } catch (error) {
    console.error("Retry Failed:", error);
    res.status(500).json({
      error: "Still failing. Check if Ollama is overwhelmed.",
      tip: "Try reducing the model size or increasing VRAM.",
    });
  }
});

async function verifyOllamaSetup() {
  const OLLAMA_URL = "http://127.0.0.1:11434/api/tags";
  const REQUIRED_MODELS = ["phi:latest"];

  console.log("🔍 Checking Local AI Infrastructure...");

  try {
    // 1. Check if Ollama is even running
    const response = await axios.get(OLLAMA_URL);
    const installedModels = response.data.models.map((m: any) => m.name);
    console.log(
      "✅ Ollama is running. Installed models:",
      installedModels.join(", "),
    );

    // 2. Check if the "Muscles" and "Brains" are downloaded
    for (const model of REQUIRED_MODELS) {
      console.log(`Checking model: ${model}...`);
      if (!installedModels.includes(model)) {
        console.warn(
          `⚠️  Model [${model}] is missing! Run: 'ollama pull ${model}'`,
        );
      } else {
        console.log(`✅ Model [${model}] is ready.`);
      }
    }
    console.log("🚀 Ollama Connection: STABLE\n");
  } catch (error: any) {
    console.log("❌ Ollama Connection Failed:", error.message);
    console.error(`
    ❌ CRITICAL ERROR: Cannot connect to Ollama at 127.0.0.1:11434.
    
    TIPS:
    1. Is the Ollama app running?
    2. Try running 'ollama serve' in a separate terminal.
    3. If using Docker, use 'http://host.docker.internal:11434'.
    `);
    process.exit(1); // Stop the server if the "Brain" is missing
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await verifyOllamaSetup();
  console.log(`
  🚀 Autonomous Multi Agent Backend Online
  📡 API: http://localhost:${PORT}/api/mission
  🧠 LLMs: Ollama (Local)
  💾 DB: SQLite (checkpoints.db)
  `);
});
