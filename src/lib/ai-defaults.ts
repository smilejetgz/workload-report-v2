// Shared by the server (CLI provider) and the Settings page, so it lives
// outside src/server — the page cannot import code that spawns processes.

/** Model the claude CLI runs when Settings leaves the model empty. */
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5[1m]";
