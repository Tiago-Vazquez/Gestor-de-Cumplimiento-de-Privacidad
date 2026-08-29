import { CheckCircle2, CircleAlert, CircleDot, Clock3, Database, FileCheck2, Pause, ShieldAlert } from 'lucide-react';

type StatusBadgeProps = {
  value: string;
  kind?: 'status' | 'severity' | 'scan' | 'generic';
};

const labels: Record<string, string> = {
  open: 'Abierto',
  in_review: 'En revisión',
  resolved: 'Resuelto',
  critical: 'Crítico',
  high: 'Alto',
  medium: 'Medio',
  low: 'Bajo',
  healthy: 'Saludable',
  warning: 'Atención',
  offline: 'Sin conexión',
  monitoring: 'Monitoreando',
  scanning: 'Escaneando',
  paused: 'Pausado',
  queued: 'En cola',
  running: 'En curso',
  completed: 'Completado',
  generating: 'Generando',
  ready: 'Listo',
  production: 'Producción',
  staging: 'Staging',
  development: 'Desarrollo',
};

const iconFor = (value: string) => {
  if (value === 'resolved' || value === 'healthy' || value === 'ready' || value === 'completed') return CheckCircle2;
  if (value === 'critical' || value === 'high' || value === 'warning' || value === 'offline') return CircleAlert;
  if (value === 'in_review' || value === 'medium' || value === 'running' || value === 'scanning') return CircleDot;
  if (value === 'queued' || value === 'generating') return Clock3;
  if (value === 'paused') return Pause;
  if (value === 'production' || value === 'staging' || value === 'development') return Database;
  if (value === 'open') return ShieldAlert;
  return FileCheck2;
};

export function StatusBadge({ value, kind = 'generic' }: StatusBadgeProps) {
  const Icon = iconFor(value);
  const tone = value === 'critical' || value === 'high' || value === 'offline'
    ? 'status-danger'
    : value === 'medium' || value === 'warning' || value === 'in_review' || value === 'scanning' || value === 'running'
      ? 'status-warn'
      : value === 'resolved' || value === 'healthy' || value === 'ready' || value === 'completed'
        ? 'status-good'
        : value === 'low'
          ? 'status-calm'
          : 'status-neutral';

  return (
    <span className={`status-badge ${tone}`} data-testid={`status-${kind}-${value}`}>
      <Icon size={13} strokeWidth={2.3} aria-hidden="true" />
      {labels[value] ?? value}
    </span>
  );
}