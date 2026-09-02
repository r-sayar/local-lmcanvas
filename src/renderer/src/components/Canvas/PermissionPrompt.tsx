import { useState } from "react";
import { motion } from "framer-motion";
import { Check, ChevronDown, MessageSquareX, ShieldCheck, X } from "lucide-react";
import clsx from "clsx";
import type { PermissionRequest } from "@shared/ipc";
import { usePermissionStore } from "@/hooks/usePermissionStore";
import { getToolIcon } from "./blocks/toolMeta";

type Props = {
  request: PermissionRequest;
  /** Requests still waiting behind this one for the same node. */
  queued?: number;
};

export function PermissionPrompt({ request, queued = 0 }: Props) {
  const allow = usePermissionStore((s) => s.allow);
  const deny = usePermissionStore((s) => s.deny);

  const [showInput, setShowInput] = useState(false);
  const [showFullInput, setShowFullInput] = useState(false);
  const [feedback, setFeedback] = useState("");

  const Icon = getToolIcon(request.toolName);

  return (
    <motion.div
      key={request.id}
      className="nodrag my-2 overflow-hidden rounded-[8px] border border-yellow-400/60 bg-card"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-yellow-400/10 px-2 py-1">
        <Icon className="h-3 w-3 shrink-0 text-foreground" />
        <span className="text-[10px] font-medium text-foreground">
          {request.toolName}
        </span>
        <span className="text-[9px] text-muted-foreground">
          wants permission to run
        </span>
        {queued > 0 && (
          <span className="ml-auto rounded bg-muted px-1 py-0.5 text-[8px] text-muted-foreground">
            +{queued} queued
          </span>
        )}
      </div>

      {request.summary && (
        <div className="px-2 pt-1.5 font-mono text-[10px] leading-snug break-words text-foreground">
          {request.summary}
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowFullInput((v) => !v)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[9px] uppercase tracking-wide text-muted-foreground hover:text-foreground cursor-pointer"
        aria-expanded={showFullInput}
      >
        input
        <ChevronDown
          className={clsx("h-2.5 w-2.5 transition-transform", showFullInput && "rotate-180")}
        />
      </button>
      {showFullInput && (
        <pre className="mx-2 mb-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-muted px-2 py-1 font-mono text-[9.5px] leading-snug text-foreground">
          {prettyJson(request.input)}
        </pre>
      )}

      {showInput && (
        <div className="px-2 pb-1.5">
          <input
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") deny(request.id, feedback.trim() || undefined);
              if (e.key === "Escape") setShowInput(false);
            }}
            placeholder="Tell the agent what to do instead…"
            className="w-full rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground outline-none focus:border-accent"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-1 border-t border-border bg-muted/20 px-2 py-1.5">
        {showInput ? (
          <>
            <ActionButton onClick={() => setShowInput(false)}>Back</ActionButton>
            <ActionButton
              primary
              onClick={() => deny(request.id, feedback.trim() || undefined)}
            >
              <MessageSquareX className="h-2.5 w-2.5" />
              Send &amp; deny
            </ActionButton>
          </>
        ) : (
          <>
            <ActionButton onClick={() => setShowInput(true)}>
              Deny with feedback
            </ActionButton>
            <ActionButton destructive onClick={() => deny(request.id)}>
              <X className="h-2.5 w-2.5" />
              Deny
            </ActionButton>
            {request.alwaysAllowRule && (
              <ActionButton onClick={() => allow(request.id, true)}>
                <ShieldCheck className="h-2.5 w-2.5" />
                Always allow {request.alwaysAllowRule}
              </ActionButton>
            )}
            <ActionButton primary onClick={() => allow(request.id)}>
              <Check className="h-2.5 w-2.5" />
              Allow once
            </ActionButton>
          </>
        )}
      </div>
    </motion.div>
  );
}

function ActionButton({
  children,
  onClick,
  primary = false,
  destructive = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className={clsx(
        "flex items-center gap-1 rounded px-2 py-1 text-[10px] cursor-pointer transition-colors",
        primary
          ? "bg-foreground text-card hover:opacity-90"
          : destructive
            ? "text-destructive hover:bg-destructive/10"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}
