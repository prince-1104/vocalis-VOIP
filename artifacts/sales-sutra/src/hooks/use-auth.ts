import { useGetMe } from "@workspace/api-client-react";

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

export function useAuth() {
  const query = useGetMe({
    query: {
      retry: false,
      refetchOnWindowFocus: false,
    }
  });

  const user = query.data as CurrentUser | undefined;

  return {
    user,
    isLoading: query.isLoading,
    isError: query.isError,
    isSuperadmin: user?.isSuperadmin ?? false,
    role: user?.role,
    isAuthenticated: !query.isError && !query.isLoading && !!user,
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
