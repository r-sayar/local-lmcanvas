import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import clsx from "clsx";
import type { NodeId, TodoStatus } from "@shared/types";
import { useCanvasStore } from "@/hooks/useCanvasStore";

type Props = { nodeId: NodeId };

/** The run's live TodoWrite state, pinned on the node instead of buried in a tool call. */
export function TodoList({ nodeId }: Props) {
  const todos = useCanvasStore((s) => s.todos[nodeId]);
  if (!todos || todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="nodrag my-2 rounded-[8px] border border-border bg-muted/30 px-2.5 py-1.5">
      <div className="mb-1 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>plan</span>
        <span className="ml-auto font-mono">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[10px]">
            <TodoIcon status={t.status} />
            <span
              className={clsx(
                "min-w-0 flex-1 break-words",
                t.status === "completed" && "text-muted-foreground line-through",
                t.status === "in_progress" && "font-medium text-foreground",
                t.status === "pending" && "text-foreground",
              )}
            >
              {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TodoIcon({ status }: { status: TodoStatus }) {
  if (status === "completed") {
    return <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-foreground" />;
  }
  if (status === "in_progress") {
    return <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-muted-foreground" />;
  }
  return <Circle size={12} className="mt-0.5 shrink-0 text-border" />;
}
