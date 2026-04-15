import { AlertTriangle, CreditCard, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearStoredToken } from "@/hooks/use-auth";

interface Props {
  invoiceId?: number | null;
  amountDue?: string | null;
}

export default function SuspensionNotice({ invoiceId, amountDue }: Props) {
  function handleLogout() {
    clearStoredToken();
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-lg w-full text-center space-y-6">
        <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
          <AlertTriangle className="w-10 h-10 text-red-400" />
        </div>
        <div>
          <h1 className="font-display text-3xl font-bold text-white mb-2">Account Suspended</h1>
          <p className="text-muted-foreground">
            Your account has been suspended due to an outstanding invoice.
            Please contact support to resolve your balance.
          </p>
        </div>

        {(invoiceId || amountDue) && (
          <div className="glass-panel rounded-2xl p-6 text-left space-y-3 border border-red-500/20">
            {invoiceId && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Invoice</span>
                <span className="font-mono font-medium">#{invoiceId}</span>
              </div>
            )}
            {amountDue && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Amount Due</span>
                <span className="font-mono font-semibold text-red-400">
                  ${parseFloat(amountDue).toFixed(2)}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button className="gap-2 bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30" asChild>
            <a href="mailto:billing@salessutra.com">
              <CreditCard className="w-4 h-4" /> Contact Billing Support
            </a>
          </Button>
          <Button variant="ghost" className="gap-2 text-muted-foreground hover:text-red-400" onClick={handleLogout}>
            <LogOut className="w-4 h-4" /> Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}
