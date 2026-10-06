import { Link } from 'wouter';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  FileBarChart2,
  Fingerprint,
  Gauge,
  Layers3,
  Radar,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';

const benefits = [
  {
    icon: Database,
    title: 'Visibilidad total',
    description:
      'Conecta tus bases PostgreSQL y MySQL y descubre qué datos personales almacenas, dónde y en qué cantidad.',
  },
  {
    icon: Gauge,
    title: 'Cumplimiento medible',
    description:
      'Una puntuación de cumplimiento ponderada por severidad te muestra de un vistazo el riesgo de tu organización.',
  },
  {
    icon: FileBarChart2,
    title: 'Auditoría lista',
    description:
      'Informes PDF deterministas y descargables, generados desde un snapshot inmutable, listos para presentar.',
  },
];

const steps = [
  {
    icon: Database,
    title: 'Conecta una fuente',
    description: 'Registra una base PostgreSQL o MySQL con credenciales cifradas.',
  },
  {
    icon: Radar,
    title: 'Escanea y detecta',
    description:
      'El motor recorre esquema y filas para hallar datos personales con huella estable.',
  },
  {
    icon: Fingerprint,
    title: 'Resuelve y anonimiza',
    description:
      'Marca hallazgos como resueltos o genera datasets anonimizados para testing.',
  },
];

const securityItems = [
  'Aislamiento multi-tenant con RLS a nivel de base de datos',
  'Sesiones revocables con expiración por inactividad',
  'Credenciales de fuentes cifradas (AES-256-GCM)',
  'CSRF y CORS fail-closed',
  'Trail de auditoría con actor, recurso y resultado',
];

export default function LandingPage() {
  return (
    <div className="app-noise min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-[68px] max-w-[1200px] items-center justify-between px-5 md:px-8">
          <div className="flex items-center gap-2.5">
            <span className="relative grid h-9 w-9 place-items-center rounded-[11px] bg-sidebar-primary text-sidebar-primary-foreground">
              <ShieldCheck size={20} strokeWidth={2.2} />
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#efb34f] ring-2 ring-background" />
            </span>
            <div>
              <span className="block font-display text-[15px] font-bold tracking-[-0.02em]">Privaris</span>
              <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">
                privacidad y cumplimiento
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-lg border border-border px-4 py-2 text-xs font-bold text-muted-foreground hover:text-foreground"
            >
              Entrar
            </Link>
            <Link
              href="/login"
              className="rounded-lg bg-foreground px-4 py-2 text-xs font-bold text-background transition-transform hover:-translate-y-0.5"
            >
              Solicitar demo
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1200px] px-5 py-20 text-center md:px-8 md:py-28">
        <p className="mx-auto mb-4 inline-block rounded-full border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
          Privacidad de datos · PostgreSQL & MySQL
        </p>
        <h1 className="mx-auto max-w-3xl font-display text-[38px] font-bold leading-[1.05] tracking-[-0.04em] md:text-[56px]">
          Descubre y gobierna los datos personales de tus bases
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">
          Privaris escanea tus fuentes de datos, detecta información sensible, mide tu cumplimiento y
          genera informes auditables — sin exponer los datos.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 rounded-lg bg-foreground px-6 py-3 text-sm font-bold text-background transition-transform hover:-translate-y-0.5"
          >
            Empezar ahora <ArrowRight size={16} />
          </Link>
          <a
            href="#como-funciona"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-6 py-3 text-sm font-bold text-muted-foreground hover:text-foreground"
          >
            Ver cómo funciona
          </a>
        </div>
      </section>

      <section className="border-t border-border/70 bg-card/40">
        <div className="mx-auto grid max-w-[1200px] gap-6 px-5 py-16 md:grid-cols-3 md:px-8 md:py-20">
          {benefits.map(({ icon: Icon, title, description }) => (
            <div key={title} className="rounded-2xl border border-card-border bg-card p-6 shadow-[var(--shadow-card)]">
              <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-[#e4f2ef] text-[#237b6c]">
                <Icon size={20} />
              </div>
              <h3 className="font-display text-lg font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="como-funciona" className="mx-auto max-w-[1200px] px-5 py-16 md:px-8 md:py-20">
        <div className="mb-10 text-center">
          <div className="mb-2 flex items-center justify-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-primary">
            <Radar size={12} /> Cómo funciona
          </div>
          <h2 className="font-display text-[30px] font-bold tracking-[-0.04em]">Tres pasos hacia el control</h2>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {steps.map(({ icon: Icon, title, description }, index) => (
            <div key={title} className="rounded-2xl border border-card-border bg-card p-6 shadow-[var(--shadow-card)]">
              <div className="mb-3 flex items-center gap-3">
                <span className="font-mono text-[11px] font-bold text-primary">0{index + 1}</span>
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-[#e4f2ef] text-[#237b6c]">
                  <Icon size={18} />
                </div>
              </div>
              <h3 className="font-display text-base font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border/70 bg-card/40">
        <div className="mx-auto grid max-w-[1200px] gap-10 px-5 py-16 md:grid-cols-2 md:px-8 md:py-20">
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-primary">
              <Layers3 size={12} /> Compliance
            </div>
            <h2 className="font-display text-[26px] font-bold tracking-[-0.04em]">Una puntuación clara, no un porcentaje legal</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              La puntuación pondera los hallazgos abiertos por severidad — low=1, medium=3, high=7,
              critical=15 — y se presenta como <span className="font-semibold text-foreground">score / 100</span>.
              Es una métrica de carga de riesgo, no una certificación de cumplimiento.
            </p>
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-primary">
              <ShieldCheck size={12} /> Seguridad
            </div>
            <h2 className="font-display text-[26px] font-bold tracking-[-0.04em]">Diseñado para datos sensibles</h2>
            <ul className="mt-4 space-y-2.5">
              {securityItems.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm leading-6 text-muted-foreground">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-5 py-16 md:px-8 md:py-20">
        <div className="rounded-3xl border border-card-border bg-card p-8 shadow-[var(--shadow-card)] md:p-12">
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-primary">
            <ScrollText size={12} /> Auditoría
          </div>
          <h2 className="font-display text-[26px] font-bold tracking-[-0.04em]">Evidencia que sobrevive a backups y restores</h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Cada hallazgo tiene una huella estable; los informes PDF se generan desde un snapshot inmutable,
            de modo que lo que presentas es una foto verificable del estado de cumplimiento, no una vista viva.
          </p>
        </div>
      </section>

      <section className="border-t border-border/70">
        <div className="mx-auto max-w-[1200px] px-5 py-16 text-center md:px-8 md:py-20">
          <h2 className="mx-auto max-w-2xl font-display text-[30px] font-bold tracking-[-0.04em] md:text-[38px]">
            Listo para saber qué datos personales guardas
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
            Empieza hoy con una demo guiada o contacta con nosotros para una prueba piloto.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-lg bg-foreground px-6 py-3 text-sm font-bold text-background transition-transform hover:-translate-y-0.5"
            >
              Solicitar acceso <ArrowRight size={16} />
            </Link>
            <a
              href="mailto:contacto@privaris.example"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-6 py-3 text-sm font-bold text-muted-foreground hover:text-foreground"
            >
              Contacto comercial
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/70">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-4 px-5 py-8 text-xs text-muted-foreground md:flex-row md:px-8">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} />
            <span className="font-display font-bold text-foreground">Privaris</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em]">privacidad y cumplimiento</span>
          </div>
          <p>© 2026 Privaris</p>
        </div>
      </footer>
    </div>
  );
}
