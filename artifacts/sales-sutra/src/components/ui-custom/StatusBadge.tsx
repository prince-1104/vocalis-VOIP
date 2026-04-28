import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  let variant = "default";
  let label = status.replace(/_/g, " ");
  
  switch (status.toLowerCase()) {
    case "active":
    case "interested":
    case "answered":
    case "completed":
      variant = "success";
      break;
    case "pending":
    case "draft":
    case "callback":
    case "callback_requested":
      variant = "warning";
      break;
    case "paused":
    case "busy":
    case "voicemail":
    case "no_answer":
      variant = "secondary";
      break;
    case "not_interested":
    case "failed":
      variant = "destructive";
      break;
  }

  const baseClasses = "px-2.5 py-0.5 capitalize font-medium tracking-wide shadow-sm border";
  
  const variantMap: Record<string, string> = {
    success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    destructive: "bg-rose-500/10 text-rose-400 border-rose-500/20",
    secondary: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
    default: "bg-primary/10 text-primary border-primary/20",
  };
  const variantClasses = variantMap[variant] || variantMap.default;

  return (
    <Badge variant="outline" className={cn(baseClasses, variantClasses, className)}>
      {label}
    </Badge>
  );
}
