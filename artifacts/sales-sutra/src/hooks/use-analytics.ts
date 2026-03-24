import {
  useGetAnalyticsSummary,
  type GetAnalyticsSummaryParams
} from "@workspace/api-client-react";

export function useAnalytics(params?: GetAnalyticsSummaryParams) {
  return useGetAnalyticsSummary(params);
}
