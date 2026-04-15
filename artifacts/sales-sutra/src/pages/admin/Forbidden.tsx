import { Link } from "wouter";
import { ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Forbidden() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="text-center space-y-4">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 mb-2">
          <ShieldX className="w-8 h-8 text-red-400" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Access Denied</h1>
        <p className="text-muted-foreground max-w-sm">
          You don't have permission to access the superadmin portal.
          This area is restricted to platform administrators.
        </p>
        <Link href="/">
          <Button variant="outline" className="mt-4">Back to Dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
