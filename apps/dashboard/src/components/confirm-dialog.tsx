import { useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  resourceName: string;
  confirmLabel?: string;
  loading?: boolean;
  extra?: ReactNode;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, resourceName, confirmLabel = "Delete", loading = false, extra }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const matches = typed === resourceName;

  const handleClose = () => {
    if (loading) return;
    setTyped("");
    onClose();
  };

  return (
    <Modal isOpen={open} onClose={handleClose} maxWidth="440px" showCloseButton={!loading}>
      <div className="p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {description ?? "This action cannot be undone. Type the resource name to confirm."}
            </p>
          </div>
        </div>
        {extra && <div className="mt-4">{extra}</div>}
        <div className="mt-5">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Type <span className="font-mono text-foreground">{resourceName}</span> to confirm
          </label>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={resourceName} disabled={loading} autoFocus />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!matches || loading} onClick={() => onConfirm()}>
            {loading ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
