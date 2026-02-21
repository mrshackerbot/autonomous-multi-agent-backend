import {
  Annotation,
  StateGraph,
  START,
  END,
  Command,
  Send,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOllama } from "@langchain/ollama";
import { Agent, Team, Task } from "kaibanjs";
import { WikipediaQueryRun } from "@langchain/community/tools/wikipedia_query_run";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { Calculator } from "@langchain/community/tools/calculator";
import { z } from "zod";

// Define the policy: retry on any error, up to 3 times
const retryPolicy = {
  maxAttempts: 3,
  backoffType: "exponential" as const,
  initialIntervalMs: 1000,
};

/**
 * Helper to extract JSON from LLM chatter.
 * Finds the first '{' and the last '}' and parses only that content.
 */
function extractJSON(content: string) {
  console.log("Raw LLM Response:", content);
  try {
    // 1. Try direct parse first
    return JSON.parse(content);
  } catch {
    // 2. If it fails, find the JSON block inside the text
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (innerError) {
        throw new Error(`Failed to parse extracted JSON: ${innerError}`);
      }
    }
    throw new Error(`No JSON block found in LLM response: ${content}`);
  }
}

// --- 1. MODEL REGISTRY WITH FALLBACKS ---
const heavyModel = new ChatOllama({
  model: "deepseek-v3.1:671b-cloud",
  format: "json",
  temperature: 0,
}).withRetry({
  stopAfterAttempt: 3, // Try 3 times
});

const balancedModel = new ChatOllama({
  model: "deepseek-coder:1.3b ",
  format: "json",
  temperature: 0,
});

// Fused Commander: Automatically tries 8b if 70b fails/OOMs
const resilientCommander = heavyModel.withFallbacks({
  fallbacks: [balancedModel],
});

const workerModel = new ChatOllama({
  model: "phi:latest",
  format: "json", // <--- Forces Ollama to attempt JSON-only output
  temperature: 0.2,
});

// --- 2. DYNAMIC TOOL REGISTRY ---
const TOOL_LIBRARY: Record<string, any> = {
  wiki_search: new WikipediaQueryRun(),
  math_solver: new Calculator(),
  duckduckgo_search: new DuckDuckGoSearch({ maxResults: 3 }),
};

// --- 3. STATE DEFINITION (The Memory) ---
export const StateAnnotation = Annotation.Root({
  input: Annotation<string>(),
  results: Annotation<string[]>({
    reducer: (x: any, y: any) => x.concat(y),
    default: () => [],
  }),
  logs: Annotation<string[]>({
    reducer: (x: any, y: any) => x.concat(y),
    default: () => [],
  }),
});

// --- 4. DYNAMIC SUPERVISOR (The Planner) ---
const supervisor = async (state: typeof StateAnnotation.State) => {
  const schema = z.object({
    tasks: z.array(
      z.object({
        role: z.string(),
        goal: z.string(),
        tools: z.array(z.string()),
        tier: z.enum(["specialist", "extractor"]),
      }),
    ),
  });

  const toolList = Object.keys(TOOL_LIBRARY).join(", ");
  const dynamicPrompt = `
    You are a Mission Commander. Analyze: "${state.input}"
    Available Tools: [${toolList}]
    Model Tiers: [specialist (reasoning), extractor (data cleanup)]
    
    Return JSON: { "tasks": [{ "role": "...", "goal": "...", "tools": ["..."], "tier": "specialist" }] }
  `;

  console.log("Supervisor Prompt:", dynamicPrompt);

  const response = await resilientCommander.invoke(dynamicPrompt);

  // FIXED: Clean the content before parsing with Zod
  const rawContent = response.content as string;

  console.log("Supervisor Response rawContent:", rawContent);

  const cleanedData = extractJSON(rawContent);

  console.log("Supervisor Response cleanedData:", cleanedData);

  const { tasks } = schema.parse(cleanedData);

  // FIXED: Return a Command to manage the dynamic goto
  return new Command({
    goto: tasks.map((t) => new Send("worker_node", t)),
  });
};

// --- 5. WORKER NODE (The Fusion Engine) ---
const worker_node = async (task: {
  role: string;
  goal: string;
  tools: string[];
  tier: string;
}) => {
  // Defensive check: ensure 'tools' exists before calling .map()
  if (!task || !task.tools) {
    console.error("Worker received invalid task:", task);
    return { results: ["Error: Task or tools undefined"] };
  }

  // Now task.tools.map(...) will work because 'task' is the direct input
  const selectedTools = task.tools
    .map((name) => TOOL_LIBRARY[name])
    .filter(Boolean);

  console.log(
    `Worker Node "${task.role}" executing with tools: [${task.tools.join(", ")}] and goal: "${task.goal}"`,
  );

  const agent = new Agent({
    name: task.role.replace(/\s+/g, "_"),
    role: task.role,
    goal: task.goal,
    llmConfig: {
      provider: "ollama",
      model: "deepseek-v3.1:671b-cloud",
      apiKey: process.env.OPENAI_API_KEY || "local-ollama-dummy-key",
    },
    tools: selectedTools,
    background: `You are a ${task.tier} agent. Focus on ${task.tier === "specialist" ? "reasoning and problem-solving" : "data extraction and cleanup"}. Use your tools wisely to achieve the goal: "${task.goal}". Always think step-by-step and log your thoughts.`,
  });

  console.log(
    `Worker Node Activated: ${task.role} with tools [${task.tools.join(", ")}]`,
  );

  const team = new Team({
    name: `${task.role}_team`,
    agents: [agent],
    tasks: [
      new Task({
        description: task.goal,
        agent,
        expectedOutput: "final answer",
      }),
    ],
  });

  console.log(
    `Starting team for task: "${task.goal}" with role "${task.role}"`,
  );

  const output = await team.start();
  return { results: [output] };
};

// --- 6. PERSISTENCE & COMPILATION ---
const checkpointer: any = SqliteSaver.fromConnString("./checkpoints.db");
const workflow = new StateGraph(StateAnnotation)
  /**
   * 1. Define Nodes
   * In v0.2+, the 'ends' array in addNode is largely deprecated for routing.
   * Nodes are now added directly; routing is handled by Command or edges.
   */
  .addNode("supervisor", supervisor)
  .addNode("worker_node", worker_node)

  /**
   * 2. Define Edges
   * Entry point to the supervisor.
   */
  .addEdge(START, "supervisor")

  /**
   * 3. Define the Dynamic Path
   * Since 'supervisor' uses 'Send' or 'Command' to spawn 'worker_node',
   * you should use a conditional edge to link them for static analysis.
   */
  .addConditionalEdges("supervisor", (state) => {
    // This function returns the next node(s).
    // If your supervisor returns a Command({ goto: ... }),
    // the graph engine uses this mapping to validate 'worker_node' is reachable.
    return ["worker_node"];
  })

  /**
   * 4. Termination
   * Worker nodes return to END to complete the fan-out/parallel step.
   */
  .addEdge("worker_node", END);

// 2. Export a function to get the compiled app
// to ensure the checkpointer is ready before use
export const getGraphApp = async () => {
  return workflow.compile({ checkpointer });
};
