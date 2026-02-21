import "dotenv/config";
import express from "express";
import { getGraphApp } from "./index.js";
import pino from "pino";
import { ChatOllama } from "@langchain/ollama";
import axios from "axios";

const logger = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

const app = express();
const PORT = process.env.PORT || 3000;
const BOARD_URL = process.env.BOARD_URL || "http://localhost:3001";

app.use(express.json());

// Send update to monitoring board
async function sendBoardUpdate(
  threadId: string,
  status: string,
  step?: string,
  data?: any,
) {
  try {
    await axios.post(`${BOARD_URL}/api/mission/update`, {
      threadId,
      status,
      step,
      data,
    });
  } catch (error) {
    // Board might not be running, ignore
  }
}

// Logging middleware
app.use((req, res, next) => {
  logger.info({ method: req.method, url: req.url }, "Request");
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
  });
});

// Simple test endpoint
app.post("/api/test", async (req, res) => {
  const { query } = req.body;

  try {
    const testModel = new ChatOllama({
      model: "phi3:mini",
      temperature: 0,
    });

    const response = await testModel.invoke(query || "Say hello");
    res.json({
      success: true,
      response: response.content,
    });
  } catch (error: any) {
    logger.error({ error: error.message }, "Test failed");
    res.status(500).json({ error: error.message });
  }
});

// Mission endpoint
app.post("/api/mission", async (req, res) => {
  const { query, threadId } = req.body;
  const missionId = threadId || `mission-${Date.now()}`;

  logger.info({ missionId, query }, "🎯 Mission received");

  // Notify board
  await sendBoardUpdate(missionId, "started", "Mission received", { query });

  if (!query) {
    await sendBoardUpdate(missionId, "error", "Missing query");
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const graph = await getGraphApp();
    const initialState: any = {
      input: query,
      output: "",
      steps: [],
      research: "",
    };

    await sendBoardUpdate(missionId, "processing", "Starting supervisor");
    const result = await graph.invoke(initialState);

    await sendBoardUpdate(missionId, "completed", "Mission complete", {
      outputLength: result.output?.length,
    });

    logger.info({ missionId }, "✅ Mission complete");
    res.json({
      success: true,
      threadId: missionId,
      data: result.output || "No output generated",
      steps: result.steps || [],
    });
  } catch (error: any) {
    logger.error({ error: error.message, missionId }, "❌ Mission failed");
    await sendBoardUpdate(missionId, "error", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Main server running on http://localhost:${PORT}`);
  console.log(`
  📝 Commands:
  
  # Test model:
  curl -X POST http://localhost:${PORT}/api/test \\
    -H "Content-Type: application/json" \\
    -d '{"query": "Say hello in French"}'
  
  # Run mission:
  curl -X POST http://localhost:${PORT}/api/mission \\
    -H "Content-Type: application/json" \\
    -d '{"query": "What is the capital of France?"}'
  `);
});
