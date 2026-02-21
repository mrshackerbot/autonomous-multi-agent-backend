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
import { config } from "./config.js";

const execAsync = promisify(exec);

// Initialize logger
const logger = pino({
  level: config.logging.level,
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// --- 1. MODEL SETUP ---
const heavyModel = new ChatOllama({
  baseUrl: config.ollama.baseUrl,
  model: config.ollama.models.heavy,
  temperature: 0,
  format: "json",
});

const fastModel = new ChatOllama({
  baseUrl: config.ollama.baseUrl,
  model: config.ollama.models.fast,
  temperature: 0.3,
  format: "json",
});

// --- 2. ADVANCED TOOL SETUP ---

// Basic tools
const wikipedia = new WikipediaQueryRun({
  maxDocContentLength: 4000,
});

const search = new DuckDuckGoSearch({
  maxResults: 5,
});

const calculator = new Calculator();

// SQL Query Tool
class SQLQueryTool {
  private dbPath: string;

  constructor(dbPath: string = config.database.dataPath) {
    this.dbPath = dbPath;
  }

  async invoke(query: string): Promise<string> {
    try {
      // Sanitize query to prevent injection (basic)
      if (
        query.toLowerCase().includes("drop") ||
        query.toLowerCase().includes("delete")
      ) {
        return "Destructive queries are not allowed";
      }

      const { stdout, stderr } = await execAsync(
        `sqlite3 ${this.dbPath} "${query}"`,
      );
      if (stderr) throw new Error(stderr);
      return stdout || "Query executed successfully";
    } catch (error: any) {
      logger.error({ error: error.message, query }, "SQL query failed");
      return `SQL Error: ${error.message}`;
    }
  }
}

// Web Scraper Tool
class WebScraperTool {
  async invoke(url: string): Promise<string> {
    try {
      // Validate URL
      new URL(url);

      const response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AgentBot/1.0)",
          Accept: "text/html",
        },
        timeout: 10000,
      });

      const $ = cheerio.load(response.data);

      // Remove unwanted elements
      $("script").remove();
      $("style").remove();
      $("nav").remove();
      $("footer").remove();
      $("iframe").remove();

      // Extract main content
      const title = $("title").text();
      const metaDescription =
        $('meta[name="description"]').attr("content") || "";
      const body = $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 5000);

      return `Title: ${title}\nDescription: ${metaDescription}\n\nContent: ${body}`;
    } catch (error: any) {
      logger.error({ error: error.message, url }, "Scraping failed");
      return `Scraping error: ${error.message}`;
    }
  }
}

