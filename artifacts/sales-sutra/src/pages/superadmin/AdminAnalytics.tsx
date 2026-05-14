import { BarChart3 } from "lucide-react";

export default function AdminAnalytics() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Platform Analytics</h1>
        <p className="text-muted-foreground mt-1">Platform-wide usage trends and call volumes</p>
      </div>
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
        <BarChart3 className="w-16 h-16 opacity-20 mb-4" />
        <h2 className="text-lg font-medium">Analytics Engine Syncing</h2>
        <p className="text-sm">Historical call volume and language distribution data is being aggregated.</p>
      </div>
    </div>
  );
}
