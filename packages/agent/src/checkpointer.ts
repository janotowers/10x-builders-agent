import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

let singleton:
  | MemorySaver
  | ReturnType<typeof PostgresSaver.fromConnString>
  | null = null;
let setupPromise: Promise<void> | null = null;

export async function getCheckpointer() {
  if (singleton) return singleton;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    singleton = new MemorySaver();
    return singleton;
  }

  const saver = PostgresSaver.fromConnString(connectionString);
  singleton = saver;
  if (!setupPromise) {
    setupPromise = saver.setup();
  }
  await setupPromise;
  return saver;
}
