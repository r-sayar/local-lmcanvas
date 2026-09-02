import type { ReactNode } from "react";
import {
  Bot,
  Coins,
  History,
  Loader2,
  RefreshCw,
  Repeat,
  Server,
  Shield,
  Sparkles,
  Users,
  Webhook,
  Gauge,
} from "lucide-react";
import clsx from "clsx";
import type { McpServerInfo, McpServerState } from "@shared/ipc";
import type { AppSettings, EffortLevel, PermissionMode } from "@shared/types";
import { EFFORT_LEVELS, PERMISSION_MODES } from "@shared/types";
import { useClaudeCapabilities } from "@/hooks/useClaudeCapabilities";
import { Toggle } from "./Toggle";

type Props = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  /** Directory the capability probe runs in. Empty string = the user's home scope. */
  cwd?: string;
  /** Only probe while the modal is actually on screen. */
  active: boolean;
};

export function ClaudeSettings({ settings, onChange, cwd, active }: Props) {
  const caps = useClaudeCapabilities(cwd ?? "", { enabled: active });

  return (
    <>
      <div className="pt-2 mt-1 border-t border-border">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          agent defaults
        </h3>
        <div className="flex flex-col gap-2">
          <ChoiceRow
            icon={<Shield className="h-4 w-4" />}
            label="Default permission mode"
            description="Applied to new nodes that don't override it."
            options={PERMISSION_MODES.map((m) => ({ value: m, label: m }))}
            value={settings.defaultPermissionMode ?? "acceptEdits"}
            onSelect={(value: PermissionMode) => onChange({ defaultPermissionMode: value })}
          />

          <ChoiceRow
            icon={<Gauge className="h-4 w-4" />}
            label="Default effort"
            description="How much reasoning the model spends per turn."
            options={[
              { value: undefined, label: "cli default" },
              ...EFFORT_LEVELS.map((e) => ({ value: e, label: e })),
            ]}
            value={settings.defaultEffort}
            onSelect={(value: EffortLevel | undefined) => onChange({ defaultEffort: value })}
          />

          <Toggle
            enabled={settings.checkpointing ?? false}
            onToggle={() => onChange({ checkpointing: !(settings.checkpointing ?? false) })}
            label="File checkpointing"
            description="Snapshot files each turn so a run can be rewound."
            icon={<History className="w-4 h-4" />}
          />
          <Toggle
            enabled={settings.showHookEvents ?? false}
            onToggle={() => onChange({ showHookEvents: !(settings.showHookEvents ?? false) })}
            label="Show hook events"
            description="Surface hook lifecycle events while a run is in flight."
            icon={<Webhook className="w-4 h-4" />}
          />
          <Toggle
            enabled={settings.forwardSubagentText ?? false}
            onToggle={() =>
              onChange({ forwardSubagentText: !(settings.forwardSubagentText ?? false) })
            }
            label="Forward subagent text"
            description="Render the nested transcript inside Task blocks instead of a spinner."
            icon={<Bot className="w-4 h-4" />}
          />
          <Toggle
            enabled={settings.agentProgressSummaries ?? false}
            onToggle={() =>
              onChange({
                agentProgressSummaries: !(settings.agentProgressSummaries ?? false),
              })
            }
            label="Subagent progress summaries"
            description="Ask running subagents for a periodic one-line status."
            icon={<Sparkles className="w-4 h-4" />}
          />

          <NumberRow
            icon={<Repeat className="h-4 w-4" />}
            label="Max turns"
            description="Stop a run after this many turns. Empty = uncapped."
            value={settings.maxTurns}
            min={1}
            step={1}
            placeholder="∞"
            onChange={(value) => onChange({ maxTurns: value })}
          />
          <NumberRow
            icon={<Coins className="h-4 w-4" />}
            label="Max budget (USD)"
            description="Stop a run once it costs this much. Empty = uncapped."
            value={settings.maxBudgetUsd}
            min={0}
            step={0.5}
            placeholder="∞"
            onChange={(value) => onChange({ maxBudgetUsd: value })}
          />
        </div>
      </div>

      <div className="pt-2 mt-1 border-t border-border">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            claude environment
          </h3>
          <button
            type="button"
            onClick={caps.refresh}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer"
          >
            {caps.loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            refresh
          </button>
        </div>

        {caps.error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            {caps.error}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Panel icon={<Server className="h-4 w-4" />} title="mcp servers">
              {caps.mcpServers.length === 0 ? (
                <Empty loading={caps.loading}>No MCP servers configured.</Empty>
              ) : (
                <ul className="flex flex-col gap-1">
                  {caps.mcpServers.map((server) => (
                    <McpRow key={server.name} server={server} />
                  ))}
                </ul>
              )}
            </Panel>

            <Panel icon={<Sparkles className="h-4 w-4" />} title="skills">
              {caps.skills.length === 0 ? (
                <Empty loading={caps.loading}>No skills discovered.</Empty>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {caps.skills.map((skill) => (
                    <span
                      key={skill}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              )}
            </Panel>

            <Panel icon={<Users className="h-4 w-4" />} title="subagents">
              {caps.agents.length === 0 ? (
                <Empty loading={caps.loading}>No subagents discovered.</Empty>
              ) : (
                <ul className="flex flex-col gap-1">
                  {caps.agents.map((agent) => (
                    <li key={agent.name} className="text-[11px]">
                      <span className="font-medium text-foreground">{agent.name}</span>
                      {agent.model && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          {agent.model}
                        </span>
                      )}
                      {agent.description && (
                        <div className="text-[10px] leading-snug text-muted-foreground">
                          {agent.description}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}

const STATUS_STYLES: Record<McpServerState, string> = {
  connected: "border-emerald-500/40 text-emerald-500",
  failed: "border-destructive/40 text-destructive",
  "needs-auth": "border-amber-500/40 text-amber-500",
  pending: "border-border text-muted-foreground",
  disabled: "border-border text-muted-foreground",
};

function McpRow({ server }: { server: McpServerInfo }) {
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-foreground">{server.name}</span>
        <span
          className={clsx(
            "rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide",
            STATUS_STYLES[server.status],
          )}
        >
          {server.status}
        </span>
        {server.tools && server.tools.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {server.tools.length} tools
          </span>
        )}
      </div>
      {server.error && (
        <div className="text-[10px] leading-snug text-destructive">{server.error}</div>
      )}
    </li>
  );
}

function Panel({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="w-full rounded-xl border border-border bg-card px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium text-foreground">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {loading && <Loader2 className="h-3 w-3 animate-spin" />}
      {loading ? "Asking the CLI…" : children}
    </div>
  );
}

function ChoiceRow<T extends string | undefined>({
  icon,
  label,
  description,
  options,
  value,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <button
            key={opt.label}
            type="button"
            onClick={() => onSelect(opt.value)}
            className={clsx(
              "rounded-md border px-2 py-1 text-[11px] cursor-pointer transition-colors",
              opt.value === value
                ? "border-foreground/40 bg-accent text-foreground"
                : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumberRow({
  icon,
  label,
  description,
  value,
  min,
  step,
  placeholder,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  value: number | undefined;
  min: number;
  step: number;
  placeholder: string;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
      <input
        type="number"
        min={min}
        step={step}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? undefined : Number(raw));
        }}
        aria-label={label}
        className="w-20 shrink-0 rounded-md border border-border bg-background px-2 py-1 text-right text-xs tabular-nums"
      />
    </div>
  );
}
