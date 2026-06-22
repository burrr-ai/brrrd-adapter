export function basePath(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const value = (config as { basePath?: unknown }).basePath;
  if (typeof value !== "string" || value.length === 0 || value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
