import React, { useState } from "react";
import { useLocation, Redirect } from "wouter";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { setStoredToken, useAuth } from "@/hooks/use-auth";
import { useQueryClient } from "@tanstack/react-query";

export default function Login() {
  const [, navigate] = useLocation();
  const { isAuthenticated, isLoading: authLoading, isSuperadmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [slug, setSlug] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!authLoading && isAuthenticated) {
    return <Redirect to={isSuperadmin ? "/superadmin" : "/"} />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, tenantSlug: slug || undefined }),
      });
      const data = await res.json() as { token?: string; error?: string };

      if (!res.ok) {
        toast({ title: "Login failed", description: data.error || "Invalid credentials", variant: "destructive" });
        return;
      }

      setStoredToken(data.token!);
      await queryClient.invalidateQueries();
      navigate("/");
    } catch {
      toast({ title: "Network error", description: "Please try again", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 relative overflow-hidden">
      <img
        src={`${import.meta.env.BASE_URL}images/mesh-bg.png`}
        alt=""
        className="absolute inset-0 w-full h-full object-cover opacity-20 pointer-events-none mix-blend-screen"
      />
      <div className="relative w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center mb-5">
            <img
              src={`${import.meta.env.BASE_URL}dialog-by-nmc-logo.png`}
              alt="Dialog by NMC"
              className="h-14 w-auto object-contain"
            />
          </div>
          <p className="text-muted-foreground mt-2">Sign in to your workspace</p>
        </div>

        <div className="glass-panel rounded-2xl p-8 border border-white/10">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium text-foreground/80">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="bg-white/5 border-white/10 focus:border-primary/50 h-11"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium text-foreground/80">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="bg-white/5 border-white/10 focus:border-primary/50 h-11 pr-10"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug" className="text-sm font-medium text-foreground/80">
                Workspace Slug <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="slug"
                type="text"
                placeholder="your-company"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="bg-white/5 border-white/10 focus:border-primary/50 h-11"
              />
            </div>

            <Button type="submit" className="w-full h-11 font-semibold" disabled={submitting || authLoading}>
              {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Signing in…</> : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
