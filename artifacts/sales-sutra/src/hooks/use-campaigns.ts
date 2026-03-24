import { useQueryClient } from "@tanstack/react-query";
import {
  useListCampaigns,
  useCreateCampaign,
  useUpdateCampaign,
  useStartCampaign,
  usePauseCampaign,
  getListCampaignsQueryKey,
  type CreateCampaignRequest,
  type UpdateCampaignRequest
} from "@workspace/api-client-react";

export function useCampaignsList() {
  return useListCampaigns();
}

export function useCreateCampaignMutation() {
  const queryClient = useQueryClient();
  const mutation = useCreateCampaign();
  
  return {
    ...mutation,
    mutateAsync: async (data: CreateCampaignRequest) => {
      const result = await mutation.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
      return result;
    }
  };
}

export function useStartCampaignMutation() {
  const queryClient = useQueryClient();
  const mutation = useStartCampaign();
  
  return {
    ...mutation,
    mutateAsync: async (id: number) => {
      const result = await mutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
      return result;
    }
  };
}

export function usePauseCampaignMutation() {
  const queryClient = useQueryClient();
  const mutation = usePauseCampaign();
  
  return {
    ...mutation,
    mutateAsync: async (id: number) => {
      const result = await mutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
      return result;
    }
  };
}
