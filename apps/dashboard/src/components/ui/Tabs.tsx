import React from "react";

export interface TabDef<K extends string = string> {
  key: K;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  count?: number;
  hidden?: boolean;
  href?: string;
}

interface TabsProps<K extends string> {
  tabs: TabDef<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
}

export function Tabs<K extends string>({ tabs, value, onChange, className = "" }: TabsProps<K>) {
  return (
    <div className={`flex items-center gap-1 overflow-x-auto border-b border-border/60 scrollbar-hide ${className}`}>
      {tabs
        .filter((tab) => !tab.hidden)
        .map(({ key, label, icon: Icon, href, count }) => {
          const active = key === value;
          const itemClass = `relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors ${
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
          }`;
          const inner = (
            <>
              {Icon && <Icon className="size-4" />}
              {label}
              {count !== undefined && count > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${active ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground"}`}>
                  {count}
                </span>
              )}
              {active && <span className="absolute bottom-0 start-4 end-4 h-0.5 rounded-full bg-primary" />}
            </>
          );
          return href ? (
            <a
              key={key}
              href={href}
              className={itemClass}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onChange(key);
              }}
            >
              {inner}
            </a>
          ) : (
            <button key={key} type="button" onClick={() => onChange(key)} className={itemClass}>
              {inner}
            </button>
          );
        })}
    </div>
  );
}

export default Tabs;
