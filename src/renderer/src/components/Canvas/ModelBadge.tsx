import { useEffect, useState } from "react";
import { Brain, Check, ChevronDown, Loader2 } from "lucide-react";
import clsx from "clsx";
import type { ModelInfo } from "@shared/ipc";
import type { AppSettings, CanvasNode, NodeId, Provider } from "@shared/types";
import { useCanvasStore, useCanvasStoreApi } from "@/hooks/useCanvasStore";
import { useClaudeCapabilities } from "@/hooks/useClaudeCapabilities";
import { ProviderLogo } from "./ProviderLogo";
import { BadgePopover } from "./BadgePopover";

/** Used until the CLI answers, and whenever the capability probe fails. */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-7", displayName: "Opus 4.7" },
  { id: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];

type NonClaudeOption = { provider: Exclude<Provider, "claude">; label: string };

const NON_CLAUDE_OPTIONS: NonClaudeOption[] = [
  { provider: "codex", label: "GPT-5.3 Codex" },
  { provider: "cursor", label: "Auto" },
];

type ProviderUsageTotals = Record<
  Provider,
  { turns: number; totalTokens: number; totalCostUsd: number; hasTokenData: boolean; hasCostData: boolean }
>;

type Props = { nodeId: NodeId };

export function ModelBadge({ nodeId }: Props) {
  const effectiveProvider = useCanvasStore((s) => s.getEffectiveProvider(nodeId));
  const overrideProvider = useCanvasStore((s) => s.nodes[nodeId]?.data.nodeSettings?.provider);
  const overrideModel = useCanvasStore((s) => s.nodes[nodeId]?.data.nodeSettings?.model);
  const cwd = useCanvasStore((s) => s.getEffectiveCwd(nodeId));
  // Label-only read: the probe itself is deferred until the popover opens, so
  // loading a canvas never spawns a CLI per node.
  const { models } = useClaudeCapabilities(cwd, { enabled: false });
  const claudeModels = models.length > 0 ? models : FALLBACK_MODELS;

  const [globalModel, setGlobalModel] = useState<string | undefined>(undefined);
  useEffect(() => {
    void window.api.settings.read().then((s: AppSettings) => {
      setGlobalModel(s.providers?.claude?.model ?? s.claudeModel ?? undefined);
    });
  }, []);

  const overridden = overrideProvider !== undefined || overrideModel !== undefined;

  const activeModelId = effectiveProvider === "claude"
    ? (overrideModel ?? globalModel ?? claudeModels[0]?.id ?? "claude-opus-4-7")
    : null;

  const badgeLabel = activeModelId
    ? (claudeModels.find((m) => m.id === activeModelId)?.displayName ?? activeModelId)
    : NON_CLAUDE_OPTIONS.find((o) => o.provider === effectiveProvider)?.label ?? effectiveProvider;

  return (
    <BadgePopover
      title={`Model: ${badgeLabel}${overridden ? " (node override)" : " (canvas)"} · click to switch`}
      overridden={overridden}
      ariaHasPopup="listbox"
      label={
        <>
          <ProviderLogo provider={effectiveProvider} size={10} />
          <span className="tracking-tight text-[8px]">{badgeLabel}</span>
          {effectiveProvider === "claude" && (
            <Brain className="w-[10px] h-[10px] text-amber-500 opacity-90" />
          )}
          <ChevronDown className="w-[8px] h-[8px] text-muted-foreground" />
        </>
      }
    >
      {({ close }) => (
        <ModelOptions
          nodeId={nodeId}
          cwd={cwd}
          effectiveProvider={effectiveProvider}
          activeModelId={activeModelId}
          close={close}
        />
      )}
    </BadgePopover>
  );
}

