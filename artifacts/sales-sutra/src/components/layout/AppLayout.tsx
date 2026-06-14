import React from "react";
import { Link, useLocation } from "wouter";
import { useAuth, clearStoredToken } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Megaphone,
  Phone,
  PhoneForwarded,
  Bot,
  GraduationCap,
  ScrollText,
  BarChart3,
  Menu,
  LogOut,
  Shield,
  Receipt,
  Globe,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { adminFetch } from "@/lib/admin-fetch";

const ALL_NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "manager", "superadmin"] },
  { href: "/contacts", label: "Contacts", icon: Users, roles: ["admin", "manager", "superadmin"] },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone, roles: ["admin", "manager", "superadmin"] },
  { href: "/calls", label: "Call Logs", icon: Phone, roles: ["admin", "manager", "superadmin"] },
  { href: "/dialer", label: "Dialer", icon: PhoneForwarded, roles: ["admin", "manager", "superadmin"] },
  { href: "/agent", label: "AI Agent", icon: Bot, roles: ["admin", "superadmin"] },
  { href: "/widget", label: "Web Widget", icon: Globe, roles: ["admin", "superadmin"] },
  { href: "/training", label: "Training", icon: GraduationCap, roles: ["admin", "superadmin"] },
  { href: "/scripts", label: "Scripts", icon: ScrollText, roles: ["admin", "superadmin"] },
  { href: "/analytics", label: "Analytics", icon: BarChart3, roles: ["admin", "manager", "superadmin"] },
  { href: "/billing", label: "Billing", icon: Receipt, roles: ["admin", "manager", "superadmin"] },
];

