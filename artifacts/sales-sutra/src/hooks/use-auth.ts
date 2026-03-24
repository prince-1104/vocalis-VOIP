import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";

export function useAuth() {
  const query = useGetMe({
    query: {
      retry: false,
      refetchOnWindowFocus: false,
    }
  });

  return {
    user: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
