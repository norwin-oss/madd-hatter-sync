import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  ShoppingCart,
  CreditCard,
  BarChart3,
  Package,
  Tag,
  SlidersHorizontal,
  Users,
  Settings,
  Menu,
  X,
  ChevronDown,
  Receipt,
  TrendingUp,
  MoreHorizontal,
  User as UserIcon,
  LogOut,
  UserCog,
  Search,
  UsersRound,
} from "lucide-react";
import { HatIcon } from "./brand-icon";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isSuperAdminEmail } from "@/lib/integration/super-admin";

type NavLeaf = { to: string; label: string; icon: React.ComponentType<{ className?: string }> };
type NavGroup = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavLeaf[];
};
type NavEntry = NavLeaf | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return (e as NavGroup).children !== undefined;
}

const NAV: NavEntry[] = [
  { to: "/admin", label: "Home", icon: LayoutDashboard },
  {
    label: "Sales Activity",
    icon: ShoppingCart,
    children: [
      { to: "/admin/orders", label: "Orders", icon: Receipt },
      { to: "/admin/transactions", label: "Transactions", icon: CreditCard },
    ],
  },
  {
    label: "Reports",
    icon: BarChart3,
    children: [
      { to: "/admin/analytics", label: "Sales Overview", icon: TrendingUp },
      { to: "/admin/products", label: "Item Sales", icon: Package },
      { to: "/admin/product-buyer-search", label: "Product Buyer Search", icon: Search },
      { to: "/admin/audience-builder", label: "Audience Builder", icon: UsersRound },
    ],
  },
  {
    label: "Items",
    icon: Package,
    children: [
      { to: "/admin/items", label: "Item List", icon: Package },
      { to: "/admin/categories", label: "Categories", icon: Tag },
      { to: "/admin/modifiers", label: "Modifier Groups", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Data Tools",
    icon: SlidersHorizontal,
    children: [
      { to: "/admin/historical-import", label: "Historical Import", icon: SlidersHorizontal },
      { to: "/admin/pos-data", label: "POS Data", icon: Package },
    ],
  },
  { to: "/admin/employees", label: "Employees", icon: Users },
  { to: "/admin/customers", label: "Customers", icon: Users },
  { to: "/admin/customer-purchases", label: "Customer Purchases", icon: ShoppingCart },
  { to: "/admin/product-mapping", label: "Product Mapping", icon: Package },
  { to: "/admin/purchase-mapping", label: "Purchase Mapping", icon: Tag },
  { to: "/admin/logs", label: "Sync Logs", icon: Receipt },
];

// Routes that exist as real pages vs "coming soon" placeholders.
const COMING_SOON = new Set<string>(["/admin/modifiers"]);

export function AdminShell({
  email,
  onLogout,
  children,
}: {
  email: string | null;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Expand a group if any child is active.
  const initiallyExpanded = NAV.map((e, i) =>
    isGroup(e) && e.children.some((c) => pathname.startsWith(c.to)) ? i : -1,
  ).filter((i) => i >= 0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set(initiallyExpanded));

  const isActive = (to: string) =>
    to === "/admin" ? pathname === "/admin" : pathname.startsWith(to);

  const toggleGroup = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const renderItem = (entry: NavEntry, index: number) => {
    if (isGroup(entry)) {
      const Icon = entry.icon;
      const open = expanded.has(index);
      const hasActiveChild = entry.children.some((c) => isActive(c.to));
      return (
        <div key={entry.label}>
          <button
            onClick={() => toggleGroup(index)}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-colors",
              hasActiveChild
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="h-4.5 w-4.5" />
            <span className="flex-1 text-left">{entry.label}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
          </button>
          {open && (
            <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border/60 pl-3">
              {entry.children.map((child) => {
                const CIcon = child.icon;
                const active = isActive(child.to);
                const soon = COMING_SOON.has(child.to);
                return (
                  <Link
                    key={child.to}
                    to={child.to}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors",
                      active
                        ? "bg-primary/10 font-bold text-primary"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      soon && "pointer-events-none opacity-50",
                    )}
                  >
                    <CIcon className="h-3.5 w-3.5" />
                    {child.label}
                    {soon && (
                      <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                        Soon
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      );
    }
    const Icon = entry.icon;
    const active = isActive(entry.to);
    return (
      <Link
        key={entry.to}
        to={entry.to}
        onClick={() => setMobileOpen(false)}
        className={cn(
          "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-colors",
          active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <Icon className="h-4.5 w-4.5" />
        {entry.label}
      </Link>
    );
  };

  const navList = <nav className="flex flex-col gap-1 px-3 py-4">{NAV.map(renderItem)}</nav>;

  const brand = (
    <Link to="/admin" className="flex items-center gap-2.5 px-5 py-5">
      <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-primary/10">
        <HatIcon className="h-5.5 w-5.5 text-primary" />
      </span>
      <div className="leading-tight">
        <div className="text-sm font-extrabold text-foreground">Madd Hatter</div>
        <div className="text-[11px] font-semibold text-muted-foreground">POS Sync</div>
      </div>
    </Link>
  );

  const initial = (email ?? "?").trim().charAt(0).toUpperCase() || "?";

  const userChip = (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <button
          id="sidebar-user-chip"
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Open user menu"
          className="flex w-full items-center gap-2.5 rounded-2xl bg-muted/40 px-2.5 py-2.5 text-left transition-colors hover:bg-muted"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-extrabold text-primary">
            {initial}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-bold text-foreground">
            {email ?? "User"}
          </span>
          <MoreHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-64 rounded-2xl p-1.5">
        <div
          className="truncate px-2.5 py-2 text-[11px] font-semibold text-muted-foreground"
          title={email ?? ""}
        >
          {email ?? ""}
        </div>
        <div className="h-px bg-border" />
        <Link
          to="/admin/profile"
          id="user-menu-profile"
          onClick={() => {
            setMenuOpen(false);
            setMobileOpen(false);
          }}
          className="flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-sm font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UserIcon className="h-4 w-4" />
          Profile
        </Link>
        <Link
          to="/admin/settings"
          id="user-menu-settings"
          onClick={() => {
            setMenuOpen(false);
            setMobileOpen(false);
          }}
          className="flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-sm font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
        {isSuperAdminEmail(email) && (
          <Link
            to="/admin/user-management"
            id="user-menu-user-management"
            onClick={() => {
              setMenuOpen(false);
              setMobileOpen(false);
            }}
            className="flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-sm font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <UserCog className="h-4 w-4" />
            User Management
          </Link>
        )}
        <div className="h-px bg-border" />
        <button
          type="button"
          id="user-menu-logout"
          onClick={() => {
            setMenuOpen(false);
            setMobileOpen(false);
            onLogout();
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left text-sm font-bold text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </PopoverContent>
    </Popover>
  );

  const footer = <div className="mt-auto border-t border-border/60 px-3 py-3">{userChip}</div>;

  return (
    <div className="min-h-screen bg-muted/20">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border/60 bg-sidebar lg:flex">
        {brand}
        {navList}
        {footer}
      </aside>

      <div className="flex h-14 items-center justify-between border-b border-border/60 bg-background px-4 lg:hidden">
        <Link to="/admin" className="flex items-center gap-2">
          <HatIcon className="h-6 w-6 text-primary" />
          <span className="text-sm font-extrabold text-foreground">Madd Hatter POS</span>
        </Link>
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="flex h-9 w-9 items-center justify-center rounded-xl hover:bg-muted"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-foreground/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border/60 bg-background shadow-xl">
            <div className="flex items-center justify-between">
              {brand}
              <button
                className="mr-2 flex h-9 w-9 items-center justify-center rounded-xl hover:bg-muted"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {navList}
            {footer}
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <main className="mx-auto w-full max-w-[1700px] px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
