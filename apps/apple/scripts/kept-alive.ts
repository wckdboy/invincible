/*
 * A stand-in model's answer kept alive while it waits, as a provider thinking at length keeps its stream alive: the
 * headers at once, then a server-sent-events comment (": thinking") every `everyMs` until the answer is ready, then the
 * answer's own bytes. A comment is no data to a client (core's adapters read only `data:` lines), so an answer that is
 * ready at once is byte for byte what it was.
 *
 * Why: the dev node holds some calls on purpose (an agent thinking, a stepped demo's step), and a held call that sends
 * nothing is ended by the node: Bun's fetch gives up on a response with no headers at 360 s ("The operation timed
 * out."), and the models' QUIET_MS ends a stream silent for 5 minutes. Researcher's held answer failed that way 360 s
 * after the dev node began, a change to the team at a set time, which CI's at-rest minute caught (26 November 2026).
 */
export function keptAlive(answer: () => Promise<Response>, everyMs = 30_000): Response {
  const comment = new TextEncoder().encode(": thinking\n\n");
  let pings: ReturnType<typeof setInterval> | undefined;
  let gone = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      pings = setInterval(() => {
        if (!gone) controller.enqueue(comment);
      }, everyMs);
      try {
        const answered = await answer();
        clearInterval(pings);
        if (gone) return;
        const reader = answered.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done || gone) break;
          controller.enqueue(value);
        }
        if (!gone) controller.close();
      } catch (error) {
        clearInterval(pings);
        if (!gone) controller.error(error);
      }
    },
    cancel() {
      gone = true;
      clearInterval(pings);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
