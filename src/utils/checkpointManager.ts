import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { config } from "../config.js";
import pino from "pino";

const logger = pino({
  level: config.logging.level,
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

export class CheckpointManager {
  private checkpointer: any;

  constructor() {
    this.checkpointer = SqliteSaver.fromConnString(
      config.database.checkpointPath,
    );
  }

  async listMissions(): Promise<any[]> {
    const missions: any[] = [];
    const seenThreads = new Set();

    try {
      for await (const checkpoint of this.checkpointer.list({})) {
        const threadId = checkpoint.config?.configurable?.thread_id;
        if (threadId && !seenThreads.has(threadId)) {
          seenThreads.add(threadId);
          missions.push({
            threadId,
            createdAt: checkpoint.created_at || new Date().toISOString(),
            checkpointId: checkpoint.checkpoint_id,
          });
        }
      }
    } catch (error) {
      logger.error({ error }, "Failed to list checkpoints");
    }

    return missions;
  }

  async getMission(threadId: string): Promise<any> {
    const config = { configurable: { thread_id: threadId } };

    try {
      const checkpoint = await this.checkpointer.getTuple(config);
      return checkpoint;
    } catch (error) {
      logger.error({ error, threadId }, "Failed to get mission");
      return null;
    }
  }

  async deleteMission(threadId: string): Promise<boolean> {
    try {
      if (typeof this.checkpointer.deleteThread === "function") {
        await this.checkpointer.deleteThread(threadId);
        return true;
      }
      return false;
    } catch (error) {
      logger.error({ error, threadId }, "Failed to delete mission");
      return false;
    }
  }
}

export const checkpointManager = new CheckpointManager();
