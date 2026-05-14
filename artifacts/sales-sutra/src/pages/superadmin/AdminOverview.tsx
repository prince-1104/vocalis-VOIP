import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { Building2, Users, Receipt, TrendingUp, ChevronRight, Loader2, AlertTriangle, ShieldAlert, BarChart3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface DashboardSummary {
  totalTenants: number;
  activeThisMonth: number;
  platformCost: number;
  tenantsOverLimit: number;
  totalRevenue: number;
  estimatedMargin: number;
}

interface TopConsumer {
  tenantId: number;
  tenantName: string;
  cost: number;
}

interface RecentAlert {
  tenantId: number;
  tenantName: string;
  timestamp: string;
}

interface ChartData {
  date: string;
  llm: number;
  tts: number;
  stt: number;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("ss_auth_token");
  const h: Record<string, string> = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export default function AdminOverview() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [topConsumers, setTopConsumers] = useState<TopConsumer[]>([]);
  const [recentAlerts, setRecentAlerts] = useState<RecentAlert[]>([]);
  const [chartData, setChartData] = useState<ChartData[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/superadmin/dashboard", { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary);
        setTopConsumers(data.topConsumers);
        setRecentAlerts(data.recentAlerts);
        setChartData(data.chartData);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Super Admin Dashboard</h1>
        <p className="text-muted-foreground mt-1">Platform-wide summary and health metrics</p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard icon={Building2} label="Total Tenants" value={summary.totalTenants} color="text-primary" />
          <StatCard icon={Users} label="Active This Month" value={summary.activeThisMonth} color="text-primary" />
          <StatCard icon={Receipt} label="Platform API Cost" value={`$${summary.platformCost.toFixed(2)}`} color="text-red-400" />
          <StatCard icon={AlertTriangle} label="Tenants Over Limit" value={summary.tenantsOverLimit} color="text-amber-400" />
          <StatCard icon={TrendingUp} label="Total Revenue" value={`$${summary.totalRevenue.toFixed(2)}`} color="text-green-400" />
          <StatCard icon={TrendingUp} label="Estimated Margin" value={`$${summary.estimatedMargin.toFixed(2)}`} color="text-green-400" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Consumers */}
        <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" /> Top Consumers
            </h2>
            <Link href="/superadmin/costs">
              <span className="text-sm text-primary hover:underline cursor-pointer flex items-center gap-1">
                View all <ChevronRight className="w-4 h-4" />
              </span>
            </Link>
          </div>
          <div className="divide-y divide-white/5">
            {topConsumers.map((t, i) => (
              <div key={i} className="flex items-center justify-between px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-bold text-primary">
                    {i + 1}
                  </div>
                  <div>
                    <p className="font-medium text-sm text-foreground">{t.tenantName}</p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="font-medium text-foreground">${t.cost.toFixed(2)}</span>
                </div>
              </div>
            ))}
            {topConsumers.length === 0 && (
              <div className="text-center py-6 text-muted-foreground text-sm">No API usage yet</div>
            )}
          </div>
        </div>

        {/* Recent Alerts */}
        <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-red-400" /> Recent Alerts
            </h2>
            <Link href="/superadmin/alerts">
              <span className="text-sm text-primary hover:underline cursor-pointer flex items-center gap-1">
                View all <ChevronRight className="w-4 h-4" />
              </span>
            </Link>
          </div>
          <div className="divide-y divide-white/5">
            {recentAlerts.map((a, i) => (
              <div key={i} className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="font-medium text-sm text-foreground">{a.tenantName}</p>
                  <p className="text-xs text-muted-foreground">{new Date(a.timestamp).toLocaleString()}</p>
                </div>
                <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20">
                  Limit Reached
                </Badge>
              </div>
            ))}
            {recentAlerts.length === 0 && (
              <div className="text-center py-6 text-muted-foreground text-sm">No recent alerts</div>
            )}
          </div>
        </div>
      </div>
      
      {/* Chart Placeholder */}
      <div className="glass-panel rounded-xl border border-white/5 p-6">
        <h2 className="font-semibold text-foreground flex items-center gap-2 mb-6">
          <BarChart3 className="w-5 h-5 text-primary" /> Cost Breakdown Chart
        </h2>
        <div className="h-48 flex items-end gap-2 w-full">
          {chartData.map((d, i) => {
             const max = Math.max(...chartData.map(x => x.llm + x.tts + x.stt), 0.01);
             const hLLM = (d.llm / max) * 100;
             const hTTS = (d.tts / max) * 100;
             const hSTT = (d.stt / max) * 100;
             return (
               <div key={i} className="flex-1 flex flex-col justify-end group relative">
                 <div className="w-full flex flex-col justify-end h-full min-h-[4px]">
                    <div className="w-full bg-blue-500/50 hover:bg-blue-500/70" style={{ height: `${hSTT}%` }} />
                    <div className="w-full bg-purple-500/50 hover:bg-purple-500/70" style={{ height: `${hTTS}%` }} />
                    <div className="w-full bg-primary/50 hover:bg-primary/70" style={{ height: `${hLLM}%` }} />
                 </div>
                 <div className="opacity-0 group-hover:opacity-100 absolute bottom-full mb-2 bg-black/80 px-2 py-1 text-[10px] rounded pointer-events-none z-10 w-24 left-1/2 -translate-x-1/2 text-center">
                    {d.date.split('T')[0]}<br/>
                    LLM: ${d.llm.toFixed(2)}<br/>
                    TTS: ${d.tts.toFixed(2)}<br/>
                    STT: ${d.stt.toFixed(2)}
                 </div>
               </div>
             );
          })}
        </div>
        <div className="flex justify-center gap-4 mt-4 text-xs text-muted-foreground">
           <div className="flex items-center gap-1"><div className="w-3 h-3 bg-primary/50 rounded-sm"></div> LLM</div>
           <div className="flex items-center gap-1"><div className="w-3 h-3 bg-purple-500/50 rounded-sm"></div> TTS</div>
           <div className="flex items-center gap-1"><div className="w-3 h-3 bg-blue-500/50 rounded-sm"></div> STT</div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string | number; color: string }) {
  return (
    <div className="glass-panel rounded-xl p-4 border border-white/5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground leading-tight mb-1">{label}</p>
          <p className="text-lg font-bold text-foreground leading-none">{value}</p>
        </div>
      </div>
    </div>
  );
}
