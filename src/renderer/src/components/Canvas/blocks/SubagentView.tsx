import { useState } from "react";
import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import clsx from "clsx";
import type { SubagentBlock } from "@shared/types";
import { TextBlockView } from "./TextBlockView";
import { ThinkingView } from "./ThinkingView";
import { ToolUseView } from "./ToolUseView";

type Props = {
  block: SubagentBlock;
  nodeId?: string;
  /** The parent `Task` call is still running. */
  running?: boolean;
};

/** Nested transcript of a subagent, folded under the `Task` call that spawned it. */
export function SubagentView({ block, nodeId, running = false }: Props) {
  const [expanded, setExpanded] = useState(false);
  const label = block.summary?.trim() || "Subagent";
  const toolCount = block.blocks.filter((b) => b.type === "tool_use").length;

  return (
    <div className="my-1 nodrag overflow-hidden rounded-[8px] border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-muted cursor-pointer"
        aria-expanded={expanded}
      >
        <ChevronRight
          size={11}
          className={clsx(
            "shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <Sparkles size={11} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[10px] text-foreground">{label}</span>
        {toolCount > 0 && (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
            {toolCount} {toolCount === 1 ? "tool" : "tools"}
          </span>
        )}
        {running && <Loader2 size={11} className="shrink-0 animate-spin text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="flex flex-col gap-1 border-t border-border bg-muted/30 p-1.5">
          {block.blocks.length === 0 ? (
            <div className="px-1 text-[10px] text-muted-foreground">
              (no output yet)
            </div>
          ) : (
            block.blocks.map((b, i) => {
              if (b.type === "text") {
                return <TextBlockView key={i} text={b.text} nodeId={nodeId} />;
              }
              if (b.type === "thinking") {
                return <ThinkingView key={i} text={b.text} />;
              }
              return <ToolUseView key={b.id || i} block={b} nodeId={nodeId} />;
            })
          )}
        </div>
      )}
    </div>
  );
}
