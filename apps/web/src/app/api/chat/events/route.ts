import { createClient } from "@/lib/supabase/server";
import { subscribeToTurnEvents } from "@/lib/agent-turn-events";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const turnId = url.searchParams.get("turnId");
  if (!turnId || !UUID_RE.test(turnId)) {
    return new Response("turnId required", { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = subscribeToTurnEvents(turnId, (event) => {
        controller.enqueue(
          encoder.encode(`event: turn-event\ndata: ${JSON.stringify(event)}\n\n`)
        );
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

