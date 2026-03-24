import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAgent,
  useUpdateAgent,
  getGetAgentQueryKey,
  type UpdateAgentRequest
} from "@workspace/api-client-react";

export function useAgentConfig() {
  return useGetAgent();
}

export function useUpdateAgentMutation() {
  const queryClient = useQueryClient();
  const mutation = useUpdateAgent();
  
  return {
    ...mutation,
    mutateAsync: async (data: UpdateAgentRequest) => {
      const result = await mutation.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey() });
      return result;
    }
  };
}
