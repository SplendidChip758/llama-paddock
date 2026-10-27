// Start the background poller as soon as the server boots, rather than on the first request,
// and create the login (printing a generated password) before anyone can reach the login page.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { paddock } = await import("./lib/server");
    const { authEnabled, loadAuth } = await import("./lib/auth");
    try {
      if (authEnabled()) loadAuth();
      paddock();
    } catch (e) {
      console.error("[llama-paddock] failed to start:", e instanceof Error ? e.message : e);
    }
  }
}
