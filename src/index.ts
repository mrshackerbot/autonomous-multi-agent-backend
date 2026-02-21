import { StateGraph, END, START, Annotation } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOllama } from "@langchain/ollama";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { WikipediaQueryRun } from "@langchain/community/tools/wikipedia_query_run";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { Calculator } from "@langchain/community/tools/calculator";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import pino from "pino";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

const logger = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// --- 1. MODEL SETUP ---
const heavyModel = new ChatOllama({
  model: "deepseek-v3.1:671b-cloud",
  temperature: 0,
});

// const mediumModel = new ChatOllama({
//   model: "qwen3.5:cloud",
//   temperature: 0.2,
// });

const fastModel = new ChatOllama({
  model: "qwen3.5:cloud",
  temperature: 0.3,
});

// --- 2. ADVANCED TOOL SETUP ---

// Basic tools
const wikipedia = new WikipediaQueryRun({ maxDocContentLength: 4000 });
const search = new DuckDuckGoSearch({ maxResults: 5 });
const calculator = new Calculator();

// SQL Query Tool
class SQLQueryTool {
  private dbPath: string;

  constructor(dbPath: string = "./data.db") {
    this.dbPath = dbPath;
  }

  async invoke(query: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(
        `sqlite3 ${this.dbPath} "${query}"`,
      );
      if (stderr) throw new Error(stderr);
      return stdout || "Query executed successfully";
    } catch (error: any) {
      return `SQL Error: ${error.message}`;
    }
  }
}

// Web Scraper Tool
class WebScraperTool {
  async invoke(url: string): Promise<string> {
    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AgentBot/1.0)",
        },
      });
      const $ = cheerio.load(response.data);

      $("script").remove();
      $("style").remove();
      $("nav").remove();
      $("footer").remove();

      const title = $("title").text();
      const body = $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 5000);

      return `Title: ${title}\n\nContent: ${body}`;
    } catch (error: any) {
      return `Scraping error: ${error.message}`;
    }
  }
}

// Code Interpreter Tool
class CodeInterpreterTool {
  async invoke(code: string): Promise<string> {
    try {
      const tempFile = path.join("/tmp", `code-${Date.now()}.js`);
      await fs.writeFile(tempFile, code);

      const { stdout, stderr } = await execAsync(`node ${tempFile}`, {
        timeout: 5000,
      });

      await fs.unlink(tempFile).catch(() => {});

      if (stderr) return `Error: ${stderr}`;
      return stdout || "Code executed successfully (no output)";
    } catch (error: any) {
      return `Execution error: ${error.message}`;
    }
  }
}

// File System Tool
class FileSystemTool {
  async invoke({
    operation,
    path,
    content,
  }: {
    operation: string;
    path: string;
    content?: string;
  }): Promise<string> {
    try {
      switch (operation) {
        case "read":
          const data = await fs.readFile(path, "utf-8");
          return data;
        case "write":
          await fs.writeFile(path, content || "");
          return `File written: ${path}`;
        case "list":
          const files = await fs.readdir(path);
          return files.join("\n");
        default:
          return `Unknown operation: ${operation}`;
      }
    } catch (error: any) {
      return `File system error: ${error.message}`;
    }
  }
}

// Vector Store for Memory
class MemoryVectorStore {
  private vectorStore: Chroma | null = null;
  private collectionName: string;

  constructor(collectionName: string = "agent_memory") {
    this.collectionName = collectionName;
    this.init().catch(console.error);
  }

  async init() {
    try {
      this.vectorStore = new Chroma(
        new OpenAIEmbeddings({
          batchSize: 512,
          model: "text-embedding-ada-002",
        }),
        {
          collectionName: this.collectionName,
          url: "http://localhost:8000",
        },
      );
    } catch (error) {
      logger.warn("ChromaDB not available, memory will be disabled");
    }
  }

  async addMemory(text: string, metadata: any = {}) {
    if (!this.vectorStore) return "Memory store not available";

    try {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });

