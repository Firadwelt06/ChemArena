let csrfToken = "";

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && path !== "/api/auth/login") {
    if (!csrfToken) {
      const response = await fetch("/api/auth/csrf", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Your session has expired. Sign in again.");
      const csrf = (await response.json()) as { csrfToken: string };
      csrfToken = csrf.csrfToken;
    }
    headers.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const errorMessage = typeof body === "object" && body && "error" in body ? String(body.error) : `Request failed (${response.status}).`;
    throw new Error(errorMessage);
  }
  return body as T;
}

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "STUDENT";
  mustChangePassword: boolean;
};

export type Branding = {
  schoolName: string;
  primaryColor: string;
  accentColor: string;
  footerLine: string;
  logoDataUrl: string | null;
};