// Code Interpreter Tool
class CodeInterpreterTool {
  async invoke(code: string): Promise<string> {
    // Security: Prevent dangerous operations
    const dangerousPatterns = [
      /require\(['"]fs['"]\)/,
      /process\./,
      /__dirname/,
      /__filename/,
      /eval\(/,
      /Function\(/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(code)) {
        return "Code contains prohibited operations";
      }
    }

    try {
      const tempFile = path.join(
        "/tmp",
        `code-${Date.now()}-${Math.random()}.js`,
      );
      await fs.writeFile(tempFile, code);

      const { stdout, stderr } = await execAsync(`node ${tempFile}`, {
        timeout: 5000,
        maxBuffer: 1024 * 1024, // 1MB
      });

      // Cleanup
      await fs.unlink(tempFile).catch(() => {});

      if (stderr) return `Error: ${stderr}`;
      return stdout || "Code executed successfully (no output)";
    } catch (error: any) {
      logger.error({ error: error.message }, "Code execution failed");
      return `Execution error: ${error.message}`;
    }
  }
}

// File System Tool
class FileSystemTool {
  private basePath: string;

  constructor(basePath: string = "./data") {
    this.basePath = basePath;
    // Ensure base path exists
    fs.mkdir(this.basePath, { recursive: true }).catch(() => {});
  }

  async invoke({
    operation,
    path: filePath,
    content,
  }: {
    operation: string;
    path: string;
    content?: string;
  }): Promise<string> {
    // Security: Prevent directory traversal
    const safePath = path.join(this.basePath, path.basename(filePath));
    console.log(
      { operation, filePath, safePath },
      "File system operation requested",
    );

    try {
      switch (operation) {
        case "read":
          const data = await fs.readFile(safePath, "utf-8");
          return data;
        case "write":
          await fs.writeFile(safePath, content || "");
          return `File written: ${path.basename(filePath)}`;
        case "list":
          const files = await fs.readdir(this.basePath);
          return files.join("\n");
        case "delete":
          await fs.unlink(safePath);
          return `File deleted: ${path.basename(filePath)}`;
        default:
          return `Unknown operation: ${operation}`;
      }
    } catch (error: any) {
      logger.error(
        { error: error.message, operation, filePath },
        "File operation failed",
      );
      return `File system error: ${error.message}`;
    }
  }
}

// Vector Store for Memory
class MemoryVectorStore {
  private vectorStore: Chroma | null = null;
  private collectionName: string;
  private initialized: boolean = false;

  constructor(collectionName: string = "agent_memory") {
    this.collectionName = collectionName;
    this.init().catch(() => {
      logger.warn("ChromaDB not available, memory will be disabled");
    });
  }

  async init() {
    if (this.initialized) return;

    try {
      this.vectorStore = new Chroma(
        new OpenAIEmbeddings({
          batchSize: 512,
          model: "text-embedding-ada-002",
        }),
        {
          collectionName: this.collectionName,
          url: config.chroma.url,
        },
      );
      this.initialized = true;
      logger.info("✅ Memory store initialized");
    } catch (error) {
      logger.warn("ChromaDB not available, memory will be disabled");
    }
  }

  async addMemory(text: string, metadata: any = {}): Promise<string> {
    if (!this.initialized || !this.vectorStore) {
      return "Memory store not available";
    }

    try {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });

      const docs = await splitter.splitDocuments([
        new Document({
          pageContent: text,
          metadata: { ...metadata, timestamp: new Date().toISOString() },
        }),
      ]);

      console.log({ docs }, "Adding memory documents");

      await this.vectorStore.addDocuments(docs);
      return "Memory stored successfully";
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to store memory");
      return `Memory storage failed: ${error.message}`;
    }
  }

  async recall(query: string, k: number = 5): Promise<string> {
    if (!this.initialized || !this.vectorStore) {
      return "Memory store not available";
    }

    try {
      const results = await this.vectorStore.similaritySearch(query, k);
      if (results.length === 0) {
        return "No relevant memories found";
      }
      console.log({ results }, "Recalled memories");
      return results.map((doc) => doc.pageContent).join("\n---\n");
    } catch (error: any) {
      logger.error({ error: error.message }, "Memory recall failed");
      return `Memory recall failed: ${error.message}`;
    }
  }
}

// Initialize tools
export const sqlTool = new SQLQueryTool();
export const scraperTool = new WebScraperTool();
export const codeTool = new CodeInterpreterTool();
export const fileTool = new FileSystemTool();
export const memoryStore = new MemoryVectorStore();

// Tool registry for easy access
const toolRegistry = {
  wikipedia,
  search,
  calculator,
  sql: sqlTool,
  scraper: scraperTool,
  code: codeTool,
  file: fileTool,
};

// --- 3. DEFINE STATE USING ANNOTATION ---
const GraphState = Annotation.Root({
  input: Annotation<string>(),
  output: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  steps: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  research: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  plan: Annotation<any>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  critiqueResult: Annotation<any>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
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
  threadId: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  timestamp: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => new Date().toISOString(),
  }),
});

type GraphStateType = typeof GraphState.State;

// --- 4. MEMORY RECALL NODE ---
const memoryRecallNode = async (state: GraphStateType) => {
  logger.info({ threadId: state.threadId }, "💭 Recalling memories");

  try {
    const memories = await memoryStore.recall(state.input, 3);
    console.log({ memories }, "Recalled memories for mission");
    return {
      memories: [memories],
      steps: [`Recalled relevant memories`],
    };
  } catch (error: any) {
    logger.error({ error: error.message }, "Memory recall failed");
    return {
      steps: [`Memory recall failed: ${error.message}`],
    };
  }
};