      const docs = await splitter.splitDocuments([
        new Document({ pageContent: text, metadata }),
      ]);

      await this.vectorStore.addDocuments(docs);
      return "Memory stored";
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to store memory");
      return `Memory storage failed: ${error.message}`;
    }
  }

  async recall(query: string, k: number = 5): Promise<string> {
    if (!this.vectorStore) return "Memory store not available";

    try {
      const results = await this.vectorStore.similaritySearch(query, k);
      return results.map((doc) => doc.pageContent).join("\n---\n");
    } catch (error: any) {
      return `Memory recall failed: ${error.message}`;
    }
  }
}

// Initialize tools
const sqlTool = new SQLQueryTool();
const scraperTool = new WebScraperTool();
const codeTool = new CodeInterpreterTool();
const fileTool = new FileSystemTool();
const memoryStore = new MemoryVectorStore();

// --- 3. DEFINE STATE USING ANNOTATION (CORRECT WAY) ---
const GraphState = Annotation.Root({
  input: Annotation<string>(),
  output: Annotation<string>(),
  steps: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  research: Annotation<string>(),
  plan: Annotation<any>(),
  critiqueResult: Annotation<any>(),
  iteration: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),
  memories: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  tools: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  threadId: Annotation<string>(),
  timestamp: Annotation<string>(),
});

// --- 4. MEMORY RECALL NODE ---
const memoryRecallNode = async (state: typeof GraphState.State) => {
  logger.info({ threadId: state.threadId }, "💭 Recalling memories");

  try {
    const memories = await memoryStore.recall(state.input, 3);

    return {
      memories: [memories],
      steps: [`Recalled relevant memories`],
    };
  } catch (error: any) {
    return {
      steps: [`Memory recall failed: ${error.message}`],
    };
  }
};

