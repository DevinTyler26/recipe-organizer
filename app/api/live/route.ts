export const dynamic = "force-dynamic";

const LIVE_UPDATE_PUSH_INTERVAL_MS = 3_000;
const LIVE_UPDATE_KEEPALIVE_INTERVAL_MS = 15_000;

export async function GET() {
  const encoder = new TextEncoder();
  let pulseTimer: ReturnType<typeof setInterval> | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendPulse = () => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`)
        );
      };
      const sendKeepAlive = () => {
        controller.enqueue(encoder.encode(`: keep-alive\n\n`));
      };

      sendPulse();
      pulseTimer = setInterval(sendPulse, LIVE_UPDATE_PUSH_INTERVAL_MS);
      keepAliveTimer = setInterval(
        sendKeepAlive,
        LIVE_UPDATE_KEEPALIVE_INTERVAL_MS
      );
    },
    cancel() {
      if (pulseTimer) {
        clearInterval(pulseTimer);
        pulseTimer = null;
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
