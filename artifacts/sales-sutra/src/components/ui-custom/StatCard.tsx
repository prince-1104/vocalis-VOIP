import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: string;
  trendUp?: boolean;
  className?: string;
}

export function StatCard({ title, value, icon: Icon, trend, trendUp, className }: StatCardProps) {
  return (
    <Card className={cn("glass-panel glow-effect border-white/5 relative overflow-hidden group", className)}>
      <div className="absolute top-0 right-0 p-4 opacity-10 transform translate-x-4 -translate-y-4 group-hover:scale-110 transition-transform duration-500">
        <Icon className="w-24 h-24 text-primary" />
      </div>
      <CardContent className="p-6 relative z-10">
        <div className="flex items-center justify-between space-x-2">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="p-2 bg-primary/10 rounded-lg">
            <Icon className="w-4 h-4 text-primary" />
          </div>
        </div>
        <div className="mt-4 flex items-baseline space-x-3">
          <h2 className="text-3xl font-display font-bold text-foreground">{value}</h2>
          {trend && (
            <span className={cn("text-sm font-medium", trendUp ? "text-emerald-400" : "text-rose-400")}>
              {trendUp ? "↑" : "↓"} {trend}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
