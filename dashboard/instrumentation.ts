// Start the background poller as soon as the server boots, rather than on the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { paddock } = await import("./lib/server");
    try {
      paddock();
    } catch (e) {
      console.error("[llama-paddock] failed to start:", e instanceof Error ? e.message : e);
    }
  }
}