// --- 5. PLANNER NODE ---
const taskPlannerNode = async (state: typeof GraphState.State) => {
  logger.info({ input: state.input, threadId: state.threadId }, "📋 Planning");

  const prompt = ChatPromptTemplate.fromTemplate(`
    You are a strategic planner. Create a plan for: {input}
    
    Available tools: wikipedia, search, calculator, sql, scraper, code, file
    
    Previous steps: {steps}
    Current iteration: {iteration}
    
    Return a JSON object with:
    - tasks: array of task objects (each with role, goal, tools array)
    - reasoning: explanation of your plan
  `);

  try {
    const chain = prompt.pipe(heavyModel).pipe(new StringOutputParser());
    const result = await chain.invoke({
      input: state.input,
      steps: state.steps?.join("\n") || "None",
      iteration: state.iteration || 0,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const plan = JSON.parse(jsonMatch[0]);

    console.log("📋 Generated Plan:", JSON.stringify(plan, null, 2));
    return {
      plan,
      steps: [`Plan: ${plan.reasoning}`],
      iteration: (state.iteration || 0) + 1,
    };
  } catch (error: any) {
    logger.error({ error: error.message }, "❌ Planning failed");
    return {
      steps: [`Planning error: ${error.message}`],
    };
  }
};

// --- 6. EXECUTOR NODE ---
const taskExecutorNode = async (state: typeof GraphState.State) => {
  logger.info({ threadId: state.threadId }, "🔧 Executing tasks");

  const results: string[] = [];

  if (!state.plan?.tasks) {
    return {
      steps: ["No tasks to execute"],
    };
  }

  for (const task of state.plan.tasks) {
    logger.info({ task: task.role }, `Executing: ${task.goal}`);

    const prompt = ChatPromptTemplate.fromTemplate(`
      You are a ${task.role}. Goal: {goal}
      
      Available tools: {tools}
      
      Complete your goal. Provide a clear result.
    `);

    try {
      const chain = prompt.pipe(fastModel).pipe(new StringOutputParser());
      const result = await chain.invoke({
        goal: task.goal,
        tools: task.tools?.join(", ") || "none",
      });

      console.log(`🔧 [${task.role}] Result:`, result);

      results.push(`[${task.role}]: ${result}`);
    } catch (error: any) {
      results.push(`[${task.role} Error]: ${error.message}`);
    }
  }

  return {
    research: results.join("\n\n"),
    steps: [`Executed ${state.plan.tasks.length} tasks`],
  };
};

// --- 7. CRITIQUE NODE ---
const resultCritiqueNode = async (state: typeof GraphState.State) => {
  logger.info({ threadId: state.threadId }, "🔍 Critiquing results");

  const prompt = ChatPromptTemplate.fromTemplate(`
    You are a critic. Evaluate this result:
    
    Original query: {query}
    Results: {results}
    
    Return a JSON object with:
    - score: 0-100
    - issues: array of problems found
    - suggestions: how to improve
    - needsRevision: boolean
  `);

  try {
    const chain = prompt.pipe(heavyModel).pipe(new StringOutputParser());
    const result = await chain.invoke({
      query: state.input,
      results: state.research || "No results",
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in critique");

    const critique = JSON.parse(jsonMatch[0]);

    console.log("🔍 Critique Result:", critique);

    return {
      critiqueResult: critique,
      steps: [
        `Critique score: ${critique.score}/100`,
        `Issues: ${critique.issues?.join(", ") || "None"}`,
      ],
    };
  } catch (error: any) {
    return {
      critiqueResult: { needsRevision: false, score: 100 },
      steps: [`Critique failed: ${error.message}`],
    };
  }
};

// --- 8. REVISION NODE ---
const revisionNode = async (state: typeof GraphState.State) => {
  if (!state.critiqueResult?.needsRevision || state.iteration > 3) {
    return {};
  }

  logger.info(
    { threadId: state.threadId, iteration: state.iteration },
    "🔄 Revising",
  );

  const prompt = ChatPromptTemplate.fromTemplate(`
    Improve this result based on critique:
    
    Original query: {query}
    Current result: {result}
    Critique: {critique}
    Suggestions: {suggestions}
    
    Provide an improved version.
  `);

  try {
    const chain = prompt.pipe(heavyModel).pipe(new StringOutputParser());
    const improved = await chain.invoke({
      query: state.input,
      result: state.research,
      critique: state.critiqueResult.issues?.join(", ") || "No specific issues",
      suggestions: state.critiqueResult.suggestions || "No suggestions",
    });

    console.log("🔄 Revision Result:", improved);

    return {
      output: improved,
      steps: ["Revised based on critique"],
    };
  } catch (error: any) {
    return {
      steps: [`Revision failed: ${error.message}`],
    };
  }
};

// --- 9. BUILD GRAPH ---
const builder = new StateGraph(GraphState)
  .addNode("memoryRecall", memoryRecallNode)
  .addNode("taskPlanner", taskPlannerNode)
  .addNode("taskExecutor", taskExecutorNode)
  .addNode("resultCritique", resultCritiqueNode)
  .addNode("revision", revisionNode)
  .addEdge(START, "memoryRecall")
  .addEdge("memoryRecall", "taskPlanner")
  .addEdge("taskPlanner", "taskExecutor")
  .addEdge("taskExecutor", "resultCritique")
  .addConditionalEdges("resultCritique", (state) => {
    if (state.critiqueResult?.needsRevision && (state.iteration || 0) < 3) {
      return "revision";
    }
    return "revision";
  })
  .addConditionalEdges("revision", (state) => {
    if (state.critiqueResult?.needsRevision && (state.iteration || 0) < 3) {
      return "taskExecutor";
    }
    return END;
  });

// --- 10. EXPORT WITH CHECKPOINTING ---
let graph: any = null;

export const getGraphApp = async () => {
  if (!graph) {
    try {
      const checkpointer = SqliteSaver.fromConnString("./checkpoints.db");
      graph = builder.compile({ checkpointer });
      logger.info("✅ Graph ready");
    } catch (error: any) {
      logger.error({ error: error.message }, "❌ Graph init failed");
      throw error;
    }
  }
  return graph;
};

export { sqlTool, scraperTool, codeTool, fileTool, memoryStore };
