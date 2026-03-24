import { useQueryClient } from "@tanstack/react-query";
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