// --- 5. PLANNER NODE ---
const taskPlannerNode = async (state: GraphStateType) => {
  logger.info({ input: state.input, threadId: state.threadId }, "📋 Planning");

  const schema = z.object({
    tasks: z.array(
      z.object({
        role: z.string(),
        goal: z.string(),
        tools: z.array(z.string()),
        dependsOn: z.array(z.string()).optional(),
      }),
    ),
    reasoning: z.string(),
  });

  const prompt = ChatPromptTemplate.fromTemplate(`
    You are a strategic planner. Create a plan for: {input}
    
    Available tools: wikipedia, search, calculator, sql, scraper, code, file
    
    Previous steps: {steps}
    Current iteration: {iteration}
    Memories: {memories}
    
    Return a JSON object with:
    - tasks: array of task objects (each with role, goal, tools array, optional dependsOn)
    - reasoning: explanation of your plan
    
    Example:
    {{
      "tasks": [
        {{
          "role": "Researcher",
          "goal": "Find information about X",
          "tools": ["search", "wikipedia"]
        }}
      ],
      "reasoning": "First we need to research X"
    }}
  `);

  try {
    const chain = prompt.pipe(heavyModel).pipe(new StringOutputParser());
    console.log(
      { promptInput: { ...state, steps: state.steps.slice(-5) } },
      "Planner input",
    );
    const result = await chain.invoke({
      input: state.input,
      steps: state.steps?.join("\n") || "None",
      iteration: state.iteration || 0,
      memories: state.memories?.join("\n") || "No memories",
    });
    console.log({ plannerResult: result }, "Planner output");
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const plan = JSON.parse(jsonMatch[0]);
    const validated = schema.parse(plan);

    console.log({ validated }, "Validated plan");

    return {
      plan: validated,
      steps: [`Plan: ${validated.reasoning}`],
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
const taskExecutorNode = async (state: GraphStateType) => {
  logger.info({ threadId: state.threadId }, "🔧 Executing tasks");

  const results: string[] = [];

  if (!state.plan?.tasks || state.plan.tasks.length === 0) {
    return {
      steps: ["No tasks to execute"],
    };
  }

  // Sort tasks by dependencies (simple topological sort)
  const tasks = [...state.plan.tasks];
  const executed = new Set();
  const taskResults = new Map();

  while (tasks.length > 0) {
    const task = tasks.shift();
    if (!task) continue;

    // Check dependencies
    const dependencies = task.dependsOn || [];
    const depsMet = dependencies.every((dep) => executed.has(dep));

    if (!depsMet) {
      // Requeue
      tasks.push(task);
      continue;
    }

    logger.info(
      { task: task.role, tools: task.tools },
      `Executing: ${task.goal}`,
    );

    // Prepare tool descriptions for the agent
    const availableTools = (task.tools || [])
      .map((toolName: string) => {
        const tool = toolRegistry[toolName as keyof typeof toolRegistry];
        return tool ? `- ${toolName}: Available` : null;
      })
      .filter(Boolean)
      .join("\n");

    const prompt = ChatPromptTemplate.fromTemplate(`
      You are a ${task.role}. Your goal: {goal}
      
      Available tools:
      {availableTools}
      
      Previous results:
      {results}
      
      To use a tool, respond with:
      TOOL: tool_name
      ARGS: arguments for the tool
      
      Then wait for the tool result. When you have your final answer, respond with:
      FINAL: your answer
      
      Complete your goal step by step.
    `);

    try {
      let finalResult = "";
      let toolCalls = 0;
      const maxToolCalls = 5;

      while (toolCalls < maxToolCalls) {
        const chain = prompt.pipe(fastModel).pipe(new StringOutputParser());
        const response = await chain.invoke({
          goal: task.goal,
          availableTools: availableTools || "No tools available",
          results: Array.from(taskResults.values()).join("\n"),
        });

        // Check if agent wants to use a tool
        const toolMatch = response.match(/TOOL:\s*(\w+)\s*\nARGS:\s*(.+)/i);
        if (toolMatch && task.tools?.includes(toolMatch[1])) {
          const toolName = toolMatch[1].toLowerCase();
          const toolArgs = toolMatch[2].trim();

          logger.info({ tool: toolName, args: toolArgs }, "🔧 Using tool");

          // Execute the tool
          const tool = toolRegistry[toolName as keyof typeof toolRegistry];
          if (tool) {
            try {
              let toolResult;
              if (toolName === "sql") {
                toolResult = await (tool as SQLQueryTool).invoke(toolArgs);
              } else if (toolName === "scraper") {
                toolResult = await (tool as WebScraperTool).invoke(toolArgs);
              } else if (toolName === "code") {
                toolResult = await (tool as CodeInterpreterTool).invoke(
                  toolArgs,
                );
              } else if (toolName === "file") {
                // Parse file args (simplified)
                const [operation, filePath, content] = toolArgs
                  .split("|")
                  .map((s) => s.trim());
                toolResult = await (tool as FileSystemTool).invoke({
                  operation,
                  path: filePath,
                  content,
                });
              } else if (toolName === "wikipedia") {
                toolResult = await (tool as WikipediaQueryRun).invoke(toolArgs);
              } else if (toolName === "search") {
                toolResult = await (tool as DuckDuckGoSearch).invoke(toolArgs);
              } else if (toolName === "calculator") {
                toolResult = await (tool as Calculator).invoke(toolArgs);
              } else {
                toolResult = "Tool not implemented";
              }

              // Add tool result to context
              taskResults.set(
                `tool_${toolCalls}`,
                `Tool ${toolName} result: ${toolResult}`,
              );
            } catch (error: any) {
              taskResults.set(
                `tool_${toolCalls}`,
                `Tool ${toolName} error: ${error.message}`,
              );
            }
          }
          toolCalls++;
        }
        // Check if agent has final answer
        else if (response.includes("FINAL:")) {
          finalResult = response.replace(/FINAL:/i, "").trim();
          break;
        }
        // If no tool call and no final, treat as final
        else {
          finalResult = response;
          break;
        }
      }

      const resultStr = `[${task.role}]: ${finalResult || "Task completed"}`;
      results.push(resultStr);
      taskResults.set(task.role, resultStr);
      executed.add(task.role);

      // Store in memory if it's a significant result
      if (finalResult.length > 50) {
        await memoryStore
          .addMemory(finalResult, {
            task: task.role,
            goal: task.goal,
            threadId: state.threadId,
          })
          .catch(() => {});
      }
    } catch (error: any) {
      const errorStr = `[${task.role} Error]: ${error.message}`;
      results.push(errorStr);
      taskResults.set(task.role, errorStr);
      executed.add(task.role);
    }
  }

  return {
    research: results.join("\n\n"),
    steps: [`Executed ${state.plan.tasks.length} tasks`],
  };
};

// --- 7. CRITIQUE NODE ---
const resultCritiqueNode = async (state: GraphStateType) => {
  logger.info({ threadId: state.threadId }, "🔍 Critiquing results");

  const schema = z.object({
    score: z.number().min(0).max(100),
    issues: z.array(z.string()),
    suggestions: z.string(),
    needsRevision: z.boolean(),
  });

  const prompt = ChatPromptTemplate.fromTemplate(`
    You are a critic. Evaluate this result:
    
    Original query: {query}
    Results: {results}
    
    Return a JSON object with:
    - score: 0-100
    - issues: array of problems found
    - suggestions: how to improve
    - needsRevision: boolean (true if score < 80 or critical issues)
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
    const validated = schema.parse(critique);

    console.log({ validated }, "Validated critique");

    return {
      critiqueResult: validated,
      steps: [
        `Critique score: ${validated.score}/100`,
        `Issues: ${validated.issues?.join(", ") || "None"}`,
      ],
    };
  } catch (error: any) {
    logger.error({ error: error.message }, "Critique failed");
    return {
      critiqueResult: {
        needsRevision: false,
        score: 100,
        issues: [],
        suggestions: "",
      },
      steps: [`Critique failed: ${error.message}`],
    };
  }
};

// --- 8. REVISION NODE ---
const revisionNode = async (state: GraphStateType) => {
  if (!state.critiqueResult?.needsRevision || state.iteration >= 3) {
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
    Issues: {issues}
    Suggestions: {suggestions}
    
    Provide an improved version that addresses all issues.
    Be specific and detailed.
  `);

  try {
    const chain = prompt.pipe(heavyModel).pipe(new StringOutputParser());
    const improved = await chain.invoke({
      query: state.input,
      result: state.research,
      issues: state.critiqueResult.issues?.join(", ") || "No specific issues",
      suggestions: state.critiqueResult.suggestions || "No suggestions",
    });

    console.log({ improved }, "Improved result");

    return {
      research: improved,
      steps: ["Revised based on critique"],
    };
  } catch (error: any) {
    logger.error({ error: error.message }, "Revision failed");
    return {
      steps: [`Revision failed: ${error.message}`],
    };
  }
};

// --- 9. FINAL ANSWER NODE ---
const finalAnswerNode = async (state: GraphStateType) => {
  logger.info({ threadId: state.threadId }, "📝 Generating final answer");

  const prompt = ChatPromptTemplate.fromTemplate(`
    Synthesize the following information into a clear, comprehensive answer:
    
    Original query: {query}
    Research results: {research}
    Critique: {critique}
    
    Provide a well-structured answer that directly addresses the query.
  `);

  try {
    const chain = prompt.pipe(heavyModel).pipe(new StringOutputParser());
    const answer = await chain.invoke({
      query: state.input,
      research: state.research || "No research available",
      critique: state.critiqueResult
        ? JSON.stringify(state.critiqueResult)
        : "No critique",
    });

    console.log({ answer }, "Final answer generated");

    return {
      output: answer,
      steps: ["Generated final answer"],
    };
  } catch (error: any) {
    logger.error({ error: error.message }, "Final answer generation failed");
    return {
      output: state.research || "Failed to generate answer",
      steps: [`Final answer failed: ${error.message}`],
    };
  }
};

// --- 10. BUILD GRAPH ---
const builder = new StateGraph(GraphState)
  .addNode("memoryRecall", memoryRecallNode)
  .addNode("taskPlanner", taskPlannerNode)
  .addNode("taskExecutor", taskExecutorNode)
  .addNode("resultCritique", resultCritiqueNode)
  .addNode("revision", revisionNode)
  .addNode("finalAnswer", finalAnswerNode)

  // Define edges
  .addEdge(START, "memoryRecall")
  .addEdge("memoryRecall", "taskPlanner")
  .addEdge("taskPlanner", "taskExecutor")
  .addEdge("taskExecutor", "resultCritique")

  // Conditional edges based on critique
  .addConditionalEdges("resultCritique", (state) => {
    if (state.critiqueResult?.needsRevision && (state.iteration || 0) < 3) {
      return "revision";
    }
    return "finalAnswer";
  })

  // Revision can go back to executor or to final answer
  .addConditionalEdges("revision", (state) => {
    if (state.critiqueResult?.needsRevision && (state.iteration || 0) < 3) {
      return "taskExecutor";
    }
    return "finalAnswer";
  })

  .addEdge("finalAnswer", END);

// --- 11. EXPORT WITH CHECKPOINTING ---
let graph: any = null;

export const getGraphApp = async () => {
  if (!graph) {
    try {
      // Initialize SQLite checkpointer
      const checkpointer = SqliteSaver.fromConnString(
        config.database.checkpointPath,
      );

      // Compile graph with checkpointer
      graph = builder.compile({
        checkpointer,
      });

      // Verify the graph has the expected methods
      logger.info("✅ Graph compiled successfully");
      logger.info(`📊 Graph methods: ${Object.keys(graph).join(", ")}`);

      // Test checkpointing by getting state (don't use checkpoint method)
      const testConfig = { configurable: { thread_id: "test-init" } };
      try {
        // This should work if checkpointer is properly integrated
        await graph.getState(testConfig);
        logger.info("✅ Checkpointer initialized");
      } catch (stateError) {
        logger.warn("⚠️  Checkpointer test failed, but graph may still work");
      }
    } catch (error: any) {
      logger.error({ error: error.message }, "❌ Graph compilation failed");
      throw error;
    }
  }
  return graph;
};

// Export tool functions for external use
export const tools = {
  sql: (query: string) => sqlTool.invoke(query),
  scrape: (url: string) => scraperTool.invoke(url),
  code: (code: string) => codeTool.invoke(code),
  file: (operation: string, path: string, content?: string) =>
    fileTool.invoke({ operation, path, content }),
  memory: {
    add: (text: string, metadata?: any) =>
      memoryStore.addMemory(text, metadata),
    recall: (query: string, k?: number) => memoryStore.recall(query, k),
  },
  wikipedia: (query: string) => wikipedia.invoke(query),
  search: (query: string) => search.invoke(query),
  calculator: (expr: string) => calculator.invoke(expr),
};