const ROLE_BADGE: Record<string, { label: string; className: string }> = {
  superadmin: { label: "Superadmin", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  admin: { label: "Admin", className: "bg-primary/20 text-primary border-primary/30" },
  manager: { label: "Manager", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, role, isSuperadmin } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const queryClient = useQueryClient();

  const [profileOpen, setProfileOpen] = React.useState(false);
  const [profileName, setProfileName] = React.useState("");
  const [profileEmail, setProfileEmail] = React.useState("");
  const [profilePhone, setProfilePhone] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [isSavingProfile, setIsSavingProfile] = React.useState(false);
  const [isSavingPassword, setIsSavingPassword] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    if (user && profileOpen) {
      setProfileName(user.name || "");
      setProfileEmail(user.email || "");
      setProfilePhone(user.phone || "");
    }
  }, [user, profileOpen]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingProfile(true);
    try {
      await adminFetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/auth/profile`, {
        method: "PUT",
        body: JSON.stringify({
          name: profileName,
          email: profileEmail,
          phone: profilePhone,
        }),
      });
      toast({ title: "Profile updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["auth-me"] });
      setProfileOpen(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ title: "Error", description: "New passwords do not match", variant: "destructive" });
      return;
    }
    setIsSavingPassword(true);
    try {
      await adminFetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/auth/profile/password`, {
        method: "PUT",
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      toast({ title: "Password updated successfully" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setProfileOpen(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsSavingPassword(false);
    }
  };

  const effectiveRole = isSuperadmin ? "superadmin" : (role ?? "manager");
  const navItems = ALL_NAV_ITEMS.filter((item) => item.roles.includes(effectiveRole));
  const roleBadge = ROLE_BADGE[effectiveRole];

  function handleLogout() {
    clearStoredToken();
    queryClient.clear();
    window.location.href = "/login";
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-72 bg-card/80 backdrop-blur-xl border-r border-white/5 transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:flex lg:flex-col",
        mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex items-center h-20 px-6 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              <img
                src={`${import.meta.env.BASE_URL}dialog-by-nmc-logo.png`}
                alt="Dialog by NMC"
                className="h-9 w-auto object-contain"
              />
              {user?.tenantName && (
                <p className="text-xs text-muted-foreground truncate max-w-[180px] mt-0.5">{user.tenantName}</p>
              )}
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-6 px-4 space-y-1.5">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group relative",
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                )}
              >
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full shadow-[0_0_10px_rgba(124,58,237,0.5)]" />
                )}
                <item.icon className={cn("w-5 h-5 transition-colors", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                {item.label}
              </Link>
            );
          })}

          {isSuperadmin && (
            <Link
              href="/admin"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-amber-400 hover:bg-amber-500/10 transition-all duration-200 mt-4 border border-amber-500/20"
            >
              <Shield className="w-5 h-5" />
              Tenant Mgmt
            </Link>
          )}
        </nav>

        <div className="p-4 border-t border-white/5 space-y-3">
          <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
            <DialogTrigger asChild>
              <div className="glass-panel rounded-xl p-3 flex items-center gap-3 cursor-pointer hover:bg-white/5 transition-all duration-200 group">
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30 shrink-0 transition-colors group-hover:border-primary/50">
                  <span className="font-bold text-primary text-xs">
                    {user?.name?.charAt(0) || user?.email?.charAt(0) || 'U'}
                  </span>
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{user?.name || user?.email || 'User'}</p>
                  {roleBadge && (
                    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 mt-0.5", roleBadge.className)}>
                      {roleBadge.label}
                    </Badge>
                  )}
                </div>
              </div>
            </DialogTrigger>
            <DialogContent className="glass-panel sm:max-w-[425px] border-white/10 text-foreground">
              <DialogHeader>
                <DialogTitle className="text-xl font-display font-bold">Account Settings</DialogTitle>
              </DialogHeader>
              <Tabs defaultValue="profile" className="mt-4">
                <TabsList className="grid grid-cols-2 bg-background/50 border border-white/5 rounded-lg p-1">
                  <TabsTrigger value="profile" className="rounded-md data-[state=active]:bg-primary/20 data-[state=active]:text-primary transition-all">
                    Profile
                  </TabsTrigger>
                  <TabsTrigger value="password" className="rounded-md data-[state=active]:bg-primary/20 data-[state=active]:text-primary transition-all">
                    Password
                  </TabsTrigger>
                </TabsList>
                
                <TabsContent value="profile" className="space-y-4 mt-4 focus-visible:outline-none">
                  <form onSubmit={handleSaveProfile} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="profile-name">Name</Label>
                      <Input
                        id="profile-name"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        placeholder="Your full name"
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="profile-email">Email Address</Label>
                      <Input
                        id="profile-email"
                        type="email"
                        required
                        value={profileEmail}
                        onChange={(e) => setProfileEmail(e.target.value)}
                        placeholder="name@example.com"
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="profile-phone">Phone Number</Label>
                      <Input
                        id="profile-phone"
                        value={profilePhone}
                        onChange={(e) => setProfilePhone(e.target.value)}
                        placeholder="+1 (555) 000-0000"
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <Button type="submit" className="w-full mt-2" disabled={isSavingProfile}>
                      {isSavingProfile ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Save Changes"
                      )}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="password" className="space-y-4 mt-4 focus-visible:outline-none">
                  <form onSubmit={handleSavePassword} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="current-password">Current Password</Label>
                      <Input
                        id="current-password"
                        type="password"
                        required
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="new-password">New Password</Label>
                      <Input
                        id="new-password"
                        type="password"
                        required
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirm-password">Confirm New Password</Label>
                      <Input
                        id="confirm-password"
                        type="password"
                        required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <Button type="submit" className="w-full mt-2" disabled={isSavingPassword}>
                      {isSavingPassword ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Updating...
                        </>
                      ) : (
                        "Change Password"
                      )}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
          
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-red-400 text-xs"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4" /> Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <img
          src={`${import.meta.env.BASE_URL}images/mesh-bg.png`}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-20 pointer-events-none mix-blend-screen"
        />

        <header className="h-20 flex items-center justify-between px-6 border-b border-white/5 bg-background/50 backdrop-blur-md relative z-10 lg:hidden">
          <img
            src={`${import.meta.env.BASE_URL}dialog-by-nmc-logo.png`}
            alt="Dialog by NMC"
            className="h-8 w-auto object-contain"
          />
          <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(true)}>
            <Menu className="w-6 h-6" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto relative z-10">
          <div className="max-w-7xl mx-auto p-6 lg:p-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
