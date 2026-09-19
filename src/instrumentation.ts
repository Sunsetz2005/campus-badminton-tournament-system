export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertRuntimeSecurity } = await import("./server/config/runtime");
  assertRuntimeSecurity();
}
