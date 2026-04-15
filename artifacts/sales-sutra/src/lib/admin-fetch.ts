export function adminAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("ss_auth_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function adminFetch<T = unknown>(
  path: string,
  options: Omit<RequestInit, "headers"> = {}
): Promise<T> {
  const res = await fetch(path, { ...options, headers: adminAuthHeaders() });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
