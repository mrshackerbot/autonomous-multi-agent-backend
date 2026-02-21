# 🤖 Autonomous Multi-Agent Backend (Local-First)

## LangChain + LangGraph + KaibanJS + Multi-Ollama
A production-grade, private AI operating system. This backend dynamically spawns specialized teams, manages tiered model logic (Heavy/Balanced/Fast), and ensures 100% data sovereignty using local LLMs and SQLite persistence.

## 🏛 The "Triple-Threat" Fusion
- Component -	Layer -	Role
- LangChain -	The Muscle - Standardized Tools (Search, SQL, Vision) and Model wrappers.
- LangGraph	- The Brain	State - Machine runtime for loops, parallel "fan-out," and durable checkpoints.
- KaibanJS - The Manager - Role-based Orchestration and Kanban visualization for specialist teams.
- Ollama - The Power - Local LLM Inference (Llama 3.1, Mistral, Phi-3) for zero-cost, private processing.

## 🚀 Key Features
- Multi-Model Tiering: Uses Llama-3.1-70b for planning, 8b for research, and Phi-3 for fast data extraction.
- Dynamic Agent Factory: Automatically creates agents with specific roles and tools based on the user's request.
- Durable State (SQLite): Every "thought" is saved to checkpoints.db. Resume any mission after a crash or restart.
- Self-Correction Loops: Agents review each other's work and loop back for revisions until the goal is met.

## 🛠 Prerequisites & Setup

### 1. Install Ollama & Models
Download Ollama and pull the recommended tiers:
```code
ollama pull llama3.1:70b  # The Manager
ollama pull llama3.1:8b   # The Specialist
ollama pull phi3:mini     # The Worker
```

### 2. Install Dependencies
   ```bash
   npm install @langchain/ollama @langchain/community @langchain/langgraph @langchain/langgraph-checkpoint-sqlite kaibanjs express zod
   ```
### 3. Environment Configuration
Create a .env file:
> OLLAMA_BASE_URL=http://localhost:11434

## 📂 Project Structure
```text
├── src/
│   ├── agents/          # Dynamic Agent Factory (KaibanJS)
│   ├── tools/           # LangChain Tool Registry (Search, DB, Vision)
│   ├── graph.ts         # LangGraph State & Supervisor Logic
│   └── server.ts        # Express API with SQLite Checkpointer
├── checkpoints.db       # Local Persistent Memory (Auto-generated)
└── package.json
```


## 🚦 How to Use
### 1. Start the Backend
```bash
npx ts-node src/server.ts
```

### 2. Invoke the Dynamic Team
Send a request to the Express.js endpoint. The Supervisor will analyze the complexity and spawn the appropriate tiered agents.
```bash
curl -X POST http://localhost:3000/api/mission \
-H "Content-Type: application/json" \
-d '{
  "query": "Research 2026 AI trends and provide a technical summary.",
  "threadId": "unique-session-id-001"
}'
```

### 3. Monitor via Kaiban Board
> Plug into the Kaiban Board to see your local agents (Alice, Bob, etc.) moving tasks through the pipeline in real-time.

## 🛡 Security & Reliability
- 100% Local: No data ever leaves your hardware (except for optional web search tools).
- Zod Enforcement: All Supervisor decisions are validated against strict JSON schemas.
- ACID Persistence: SQLite checkpointers ensure data integrity across parallel agent branches.