function ModelOptions({
  nodeId,
  cwd,
  effectiveProvider,
  activeModelId,
  close,
}: {
  nodeId: NodeId;
  cwd: string | undefined;
  effectiveProvider: Provider;
  activeModelId: string | null;
  close: () => void;
}) {
  const setNodeSettings = useCanvasStore((s) => s.setNodeSettings);
  const storeApi = useCanvasStoreApi();
  const { models, loading, error } = useClaudeCapabilities(cwd);
  const claudeModels = models.length > 0 ? models : FALLBACK_MODELS;
  const usageByProvider = aggregateUsage(storeApi.getState().nodes);

  return (
    <div role="listbox">
      <div
        className="flex items-center gap-1 px-2.5 pt-2 pb-1 text-[8px] uppercase tracking-[0.14em] text-muted-foreground"
        style={{ fontFamily: "var(--font-geist-mono)" }}
      >
        Node model
        {loading && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      </div>

      {claudeModels.map((m) => {
        const isActive = effectiveProvider === "claude" && activeModelId === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={isActive}
            title={m.description}
            onClick={() => {
              setNodeSettings(nodeId, { provider: "claude", model: m.id });
              close();
            }}
            className={clsx(
              "w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer",
              isActive ? "bg-accent/15 text-foreground" : "text-foreground hover:bg-muted",
            )}
          >
            <ProviderLogo provider="claude" size={12} />
            <span className="flex-1 min-w-0">
              <span className="block truncate">{m.displayName}</span>
              <span className="block text-[9px] text-muted-foreground">
                {formatUsage(usageByProvider.claude)}
              </span>
            </span>
            {isActive && <Check className="h-3 w-3 text-foreground/70" />}
          </button>
        );
      })}

      {error && (
        <div className="px-2.5 py-1 text-[9px] text-muted-foreground">
          Model list unavailable — showing defaults.
        </div>
      )}

      <div className="mx-2.5 my-1 border-t border-border/40" />

      {NON_CLAUDE_OPTIONS.map((opt) => {
        const isActive = effectiveProvider === opt.provider;
        return (
          <button
            key={opt.provider}
            type="button"
            role="option"
            aria-selected={isActive}
            onClick={() => {
              setNodeSettings(nodeId, { provider: opt.provider, model: undefined });
              close();
            }}
            className={clsx(
              "w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer",
              isActive ? "bg-accent/15 text-foreground" : "text-foreground hover:bg-muted",
            )}
          >
            <ProviderLogo provider={opt.provider} size={12} />
            <span className="flex-1 min-w-0">
              <span className="block truncate">{opt.label}</span>
              <span className="block text-[9px] text-muted-foreground">
                {formatUsage(usageByProvider[opt.provider])}
              </span>
            </span>
            {isActive && <Check className="h-3 w-3 text-foreground/70" />}
          </button>
        );
      })}
    </div>
  );
}

function aggregateUsage(nodes: Record<string, CanvasNode>): ProviderUsageTotals {
  const out: ProviderUsageTotals = {
    claude: emptyUsage(),
    codex: emptyUsage(),
    cursor: emptyUsage(),
  };
  for (const node of Object.values(nodes)) {
    for (const message of node.data.chat.messages) {
      if (message.role !== "assistant") continue;
      const p = message.provider;
      if (p !== "claude" && p !== "codex" && p !== "cursor") continue;
      out[p].turns += 1;
      if (message.usage?.totalTokens !== undefined) {
        out[p].totalTokens += message.usage.totalTokens;
        out[p].hasTokenData = true;
      }
      if (message.usage?.totalCostUsd !== undefined) {
        out[p].totalCostUsd += message.usage.totalCostUsd;
        out[p].hasCostData = true;
      }
    }
  }
  return out;
}

function emptyUsage() {
  return { turns: 0, totalTokens: 0, totalCostUsd: 0, hasTokenData: false, hasCostData: false };
}

function formatUsage(usage: ProviderUsageTotals[Provider]): string {
  const parts: string[] = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`];
  if (usage.hasTokenData) parts.push(`${formatNumber(usage.totalTokens)} tok`);
  if (usage.hasCostData) parts.push(`$${usage.totalCostUsd.toFixed(4)}`);
  return parts.join(" · ");
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}
