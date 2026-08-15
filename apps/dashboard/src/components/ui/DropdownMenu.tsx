import React, { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { DismissiblePopover } from "./Popover";

export interface MenuAction {
  id: string;
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  variant?: "default" | "danger" | "success" | "warning";
  disabled?: boolean;
  divider?: boolean;
}

interface DropdownMenuProps {
  actions: MenuAction[];
  trigger?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
}

const DropdownMenu: React.FC<DropdownMenuProps> = ({ actions, trigger, align = "right", className = "", triggerClassName = "", disabled = false }) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleActionClick = (action: MenuAction) => {
    if (!action.disabled && action.onClick) {
      action.onClick();
      setIsOpen(false);
    }
  };

  return (
    <DismissiblePopover open={isOpen} onOpenChange={setIsOpen} className={`relative ${className}`}>
      <button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={
          triggerClassName ||
          `p-2 rounded-lg transition-all duration-200 ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-muted active:bg-muted/80"}`
        }
        type="button"
        style={{ backgroundColor: isOpen && !triggerClassName ? "var(--muted)" : undefined }}
      >
        {trigger || <MoreHorizontal className="w-4 h-4 text-muted-foreground" />}
      </button>

      {isOpen && (
        <div
          className={`absolute z-50 mt-2 rounded-2xl border border-border/60 bg-popover shadow-xl shadow-black/[0.12] overflow-hidden animate-fade-in ${align === "right" ? "end-0" : "start-0"}`}
          style={{ minWidth: "220px" }}
        >
          <div className="py-1.5 px-1.5 flex flex-col">
            {actions.map((action, index) => {
              if (!action.label && action.divider) {
                return <div key={action.id} className="my-2 mx-3 border-t border-border/50" />;
              }
              const danger = action.variant === "danger";
              const success = action.variant === "success";
              const warning = action.variant === "warning";
              return (
                <React.Fragment key={action.id}>
                  <button
                    onClick={() => handleActionClick(action)}
                    disabled={action.disabled}
                    className={`w-full hover:bg-foreground/[0.06] active:bg-foreground/[0.1] px-3 py-2.5 text-start flex items-center gap-3 transition-all duration-200 rounded-xl ${
                      action.disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                    }`}
                    type="button"
                    style={{
                      color: action.disabled ? "var(--muted-foreground)" : danger ? "rgb(var(--destructive))" : success ? "rgb(var(--success))" : warning ? "rgb(var(--warning))" : "var(--foreground)",
                    }}
                  >
                    {action.icon && <span className="w-5 h-5 flex items-center justify-center flex-shrink-0">{action.icon}</span>}
                    <span className="text-[14px] font-medium truncate">{action.label}</span>
                  </button>
                  {action.divider && index < actions.length - 1 && <div className="my-2 mx-3 border-t border-border/50" />}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </DismissiblePopover>
  );
};

export default DropdownMenu;
