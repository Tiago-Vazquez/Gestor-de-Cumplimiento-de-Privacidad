import { Bell, Command, Database, FileBarChart2, Fingerprint, Gauge, Layers3, LogOut, Menu, Radar, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { getGetDashboardQueryKey, useGetDashboard, useHealthCheck } from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';

const navItems = [
  { href: '/', label: 'Resumen', icon: Gauge },
  { href: '/findings', label: 'Hallazgos', icon: Radar },
  { href: '/sources', label: 'Fuentes', icon: Database },
  { href: '/rules', label: 'Reglas', icon: Layers3 },
  { href: '/masking', label: 'Anonimización', icon: Fingerprint },
  { href: '/reports', label: 'Informes', icon: FileBarChart2 },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const healthQuery = useHealthCheck();
  const healthy = healthQuery.data?.status === 'ok' || healthQuery.data?.status === 'healthy' || (!healthQuery.isError && !healthQuery.isLoading);
  const { user, logout } = useAuth();
  const dashboardQuery = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  const score = dashboardQuery.data?.complianceScore;

  return (
    <div className="app-noise min-h-[100dvh] bg-background text-foreground">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[252px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-300 md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[76px] items-center justify-between border-b border-sidebar-border px-6">
          <Link href="/" className="flex items-center gap-3" data-testid="link-brand">
            <span className="relative grid h-9 w-9 place-items-center rounded-[11px] bg-sidebar-primary text-sidebar-primary-foreground shadow-lg shadow-teal-950/20">
              <ShieldCheck size={20} strokeWidth={2.2} />
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#efb34f] ring-2 ring-sidebar" />
            </span>
            <span>
              <span className="block font-display text-[15px] font-bold tracking-[-0.02em] text-white">Sentinel</span>
              <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/55">privacy control</span>
            </span>
          </Link>
          <button className="rounded-lg p-2 text-sidebar-foreground/60 hover:bg-sidebar-accent md:hidden" onClick={() => setMobileOpen(false)} aria-label="Cerrar menú" data-testid="button-close-menu">
            <X size={18} />
          </button>
        </div>

        <div className="px-4 pt-6">
          <div className="mb-3 px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/40">Control room</div>
          <nav className="space-y-1">
            {navItems.map(({ href, label, icon: Icon }) => {
              const active = href === '/' ? location === '/' : location.startsWith(href);
              return (
                <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-colors ${active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/66 hover:bg-sidebar-accent/65 hover:text-sidebar-accent-foreground'}`} data-testid={`link-nav-${label.toLowerCase()}`}>
                  <Icon size={17} strokeWidth={active ? 2.2 : 1.8} className={active ? 'text-sidebar-primary' : 'text-sidebar-foreground/50 group-hover:text-sidebar-primary'} />
                  <span>{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="mt-auto px-4 pb-5">
          <div className="mb-4 rounded-2xl border border-sidebar-border bg-sidebar-accent/55 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-sidebar-foreground/45">Cumplimiento</span>
              <span className="text-xs font-semibold text-sidebar-primary">en vivo</span>
            </div>
            <div className="mb-2 flex items-end justify-between">
              <span className="font-display text-2xl font-bold text-white">{typeof score === 'number' ? `${score.toFixed(1)}%` : '—'}</span>
              <span className="font-mono text-[10px] text-sidebar-foreground/45">score global</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-border"><div className="h-full rounded-full bg-sidebar-primary" style={{ width: typeof score === 'number' ? `${Math.min(100, Math.max(0, score))}%` : '0%' }} /></div>
          </div>
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[#d9e6e5] font-display text-xs font-bold text-[#214d50]">{(user?.email?.[0]?.toUpperCase() ?? 'U')}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-white">{user?.email ?? 'Usuario'}</p>
              <p className="truncate text-[11px] text-sidebar-foreground/45">{user?.roles?.length ? user.roles.map((role) => role[0].toUpperCase() + role.slice(1)).join(', ') : 'sin rol'}</p>
            </div>
            <button onClick={() => logout()} className="rounded-lg p-2 text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-white" aria-label="Cerrar sesión" title="Cerrar sesión" data-testid="button-logout"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      {mobileOpen && <button className="fixed inset-0 z-30 bg-[#111c2c]/40 md:hidden" onClick={() => setMobileOpen(false)} aria-label="Cerrar navegación" data-testid="button-overlay-menu" />}

      <main className="min-h-[100dvh] md:pl-[252px]">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur-md md:px-9">
          <div className="flex items-center gap-3">
            <button className="rounded-lg border border-border p-2 text-muted-foreground md:hidden" onClick={() => setMobileOpen(true)} aria-label="Abrir menú" data-testid="button-open-menu"><Menu size={18} /></button>
            <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex" data-testid="status-system-health">
              <span className={`h-2 w-2 rounded-full ${healthy ? 'bg-[#31a886] shadow-[0_0_0_4px_hsl(163_59%_53%_/_0.12)]' : 'bg-[#d9a039]'}`} />
              {healthQuery.isLoading ? 'Comprobando sistemas' : healthy ? 'Todos los sistemas operativos' : 'Conectividad degradada'}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <button className="hidden h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground shadow-sm hover:border-primary/50 hover:text-foreground lg:flex" data-testid="button-global-search">
              <Search size={15} /><span>Buscar</span><kbd className="ml-5 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘ K</kbd>
            </button>
            <button className="relative rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Notificaciones" data-testid="button-notifications"><Bell size={18} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#df6657]" /></button>
            <button className="grid h-9 w-9 place-items-center rounded-lg bg-[#e3ecea] text-[#28675f] hover:bg-[#d7e8e4]" aria-label="Comandos" data-testid="button-commands"><Command size={16} /></button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
      <div>
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-primary"><Sparkles size={12} />{eyebrow}</div>
        <h1 className="font-display text-[30px] font-bold tracking-[-0.045em] text-foreground sm:text-[36px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}