import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  maxWidth?: string;
  maxHeight?: string;
  /** Fixed height — keeps the dialog from resizing (and shifting) when content changes. */
  height?: string;
  showCloseButton?: boolean;
  closable?: boolean;
  footer?: ReactNode;
  zIndex?: number;
  /** Attached to the scrollable content area — lets callers reset scroll position. */
  contentRef?: React.Ref<HTMLDivElement>;
}

export function Modal({
  isOpen,
  onClose,
  children,
  width = "100%",
  maxWidth = "80vw",
  maxHeight = "90vh",
  height,
  showCloseButton = true,
  closable = true,
  footer = null,
  zIndex = 10000,
  contentRef,
}: ModalProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (isOpen) {
      const frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => setIsVisible(true));
      });
      return () => cancelAnimationFrame(frame);
    }
    setIsVisible(false);
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (closable && e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex }} onClick={handleBackdropClick}>
      <div className="absolute inset-0 backdrop-blur-lg transition-opacity duration-300" style={{ background: "var(--th-overlay)", opacity: isVisible ? 1 : 0 }} />
      <div
        className="relative w-full rounded-2xl shadow-2xl flex flex-col transition-all duration-300 !overflow-x-hidden border border-border/50"
        style={{
          background: "rgb(var(--card))",
          width,
          maxWidth,
          maxHeight,
          height,
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? "scale(1) translateY(0)" : "scale(0.95) translateY(10px)",
        }}
      >
        {showCloseButton && (
          <button
            onClick={onClose}
            className="absolute top-4 end-4 z-10 p-1.5 rounded-lg bg-card hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shadow-sm"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        )}
        <div ref={contentRef} className="w-full min-h-0 flex-1 flex flex-col overflow-auto [scrollbar-gutter:stable]">{children}</div>
        {footer}
      </div>
    </div>,
    document.body,
  );
}
