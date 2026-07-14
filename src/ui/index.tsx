import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentFileAccessState,
  PermissionState,
} from "../paperclip-types.js";

// These APIs are injected by the Paperclip host at runtime.
declare const paperclip: {
  api: {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body: unknown) => Promise<unknown>;
  };
};

interface TreeNode {
  path: string;
  name: string;
  kind: "file" | "dir";
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

function stateLabel(s: PermissionState | undefined): string {
  if (s === "R") return "R";
  if (s === "RW") return "RW";
  if (s === "D") return "D";
  return "-";
}

function stateClass(s: PermissionState | undefined): string {
  if (s === "R") return "fac-state-r";
  if (s === "RW") return "fac-state-rw";
  if (s === "D") return "fac-state-d";
  return "fac-state-none";
}

const FileAccessEditor: React.FC<{
  agentId?: string;
  profileName?: string;
}> = ({ agentId, profileName }) => {
  const [state, setState] = useState<AgentFileAccessState | null>(null);
  const [root, setRoot] = useState<string>("/");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const apiPath = agentId
    ? `/agents/${agentId}/file-access`
    : `/agents/default/file-access`;

  const refresh = useCallback(async () => {
    setStatus("Loading...");
    setError("");
    try {
      const data = (await paperclip.api.get(apiPath)) as AgentFileAccessState;
      setState(data);
      setStatus(`Profile: ${data.profileName}`);
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus("");
    }
  }, [apiPath]);

  const loadChildren = useCallback(async (parentPath: string) => {
    try {
      const children = (await paperclip.api.get(
        `/scan?root=${encodeURIComponent(parentPath)}`,
      )) as string[];
      return children.map((child) => ({
        path: child,
        name: child.split("/").pop() || child,
        kind: "dir" as const,
        expanded: false,
      }));
    } catch (e: any) {
      setError(e?.message || String(e));
      return [];
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    (async () => {
      const nodes = await loadChildren(root);
      setTree(nodes);
    })();
  }, [root, loadChildren]);

  const paths = useMemo(() => state?.paths ?? {}, [state]);

  const setPathState = useCallback(
    (target: string, next: PermissionState | undefined) => {
      setState((prev) => {
        if (!prev) return prev;
        const nextPaths = { ...prev.paths };
        if (next === undefined) delete nextPaths[target];
        else nextPaths[target] = next;
        return { ...prev, paths: nextPaths };
      });
    },
    [],
  );

  const save = useCallback(async () => {
    setStatus("Saving...");
    setError("");
    try {
      await paperclip.api.post(apiPath, { paths: state?.paths ?? {} });
      setStatus("Saved");
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus("");
    }
  }, [apiPath, state?.paths]);

  const toggleExpand = useCallback(
    async (node: TreeNode) => {
      const nextTree = [...tree];
      if (node.expanded) {
        node.expanded = false;
        setTree(nextTree);
        return;
      }
      node.loading = true;
      setTree(nextTree);
      const children = await loadChildren(node.path);
      node.children = children;
      node.expanded = true;
      node.loading = false;
      setTree([...nextTree]);
    },
    [loadChildren, tree],
  );

  const cycleState = useCallback((node: TreeNode) => {
    const current = paths[node.path];
    const order: (PermissionState | undefined)[] = [undefined, "R", "RW", "D"];
    const next = order[(order.indexOf(current) + 1) % order.length];
    setPathState(node.path, next);
  }, [paths, setPathState]);

  const renderNode = (node: TreeNode, siblings: TreeNode[], idx: number) => {
    const current = paths[node.path];
    return (
      <div key={node.path} className="fac-node" style={{ marginLeft: 16 }}>
        <div className="fac-row">
          <span
            className="fac-expander"
            onClick={() => toggleExpand(node)}
            style={{ cursor: "pointer", minWidth: 18, display: "inline-block" }}
          >
            {node.kind === "dir" ? (node.expanded ? "▼" : "▶") : "·"}
          </span>
          <span className="fac-name" style={{ flex: 1 }}>{node.name}</span>
          <button
            className={`fac-state ${stateClass(current)}`}
            onClick={() => cycleState(node)}
            title="Click to cycle: none, R, RW, D"
          >
            {stateLabel(current)}
          </button>
          {node.loading && <span className="fac-loading">…</span>}
        </div>
        {node.expanded && node.children && (
          <div className="fac-children">
            {node.children.map((child, i) => renderNode(child, node.children!, i))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fac-editor" style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h3>File Access Manager</h3>
      {profileName && <p>Profile: {profileName}</p>}
      <div className="fac-toolbar" style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <label>
          Root:{" "}
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
          />
        </label>
        <button onClick={refresh}>Refresh</button>
        <button onClick={save}>Save</button>
      </div>
      {status && <div className="fac-status">{status}</div>}
      {error && <div className="fac-error" style={{ color: "red" }}>{error}</div>}
      <div className="fac-tree">
        {tree.map((node, idx) => renderNode(node, tree, idx))}
      </div>
      <h4>Configured paths</h4>
      <ul className="fac-path-list">
        {Object.entries(paths).map(([p, s]) => (
          <li key={p}>
            {p} => <span className={`fac-state ${stateClass(s)}`}>{stateLabel(s)}</span>
            <button onClick={() => setPathState(p, undefined)}>Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const FileAccessPage: React.FC = () => {
  return <FileAccessEditor />;
};

export const AgentFileAccessTab: React.FC<{ agentId: string }> = ({ agentId }) => {
  return <FileAccessEditor agentId={agentId} />;
};

export { FileAccessEditor };
export default FileAccessPage;
