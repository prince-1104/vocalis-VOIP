import React from "react";
import { useAnalytics } from "@/hooks/use-analytics";
import { useCallsList } from "@/hooks/use-calls";
import { StatCard } from "@/components/ui-custom/StatCard";
import { StatusBadge } from "@/components/ui-custom/StatusBadge";
import { PhoneCall, Users, CheckCircle2, Clock, ArrowRight, Megaphone, Bot, DollarSign, TrendingDown, Zap, Phone } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics({ period: "week" });
  const { data: recentCalls, isLoading: callsLoading } = useCallsList({ limit: 5 });

  if (analyticsLoading || callsLoading) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-10 w-48 bg-white/10 rounded-lg"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-32 bg-white/5 rounded-xl"></div>)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Welcome back</h1>
        <p className="text-muted-foreground mt-1">Here's what your AI agent has been up to this week.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard 
          title="Total Calls" 
          value={analytics?.totalCalls || 0} 
          icon={PhoneCall} 
        />
        <StatCard 
          title="Answer Rate" 
          value={`${(analytics?.answerRate || 0).toFixed(1)}%`} 
          icon={CheckCircle2} 
        />
        <StatCard 
          title="Interested Leads" 
          value={analytics?.interestedLeads || 0} 
          icon={Users} 
          trendUp={true}
        />
        <StatCard 
          title="Avg Duration" 
          value={`${Math.round((analytics?.avgCallDuration || 0) / 60)}m ${Math.round((analytics?.avgCallDuration || 0) % 60)}s`} 
          icon={Clock} 
        />
      </div>

      <Card className="glass-panel border-white/5">
        <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-white/5">
          <CardTitle className="text-lg font-display flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-emerald-400" /> Cost Analysis — This Week
          </CardTitle>
          <span className="text-xs text-muted-foreground">Estimates based on call duration &amp; AI model</span>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
              <DollarSign className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
              <p className="text-2xl font-bold font-mono text-emerald-400">
                ${((analytics as any)?.totalCostUsd || 0).toFixed(4)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Total Spend</p>
            </div>
            <div className="bg-white/5 border border-white/5 rounded-xl p-4 text-center">
              <TrendingDown className="w-5 h-5 text-blue-400 mx-auto mb-1" />
              <p className="text-2xl font-bold font-mono text-blue-400">
                ${((analytics as any)?.avgCostPerCall || 0).toFixed(4)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Avg per Call</p>
            </div>
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-center">
              <Phone className="w-5 h-5 text-amber-400 mx-auto mb-1" />
              <p className="text-2xl font-bold font-mono text-amber-400">
                ${((analytics as any)?.totalTwilioCostUsd || 0).toFixed(4)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Twilio (voice + STT)</p>
            </div>
            <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-4 text-center">
              <Zap className="w-5 h-5 text-purple-400 mx-auto mb-1" />
              <p className="text-2xl font-bold font-mono text-purple-400">
                ${((analytics as any)?.totalOpenaiCostUsd || 0).toFixed(4)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">OpenAI (AI responses)</p>
            </div>
          </div>
          {(analytics as any)?.costByDay && (analytics as any).costByDay.some((d: any) => d.cost > 0) ? (
            <div>
              <p className="text-xs text-muted-foreground mb-3 font-medium uppercase tracking-wider">Daily Spend</p>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={(analytics as any).costByDay} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <XAxis dataKey="date" tickFormatter={(d) => format(new Date(d + 'T00:00:00'), 'MMM d')} tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v.toFixed(3)}`} width={55} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', fontSize: 12 }}
                    formatter={(v: any) => [`$${Number(v).toFixed(4)}`, 'Cost']}
                    labelFormatter={(d) => format(new Date(d + 'T00:00:00'), 'MMMM d, yyyy')}
                  />
                  <Bar dataKey="cost" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="text-center text-muted-foreground text-sm py-4">
              Cost data will appear here after completed calls with Twilio webhooks configured.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <Card className="col-span-1 lg:col-span-2 glass-panel border-white/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-white/5">
            <CardTitle className="text-lg font-display">Recent Calls</CardTitle>
            <Link href="/calls" className="text-sm text-primary hover:text-primary/80 font-medium flex items-center">
              View all <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {recentCalls?.calls && recentCalls.calls.length > 0 ? (
              <div className="divide-y divide-white/5">
                {recentCalls.calls.map((call) => (
                  <div key={call.id} className="p-4 hover:bg-white/5 transition-colors flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20">
                        <PhoneCall className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{call.contact?.firstName} {call.contact?.lastName || call.phone}</p>
                        <p className="text-sm text-muted-foreground">{format(new Date(call.startedAt), 'MMM d, h:mm a')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-muted-foreground">{call.duration}s</span>
                      <StatusBadge status={call.outcome || 'unknown'} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground">
                <p>No recent calls found.</p>
                <Button className="mt-4" variant="outline" asChild>
                  <Link href="/campaigns">Start a Campaign</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1 glass-panel border-white/5 bg-gradient-to-b from-card/60 to-primary/5">
          <CardHeader>
            <CardTitle className="text-lg font-display">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button className="w-full justify-start text-left bg-white/5 hover:bg-white/10 border border-white/10 h-12" variant="outline" asChild>
              <Link href="/contacts">
                <Users className="w-4 h-4 mr-2 text-primary" /> Add New Contacts
              </Link>
            </Button>
            <Button className="w-full justify-start text-left bg-white/5 hover:bg-white/10 border border-white/10 h-12" variant="outline" asChild>
              <Link href="/campaigns">
                <Megaphone className="w-4 h-4 mr-2 text-primary" /> Launch Campaign
              </Link>
            </Button>
            <Button className="w-full justify-start text-left bg-white/5 hover:bg-white/10 border border-white/10 h-12" variant="outline" asChild>
              <Link href="/agent">
                <Bot className="w-4 h-4 mr-2 text-primary" /> Tune AI Agent
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
