import "dotenv/config";
import express from "express";
import {
  getGraphApp,
  sqlTool,
  scraperTool,
  codeTool,
  fileTool,
  memoryStore,
} from "./index.js";
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

// --- TOOL ENDPOINTS ---
app.post("/api/tool/sql", async (req, res) => {
  const { query } = req.body;
  try {
    const result = await sqlTool.invoke(query);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tool/scrape", async (req, res) => {
  const { url } = req.body;
  try {
    const result = await scraperTool.invoke(url);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tool/code", async (req, res) => {
  const { code } = req.body;
  try {
    const result = await codeTool.invoke(code);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tool/file", async (req, res) => {
  const { operation, path, content } = req.body;
  try {
    const result = await fileTool.invoke({ operation, path, content });
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/memory/add", async (req, res) => {
  const { text, metadata } = req.body;
  try {
    const result = await memoryStore.addMemory(text, metadata);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/memory/recall", async (req, res) => {
  const { query, k } = req.body;
  try {
    const result = await memoryStore.recall(query, k || 5);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- MISSION ENDPOINT ---
app.post("/api/mission", async (req, res) => {
  const { query, threadId, tools } = req.body;
  const missionId = threadId || `mission-${Date.now()}`;

  logger.info({ missionId, query }, "🎯 Mission received");

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const graph = await getGraphApp();

    // Properly initialize state with all required fields
    const initialState = {
      input: query,
      output: "",
      steps: [],
      research: "",
      plan: null,
      critiqueResult: null,
      iteration: 0,
      memories: [],
      tools: tools || [],
      threadId: missionId,
      timestamp: new Date().toISOString(),
    };

    const config = {
      configurable: {
        thread_id: missionId,
      },
    };

    logger.info({ missionId }, "🚀 Invoking graph");
    const result = await graph.invoke(initialState, config);

    logger.info({ missionId }, "✅ Mission complete");
    res.json({
      success: true,
      threadId: missionId,
      output: result.output || result.research || "No output generated",
      steps: result.steps || [],
      critique: result.critiqueResult,
    });
  } catch (error: any) {
    logger.error({ error: error.message, missionId }, "❌ Mission failed");
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// --- CHECKPOINTING ENDPOINTS ---
app.get("/api/missions", async (req, res) => {
  try {
    const graph = await getGraphApp();
    const checkpointer = (graph as any).checkpointer;
    const missions: any[] = [];

    for await (const checkpoint of checkpointer.list({})) {
      if (checkpoint.config?.configurable?.thread_id) {
        missions.push({
          threadId: checkpoint.config.configurable.thread_id,
          createdAt: checkpoint.created_at,
        });
      }
    }

    res.json(missions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/missions/:threadId", async (req, res) => {
  try {
    const graph = await getGraphApp();
    const config = { configurable: { thread_id: req.params.threadId } };
    const state = await graph.getState(config);
    res.json(state);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/missions/:threadId/resume", async (req, res) => {
  try {
    const graph = await getGraphApp();
    const config = { configurable: { thread_id: req.params.threadId } };
    const result = await graph.invoke(null, config);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/missions/:threadId", async (req, res) => {
  try {
    const graph = await getGraphApp();
    const checkpointer = (graph as any).checkpointer;
    await checkpointer.deleteThread(req.params.threadId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint
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
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`
  📝 Test Commands:
  
  # Test model:
  curl -X POST http://localhost:${PORT}/api/test \\
    -H "Content-Type: application/json" \\
    -d '{"query": "Say hello"}'
  
  # Run mission:
  curl -X POST http://localhost:${PORT}/api/mission \\
    -H "Content-Type: application/json" \\
    -d '{"query": "What is the capital of France?", "threadId": "test-123"}'
  `);
});
