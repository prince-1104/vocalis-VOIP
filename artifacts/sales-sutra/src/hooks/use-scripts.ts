import { useQueryClient } from "@tanstack/react-query";
import {
  useListScripts,
  useCreateScript,
  useUpdateScript,
  useDeleteScript,
  getListScriptsQueryKey,
  type CreateScriptRequest,
  type UpdateScriptRequest
} from "@workspace/api-client-react";

export function useScriptsList() {
  return useListScripts();
}

export function useCreateScriptMutation() {
  const queryClient = useQueryClient();
  const mutation = useCreateScript();
  
  return {
    ...mutation,
    mutateAsync: async (data: CreateScriptRequest) => {
      const result = await mutation.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: getListScriptsQueryKey() });
      return result;
    }
  };
}

export function useUpdateScriptMutation() {
  const queryClient = useQueryClient();
  const mutation = useUpdateScript();
  
  return {
    ...mutation,
    mutateAsync: async ({ id, data }: { id: number; data: UpdateScriptRequest }) => {
      const result = await mutation.mutateAsync({ id, data });
      queryClient.invalidateQueries({ queryKey: getListScriptsQueryKey() });
      return result;
    }
  };
}

export function useDeleteScriptMutation() {
  const queryClient = useQueryClient();
  const mutation = useDeleteScript();
  
  return {
    ...mutation,
    mutateAsync: async (id: number) => {
      await mutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListScriptsQueryKey() });
    }
  };
}
