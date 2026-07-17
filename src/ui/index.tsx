import React, { useState } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
} from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import type { AgentWriteAccess } from "../worker.js";

interface AgentSummary {
  id: string;
  name: string;
  adapterType: string;
  configurable: boolean;
  hermesHome: string | null;
}

const styles = {
  wrap: { fontFamily: "inherit", padding: 16, maxWidth: 720 },
  row: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  note: { fontSize: 13, opacity: 0.75, margin: "8px 0" },
  error: { color: "#c0392b", margin: "8px 0" },
  code: { fontFamily: "monospace", fontSize: 13 },
} as const;

function WriteAccessEditor({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const { data, loading, error, refresh } = usePluginData<AgentWriteAccess>(
    "agent-write-access",
    { companyId, agentId },
  );
  const save = usePluginAction("set-agent-write-access");
  const [draft, setDraft] = useState<string[] | null>(null);
  const [newRoot, setNewRoot] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (loading) return <div style={styles.wrap}>Loading…</div>;
  if (error) return <div style={{ ...styles.wrap, ...styles.error }}>{error.message}</div>;
  if (!data) return null;

  if (!data.configurable) {
    return (
      <div style={styles.wrap}>
        <p>
          <strong>{data.agentName}</strong> uses the{" "}
          <code style={styles.code}>{data.adapterType}</code> adapter — it does
          not run on Hermes, so there is no write sandbox to manage here.
        </p>
      </div>
    );
  }

  const roots = draft ?? data.roots;
  const dirty = draft !== null;

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await save({ companyId, agentId, roots });
      setDraft(null);
      refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.wrap}>
      <h3>Write access — {data.agentName}</h3>
      <p style={styles.note}>
        Profile: <code style={styles.code}>{data.hermesHome}</code>. {data.note}
      </p>
      <p style={styles.note}>
        With no roots configured, the <code style={styles.code}>write_file</code>/
        <code style={styles.code}>patch</code> tools may write anywhere outside the
        protected paths; adding roots restricts those tools to the listed
        directories. This is a tool-level control, not a sandbox — the agent&apos;s
        terminal is not path-restricted on the local backend.
      </p>

      <h4>Allowed write roots</h4>
      {roots.length === 0 && <p style={styles.note}>No roots configured (writes unrestricted).</p>}
      {roots.map((root, i) => (
        <div key={`${i}:${root}`} style={styles.row}>
          <code style={{ ...styles.code, flex: 1 }}>{root}</code>
          <button
            type="button"
            onClick={() => setDraft(roots.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div style={styles.row}>
        <input
          style={{ flex: 1 }}
          placeholder="/absolute/path or ~/path"
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
        />
        <button
          type="button"
          disabled={newRoot.trim().length === 0}
          onClick={() => {
            const value = newRoot.trim();
            if (!roots.includes(value)) setDraft([...roots, value]);
            setNewRoot("");
          }}
        >
          Add
        </button>
      </div>

      <div style={styles.row}>
        <button type="button" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button type="button" onClick={() => setDraft(null)} disabled={saving}>
            Discard
          </button>
        )}
      </div>
      {saveError && <p style={styles.error}>{saveError}</p>}

      <h4>Always protected (enforced by Hermes)</h4>
      <ul>
        {data.protectedPaths.map((p) => (
          <li key={p}>
            <code style={styles.code}>{p}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FileAccessPage() {
  const context = useHostContext();
  const companyId = context.companyId ?? "";
  const { data: agents, loading, error } = usePluginData<AgentSummary[]>(
    "hermes-agents",
    { companyId },
  );
  const [selected, setSelected] = useState<string>("");

  if (!companyId) return <div style={styles.wrap}>No active company.</div>;
  if (loading) return <div style={styles.wrap}>Loading agents…</div>;
  if (error) return <div style={{ ...styles.wrap, ...styles.error }}>{error.message}</div>;

  const hermesAgents = (agents ?? []).filter((a) => a.configurable);

  return (
    <div style={styles.wrap}>
      <h2>File Access Manager</h2>
      <p style={styles.note}>
        Manages each Hermes agent&apos;s write sandbox (
        <code style={styles.code}>HERMES_WRITE_SAFE_ROOT</code> in the
        profile&apos;s <code style={styles.code}>.env</code>).
      </p>
      {hermesAgents.length === 0 ? (
        <p>No Hermes-backed agents in this company.</p>
      ) : (
        <div style={styles.row}>
          <label htmlFor="fam-agent">Agent:</label>
          <select
            id="fam-agent"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select an agent…</option>
            {hermesAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {selected && (
        <WriteAccessEditor key={selected} companyId={companyId} agentId={selected} />
      )}
    </div>
  );
}

export function AgentFileAccessTab({ context }: PluginDetailTabProps) {
  if (!context.companyId || !context.entityId) {
    return <div style={styles.wrap}>Missing agent context.</div>;
  }
  return (
    <WriteAccessEditor
      key={context.entityId}
      companyId={context.companyId}
      agentId={context.entityId}
    />
  );
}
