import { useQueryClient, useMutation } from "@tanstack/react-query";
import {
  useListTrainingData,
  useAddTrainingData,
  useDeleteTrainingData,
  getListTrainingDataQueryKey,
  type CreateTrainingDataRequest
} from "@workspace/api-client-react";

export function useTrainingList() {
  return useListTrainingData();
}

export function useAddTrainingDataMutation() {
  const queryClient = useQueryClient();
  const mutation = useAddTrainingData();
  
  return {
    ...mutation,
    mutateAsync: async (data: CreateTrainingDataRequest) => {
      const result = await mutation.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: getListTrainingDataQueryKey() });
      return result;
    }
  };
}

export function useDeleteTrainingDataMutation() {
  const queryClient = useQueryClient();
  const mutation = useDeleteTrainingData();
  
  return {
    ...mutation,
    mutateAsync: async (id: number) => {
      await mutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListTrainingDataQueryKey() });
    }
  };
}

export function useDeleteAllTrainingDataMutation() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/training", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete all training data");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListTrainingDataQueryKey() });
    },
  });
  return mutation;
}

