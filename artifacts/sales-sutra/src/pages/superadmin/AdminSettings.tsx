import { useEffect, useState, useCallback } from "react";
import { Settings, Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface PlatformSettings {
  defaultCommissionPct?: string;
  defaultPaymentTermsDays?: string;
  platformName?: string;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("ss_auth_token");
  const h: Record<string, string> = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export default function AdminSettings() {
  const [settings, setSettings] = useState<PlatformSettings>({});
  const [settingsForm, setSettingsForm] = useState<PlatformSettings>({});
  const [isLoading, setIsLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const { toast } = useToast();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/superadmin/settings", { headers: authHeaders() });
      if (res.ok) {
        const s = await res.json() as PlatformSettings;
        setSettings(s);
        setSettingsForm(s);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    try {
      const res = await fetch("/api/superadmin/settings", {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(settingsForm),
      });
      if (!res.ok) throw new Error("Failed to save");
      const updated = await res.json() as PlatformSettings;
      setSettings(updated);
      setSettingsForm(updated);
      toast({ title: "Platform settings saved" });
    } catch {
      toast({ title: "Error saving settings", variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">System Settings</h1>
        <p className="text-muted-foreground mt-1">Configure global platform defaults</p>
      </div>

      <div className="glass-panel rounded-xl border border-white/5 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Settings className="w-5 h-5 text-primary" />
          <h2 className="font-semibold text-foreground">Platform Defaults</h2>
        </div>
        <form onSubmit={handleSaveSettings} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Platform Name</Label>
              <Input
                value={settingsForm.platformName ?? ""}
                onChange={(e) => setSettingsForm({ ...settingsForm, platformName: e.target.value })}
                placeholder="SalesSutra"
                className="bg-white/5 border-white/10"
              />
              <p className="text-xs text-muted-foreground">Internal name displayed in emails and titles</p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-sm font-medium">Default Commission %</Label>
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={settingsForm.defaultCommissionPct ?? ""}
                onChange={(e) => setSettingsForm({ ...settingsForm, defaultCommissionPct: e.target.value })}
                placeholder="0"
                className="bg-white/5 border-white/10"
              />
              <p className="text-xs text-muted-foreground">
                Applied to all usage. Existing: {settings.defaultCommissionPct ?? "0"}%
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-sm font-medium">Default Payment Terms (days)</Label>
              <Input
                type="number"
                min="1"
                value={settingsForm.defaultPaymentTermsDays ?? ""}
                onChange={(e) => setSettingsForm({ ...settingsForm, defaultPaymentTermsDays: e.target.value })}
                placeholder="30"
                className="bg-white/5 border-white/10"
              />
              <p className="text-xs text-muted-foreground">
                Days until invoice is overdue. Current: {settings.defaultPaymentTermsDays ?? "30"} days
              </p>
            </div>
          </div>
          
          <div className="flex justify-end pt-4 border-t border-white/5">
            <Button type="submit" disabled={savingSettings} className="gap-2">
              {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Defaults
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
