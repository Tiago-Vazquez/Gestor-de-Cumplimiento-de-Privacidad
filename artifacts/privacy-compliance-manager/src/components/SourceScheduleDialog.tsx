import { useState } from "react";
import { useUpdateSourceSchedule, getGetSourceScheduleQueryKey } from "@workspace/api-client-react";
import type { SourceSchedule } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const SCAN_SCHEDULE_DEFAULT_MINUTES = 1440;
const MIN_INTERVAL = 15;
const MAX_INTERVAL = 10080;

const INTERVAL_OPTIONS = [
  { label: "1 hora", value: 60 },
  { label: "6 horas", value: 360 },
  { label: "12 horas", value: 720 },
  { label: "24 horas", value: 1440 },
  { label: "7 días", value: 10080 },
];

interface SourceScheduleDialogProps {
  sourceId: string;
  schedule: SourceSchedule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SourceScheduleDialog({ sourceId, schedule, open, onOpenChange }: SourceScheduleDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [intervalMinutes, setIntervalMinutes] = useState(schedule?.intervalMinutes ?? SCAN_SCHEDULE_DEFAULT_MINUTES);
  const [error, setError] = useState<string | null>(null);

  const mutation = useUpdateSourceSchedule({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSourceScheduleQueryKey(sourceId) });
        toast({ title: "Programación actualizada" });
        onOpenChange(false);
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : "No se pudo guardar");
      },
    },
  });

  function handleSave() {
    setError(null);

    if (enabled) {
      if (intervalMinutes < MIN_INTERVAL || intervalMinutes > MAX_INTERVAL) {
        setError(`El intervalo debe estar entre ${MIN_INTERVAL} y ${MAX_INTERVAL} minutos`);
        return;
      }
      mutation.mutate({ id: sourceId, data: { enabled: true, intervalMinutes } });
    } else {
      mutation.mutate({ id: sourceId, data: { enabled: false, intervalMinutes } });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Programación de escaneos</DialogTitle>
          <DialogDescription>
            Configura la frecuencia de escaneos automáticos para esta fuente.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="schedule-enabled">Escaneo programado</Label>
            <Switch
              id="schedule-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="switch-enabled"
            />
          </div>

          {enabled && (
            <div className="space-y-2">
              <Label htmlFor="schedule-interval">Intervalo</Label>
              <Select
                value={String(intervalMinutes)}
                onValueChange={(v) => setIntervalMinutes(Number(v))}
              >
                <SelectTrigger id="schedule-interval" data-testid="select-interval">
                  <SelectValue placeholder="Seleccionar intervalo" />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive" data-testid="error-message">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            onClick={handleSave}
            disabled={mutation.isPending}
            data-testid="button-save"
          >
            {mutation.isPending ? "Guardando..." : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { SCAN_SCHEDULE_DEFAULT_MINUTES, MIN_INTERVAL, MAX_INTERVAL, INTERVAL_OPTIONS };