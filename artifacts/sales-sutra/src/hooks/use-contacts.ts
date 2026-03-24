import { useQueryClient } from "@tanstack/react-query";
import {
  useListContacts,
  useCreateContact,
  useUpdateContact,
  useDeleteContact,
  getListContactsQueryKey,
  type ListContactsParams,
  type CreateContactRequest,
  type UpdateContactRequest
} from "@workspace/api-client-react";

export function useContactsList(params?: ListContactsParams) {
  return useListContacts(params);
}

export function useCreateContactMutation() {
  const queryClient = useQueryClient();
  const mutation = useCreateContact();
  
  return {
    ...mutation,
    mutateAsync: async (data: CreateContactRequest) => {
      const result = await mutation.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: [getListContactsQueryKey()[0]] });
      return result;
    }
  };
}

export function useUpdateContactMutation() {
  const queryClient = useQueryClient();
  const mutation = useUpdateContact();
  
  return {
    ...mutation,
    mutateAsync: async ({ id, data }: { id: number; data: UpdateContactRequest }) => {
      const result = await mutation.mutateAsync({ id, data });
      queryClient.invalidateQueries({ queryKey: [getListContactsQueryKey()[0]] });
      return result;
    }
  };
}

export function useDeleteContactMutation() {
  const queryClient = useQueryClient();
  const mutation = useDeleteContact();
  
  return {
    ...mutation,
    mutateAsync: async (id: number) => {
      await mutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: [getListContactsQueryKey()[0]] });
    }
  };
}
