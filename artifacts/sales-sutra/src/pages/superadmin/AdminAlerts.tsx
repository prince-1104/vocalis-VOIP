import { BellRing } from "lucide-react";

export default function AdminAlerts() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Alerts</h1>
        <p className="text-muted-foreground mt-1">Active limit breaches and alert history</p>
      </div>
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
        <BellRing className="w-16 h-16 opacity-20 mb-4" />
        <h2 className="text-lg font-medium">No Active Alerts</h2>
        <p className="text-sm">All tenants are within their defined billing limits.</p>
      </div>
    </div>
  );
}
