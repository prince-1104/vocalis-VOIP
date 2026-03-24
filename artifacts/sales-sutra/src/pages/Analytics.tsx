import React, { useState } from "react";
import { useAnalytics } from "@/hooks/use-analytics";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, TrendingUp, Filter } from "lucide-react";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { Button } from "@/components/ui/button";

const COLORS = ['#7C3AED', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6', '#64748B'];

export default function Analytics() {
  const [period, setPeriod] = useState<"week" | "month" | "all">("week");
  const { data, isLoading } = useAnalytics({ period });

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-48 bg-white/10 rounded-lg mb-8"></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-96 bg-white/5 rounded-xl"></div>
          <div className="h-96 bg-white/5 rounded-xl"></div>
        </div>
      </div>
    );
  }

  const pieData = data?.outcomeBreakdown?.map(item => ({
    name: item.outcome.replace('_', ' '),
    value: item.count
  })) || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-primary" /> Performance
          </h1>
          <p className="text-muted-foreground mt-1">Deep dive into your agent's calling metrics and conversion rates.</p>
        </div>
        
        <div className="flex bg-card border border-white/10 rounded-lg p-1">
          <Button 
            variant={period === "week" ? "secondary" : "ghost"} 
            size="sm" 
            onClick={() => setPeriod("week")}
            className={period === "week" ? "bg-white/10 shadow-sm" : ""}
          >
            7 Days
          </Button>
          <Button 
            variant={period === "month" ? "secondary" : "ghost"} 
            size="sm" 
            onClick={() => setPeriod("month")}
            className={period === "month" ? "bg-white/10 shadow-sm" : ""}
          >
            30 Days
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card className="glass-panel border-white/5 bg-gradient-to-br from-card to-primary/5">
          <CardContent className="p-6">
            <p className="text-sm font-medium text-muted-foreground">Conversion Rate</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-4xl font-bold text-foreground">{(data?.conversionRate || 0).toFixed(1)}%</span>
              <span className="text-sm text-emerald-400 flex items-center"><TrendingUp className="w-3 h-3 mr-1"/></span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Leads generated per connected call</p>
          </CardContent>
        </Card>
        
        <Card className="glass-panel border-white/5">
          <CardContent className="p-6">
            <p className="text-sm font-medium text-muted-foreground">Answer Rate</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-4xl font-bold text-foreground">{(data?.answerRate || 0).toFixed(1)}%</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Percentage of dials successfully connected</p>
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardContent className="p-6">
            <p className="text-sm font-medium text-muted-foreground">Callback Requests</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-4xl font-bold text-primary">{data?.callbackRequests || 0}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Requires human follow-up</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="text-lg font-display">Call Volume Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data?.callsByDay || []} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                  <XAxis dataKey="date" stroke="#888" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#888" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181B', borderColor: '#27272A', borderRadius: '8px' }}
                    itemStyle={{ color: '#FAFAFA' }}
                  />
                  <Line type="monotone" dataKey="total" name="Total Dials" stroke="#64748B" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="answered" name="Answered" stroke="#7C3AED" strokeWidth={3} dot={{ r: 4, fill: '#7C3AED', strokeWidth: 0 }} activeDot={{ r: 6 }} />
                  <Line type="monotone" dataKey="interested" name="Interested Leads" stroke="#10B981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="text-lg font-display">Outcome Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={80}
                    outerRadius={110}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181B', borderColor: '#27272A', borderRadius: '8px', color: '#fff' }}
                    itemStyle={{ color: '#FAFAFA' }}
                  />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
