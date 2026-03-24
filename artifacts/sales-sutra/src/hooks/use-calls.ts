import {
  useListCalls,
  type ListCallsParams
} from "@workspace/api-client-react";

export function useCallsList(params?: ListCallsParams) {
  return useListCalls(params);
}
