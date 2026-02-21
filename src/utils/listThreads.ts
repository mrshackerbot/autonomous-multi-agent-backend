import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

async function manageMissions(shouldCleanup = false) {
  const checkpointer = SqliteSaver.fromConnString("./checkpoints.db");
  const seenThreads = new Set<string>();

  console.log(`📂 --- MANAGING MISSIONS (Cleanup: ${shouldCleanup}) --- 📂\n`);

  // Iterating through all checkpoints in the database
  for await (const checkpoint of checkpointer.list({})) {
    const threadId = checkpoint.config.configurable?.thread_id;

    if (threadId && !seenThreads.has(threadId)) {
      seenThreads.add(threadId);

      // A thread is 'Pending' if it has nodes waiting to execute
      const isPending = checkpoint.next && checkpoint.next.length > 0;

      if (!isPending && shouldCleanup) {
        // DELETE COMPLETED THREAD
        await checkpointer.deleteThread(threadId);
        console.log(`🗑️  DELETED: ${threadId} (Completed)`);
      } else {
        const status = isPending
          ? `🟠 PENDING at [${checkpoint.next}]`
          : "✅ COMPLETED";
        console.log(`- Thread: ${threadId} | Status: ${status}`);
      }
    }
  }
  console.log("\n✨ Database Management Finished.");
}

// Set to 'true' to run the cleanup
manageMissions(true).catch(console.error);
