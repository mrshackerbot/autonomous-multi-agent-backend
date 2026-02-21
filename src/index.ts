import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOllama } from "@langchain/ollama";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { WikipediaQueryRun } from "@langchain/community/tools/wikipedia_query_run";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { Calculator } from "@langchain/community/tools/calculator";
import pino from "pino";

const logger = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// --- 1. MODEL SETUP ---
const model = new ChatOllama({
  model: "phi3:mini",
  temperature: 0,
});

const fastModel = new ChatOllama({
  model: "deepseek-v3.1:671b-cloud",
  temperature: 0.2,
});

// --- 2. TOOLS ---
const wikipedia = new WikipediaQueryRun({
  maxDocContentLength: 2000,
});

const search = new DuckDuckGoSearch({
  maxResults: 2,
});

const calculator = new Calculator();

// --- 3. STATE DEFINITION (without Annotation) ---
interface GraphState {
  input: string;
  output: string;
  steps: string[];
  research: string;
}

// --- 4. NODE FUNCTIONS ---

// Supervisor node
const supervisorNode = async (state: GraphState) => {
  logger.info({ input: state.input }, "🤔 Supervisor analyzing");

  const prompt = ChatPromptTemplate.fromTemplate(`
    You are a supervisor. Analyze this request: {input}
    
    Return a brief plan (1 sentence).
  `);

  const chain = prompt.pipe(fastModel).pipe(new StringOutputParser());

  try {
    const result = await chain.invoke({ input: state.input });
    logger.info({ result }, "📋 Supervisor plan");

    return {
      ...state,
      steps: [...(state.steps || []), `Supervisor: ${result}`],
    };
  } catch (error: any) {
    logger.error({ error: error.message }, "❌ Supervisor failed");
    return {
      ...state,
      steps: [...(state.steps || []), `Supervisor error: ${error.message}`],
    };
  }
};

// Researcher node
const researcherNode = async (state: GraphState) => {
  logger.info("🔍 Researching...");

  try {
    // Try Wikipedia first
    let research = "";
    try {
      research = await wikipedia.invoke(state.input);
    } catch {
      // If Wikipedia fails, try search
      try {
        research = await search.invoke(state.input);
      } catch {
        research = "No information found.";
      }
    }

    return {
      ...state,
      research,
      steps: [...(state.steps || []), `Research completed`],
    };
  } catch (error: any) {
    return {
      ...state,
      research: `Research failed: ${error.message}`,
      steps: [...(state.steps || []), `Research error: ${error.message}`],
    };
  }
};

// Answer node
const answerNode = async (state: GraphState) => {
  logger.info("💬 Generating answer...");

  const prompt = ChatPromptTemplate.fromTemplate(`
    Based on this research: {research}
    
    Answer the question: {question}
    
    Provide a clear, helpful response.
  `);

  const chain = prompt.pipe(model).pipe(new StringOutputParser());

  try {
    const result = await chain.invoke({
      research: state.research || "No research available",
      question: state.input,
    });

    return {
      ...state,
      output: result,
      steps: [...(state.steps || []), `Answer generated`],
    };
  } catch (error: any) {
    return {
      ...state,
      output: `Failed to generate answer: ${error.message}`,
      steps: [...(state.steps || []), `Answer error: ${error.message}`],
    };
  }
};

// --- 5. BUILD GRAPH ---
const builder = new StateGraph<GraphState>({
  channels: {
    input: { value: (a?: string, b?: string) => b ?? a },
    output: { value: (a?: string, b?: string) => b ?? a },
    steps: { value: (a: string[] = [], b: string[] = []) => [...a, ...b] },
    research: { value: (a?: string, b?: string) => b ?? a },
  },
})
  .addNode("supervisor", supervisorNode)
  .addNode("researcher", researcherNode)
  .addNode("answer", answerNode)
  .addEdge(START, "supervisor")
  .addEdge("supervisor", "researcher")
  .addEdge("researcher", "answer")
  .addEdge("answer", END);

// --- 6. EXPORT ---
let graph: any = null;

export const getGraphApp = async () => {
  if (!graph) {
    try {
      graph = builder.compile();
      logger.info("✅ Graph ready");
    } catch (error: any) {
      logger.error({ error: error.message }, "❌ Graph init failed");
      throw error;
    }
  }
  return graph;
};
