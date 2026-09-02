import { useEffect, useState } from "react";
import {
  Check,
  ClipboardList,
  RotateCcw,
  Shield,
  ShieldCheck,
  ShieldMinus,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import type { AppSettings, NodeId, PermissionMode } from "@shared/types";
import { PERMISSION_MODES } from "@shared/types";
import { useCanvasStore } from "@/hooks/useCanvasStore";
import { useActiveRunStore } from "@/hooks/useActiveRunStore";
import { BadgePopover } from "./BadgePopover";

type ModeMeta = {
  icon: LucideIcon;
  label: string;
  color: string;
  description: string;
};

const MODE_META: Record<PermissionMode, ModeMeta> = {
  default: {
    icon: Shield,
    label: "ask",
    color: "text-muted-foreground",
    description: "Ask before every tool that isn't already allowed.",
  },
  acceptEdits: {
    icon: ShieldCheck,
    label: "edits",
    color: "text-emerald-500",
    description: "Auto-approve file edits; still ask for everything else.",
  },
  plan: {
    icon: ClipboardList,
    label: "plan",
    color: "text-sky-500",
    description: "Research and propose a plan without touching anything.",
  },
  bypassPermissions: {
    icon: ShieldOff,
    label: "bypass",
    color: "text-destructive",
    description: "Run every tool unattended. No prompts at all.",
  },
  dontAsk: {
    icon: ShieldMinus,
    label: "no ask",
    color: "text-amber-500",
    description: "Skip prompts; deny anything not already allowed.",
  },
};

const APP_DEFAULT_MODE: PermissionMode = "acceptEdits";

type Props = { nodeId: NodeId };

/**
 * Per-node `--permission-mode`. Claude-only: codex/cursor runners ignore it.
 * When the node has a chat we can reach, the change is pushed to the live run
 * too, so a blocked turn can be unblocked without restarting it.
 */
export function PermissionModeBadge({ nodeId }: Props) {
  const provider = useCanvasStore((s) => s.getEffectiveProvider(nodeId));
  const override = useCanvasStore(
    (s) => s.nodes[nodeId]?.data.nodeSettings?.permissionMode,
  );
  const setNodeSettings = useCanvasStore((s) => s.setNodeSettings);
  // Every chat event carries its node, so this is the live run for this node —
  // not just one that happens to be blocked on an approval.
  const liveChatId = useActiveRunStore((s) => s.chatIdByNode[nodeId]);

  const [appDefault, setAppDefault] = useState<PermissionMode>(APP_DEFAULT_MODE);
  useEffect(() => {
    void window.api.settings.read().then((s: AppSettings) => {
      setAppDefault(s.defaultPermissionMode ?? APP_DEFAULT_MODE);
    });
  }, []);

  if (provider !== "claude") return null;

  const active = override ?? appDefault;
  const meta = MODE_META[active];
  const ActiveIcon = meta.icon;

  const apply = (mode: PermissionMode | undefined): void => {
    setNodeSettings(nodeId, { permissionMode: mode });
    if (liveChatId) {
      void window.api.chat.setPermissionMode(liveChatId, mode ?? appDefault);
    }
  };

  return (
    <BadgePopover
      title={`Permission mode: ${active}${override ? " (node override)" : " (app default)"} · ${meta.description}`}
      overridden={override !== undefined}
      ariaHasPopup="listbox"
      panelClassName="min-w-[230px]"
      label={
        <>
          <ActiveIcon className={clsx("h-[10px] w-[10px]", meta.color)} />
          <span className="text-[8px] uppercase tracking-tight">{meta.label}</span>
        </>
      }
    >
      {({ close }) => (
        <div role="listbox">
          <div
            className="px-2.5 pt-2 pb-1 text-[8px] uppercase tracking-[0.14em] text-muted-foreground"
            style={{ fontFamily: "var(--font-geist-mono)" }}
          >
            Permission mode
          </div>

          {PERMISSION_MODES.map((mode) => {
            const m = MODE_META[mode];
            const Icon = m.icon;
            const isActive = active === mode;
            return (
              <button
                key={mode}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  apply(mode);
                  close();
                }}
                className={clsx(
                  "flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer",
                  isActive ? "bg-accent/15 text-foreground" : "text-foreground hover:bg-muted",
                )}
              >
                <Icon className={clsx("mt-[2px] h-3 w-3 shrink-0", m.color)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{mode}</span>
                  <span className="block text-[9px] leading-snug text-muted-foreground">
                    {m.description}
                  </span>
                </span>
                {isActive && <Check className="mt-[2px] h-3 w-3 shrink-0 text-foreground/70" />}
              </button>
            );
          })}

          {override !== undefined && (
            <>
              <div className="mx-2.5 my-1 border-t border-border/40" />
              <button
                type="button"
                onClick={() => {
                  apply(undefined);
                  close();
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
              >
                <RotateCcw className="h-3 w-3 shrink-0" />
                Use app default ({appDefault})
              </button>
            </>
          )}

          {liveChatId && (
            <div className="border-t border-border/40 px-2.5 py-1 text-[9px] text-muted-foreground">
              Applies to the running turn.
            </div>
          )}
        </div>
      )}
    </BadgePopover>
  );
}
