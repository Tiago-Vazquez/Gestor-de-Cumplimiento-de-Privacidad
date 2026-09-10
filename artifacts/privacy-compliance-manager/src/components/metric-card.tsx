import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';

export function MetricCard({ label, value, detail, icon: Icon, tone = 'teal', trend }: { label: string; value: string; detail: string; icon: LucideIcon; tone?: 'teal' | 'amber' | 'coral' | 'navy'; trend?: string }) {
  const accents = { teal: 'bg-[#e4f2ef] text-[#237b6c]', amber: 'bg-[#fff0d8] text-[#9c681d]', coral: 'bg-[#fae6e1] text-[#b14e43]', navy: 'bg-[#e5eaf3] text-[#3f577c]' };
  return (
    <div className="group rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)] transition-transform duration-300 hover:-translate-y-0.5" data-testid={`card-metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
      <div className="flex items-start justify-between gap-3">
        <div className={`grid h-9 w-9 place-items-center rounded-xl ${accents[tone]}`}><Icon size={18} strokeWidth={2} /></div>
        {trend && <span className={`flex items-center gap-0.5 font-mono text-[10px] font-medium ${trend.startsWith('+') ? 'text-[#258774]' : 'text-[#c1604f]'}`}>{trend.startsWith('+') ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{trend}</span>}
      </div>
      <div className="mt-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground">{label}</p>
        <p className="mt-1 font-display text-[29px] font-bold tracking-[-0.05em] text-foreground">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function LoadingCards() {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="loading-cards">{[1, 2, 3, 4].map((item) => <div className="h-[170px] rounded-2xl border border-border bg-card p-5" key={item}><div className="skeleton h-9 w-9 rounded-xl" /><div className="mt-6 skeleton h-3 w-24 rounded" /><div className="mt-2 skeleton h-8 w-32 rounded" /><div className="mt-2 skeleton h-3 w-40 rounded" /></div>)}</div>;
}