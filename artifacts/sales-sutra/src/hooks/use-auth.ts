import { useQuery } from "@tanstack/react-query";
import { adminAuthHeaders } from "@/lib/admin-fetch";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface CurrentUser {
  id?: number;
  email?: string;
  name?: string | null;
  isSuperadmin?: boolean;
  role?: "admin" | "manager" | "superadmin";
  tenantId?: number;
  tenantOwnerId?: number;
  tenantName?: string;
  tenantStatus?: string;
  ownerProfile?: {
    id?: number;
    email?: string | null;
    name?: string | null;
    businessName?: string | null;
    plan?: string | null;
  };
}

interface MeResponse extends CurrentUser {
  suspended?: boolean;
  invoiceId?: number | null;
  amountDue?: string | null;
  _status: number;
}

async function fetchMe(): Promise<MeResponse> {
  const res = await fetch(`${BASE}/api/auth/me`, { headers: adminAuthHeaders() });
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  return { ...(body as Partial<MeResponse>), _status: res.status };
}

export function useAuth() {
  const query = useQuery<MeResponse>({
    queryKey: ["auth-me"],
    queryFn: fetchMe,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  const status = data?._status;
  const isSuspended = status === 402 && (data?.suspended === true);
  const isAuthenticated = !query.isLoading && !query.isError && status === 200 && !!data?.id;
  const user: CurrentUser | undefined = isAuthenticated ? data : undefined;

  return {
    user,
    isLoading: query.isLoading,
    isError: query.isError,
    isSuperadmin: data?.isSuperadmin ?? false,
    role: data?.role,
    isAuthenticated,
    isSuspended,
    suspensionInvoiceId: isSuspended ? (data?.invoiceId ?? null) : null,
    suspensionAmountDue: isSuspended ? (data?.amountDue ?? null) : null,
  };
}

export const AUTH_TOKEN_KEY = "ss_auth_token";

export function getStoredToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}
