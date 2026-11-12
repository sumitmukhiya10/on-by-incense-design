export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const init = { ...options, headers, credentials: "same-origin" };
  if (options.body != null && !(options.body instanceof FormData) && typeof options.body !== "string") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (_error) {
    throw new Error("The store server is not reachable here. Run start-server.bat, then open http://127.0.0.1:8000 in your browser.");
  }
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!contentType.includes("application/json") && path.startsWith("/api/")) {
    throw new Error("This page is not connected to the store server. Run start-server.bat, then open http://127.0.0.1:8000 (not Live Server or index.html directly).");
  }
  if (!response.ok) {
    const error = new Error(payload?.detail || payload?.message || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}
