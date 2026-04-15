import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

let singleton:
  | MemorySaver
  | ReturnType<typeof PostgresSaver.fromConnString>
  | null = null;
let setupPromise: Promise<void> | null = null;
let postgresFailed = false;

export async function getCheckpointer() {
  if (singleton) return singleton;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || postgresFailed) {
    singleton = new MemorySaver();
    return singleton;
  }

  try {
    const saver = PostgresSaver.fromConnString(connectionString);
    if (!setupPromise) {
      setupPromise = saver.setup();
    }
    await setupPromise;
    singleton = saver;
    return saver;
  } catch (e) {
    console.error(
      "[checkpointer] PostgresSaver failed to connect — falling back to MemorySaver for this process lifetime. Error:",
      e
    );
    postgresFailed = true;
    singleton = new MemorySaver();
    return singleton;
  }
}
