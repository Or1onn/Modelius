// WorktreePanel.tsx — the changes panel for a chat running in an isolated worktree: what the
// agent touched, and the four ways out (commit, merge back, keep the branch, discard). Merging is
// the only action that touches the user's own working tree, and the Rust side refuses it unless
// that tree is clean and already on the base branch.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import {
  commitWorktree,
  mergeWorktree,
  removeWorktree,
  worktreeStatus,
  type WorktreeInfo,
  type WorktreeStatus,
} from "@/entities/agent/model/git";

// Porcelain XY → a word. Only the codes a coding agent actually produces are spelled out.
function statusLabel(code: string): string {
  const c = code.trim();
  if (c === "??") return "new";
  if (c.startsWith("R")) return "renamed";
  if (c.startsWith("D")) return "deleted";
  if (c.startsWith("A")) return "added";
  return "modified";
}

export function WorktreePanel({
  worktree,
  title,
  busy,
  onClose,
  onCleared,
}: {
  worktree: WorktreeInfo;
  title: string; // chat name — the default commit message
  busy: boolean; // a turn is running: mutating the checkout under the agent would be a race
  onClose: () => void;
  onCleared: () => void; // the worktree is gone — the chat falls back to its folder
}) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await worktreeStatus(worktree.path, worktree.base));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [worktree.path, worktree.base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every action shares the same shape: block the panel, run, surface git's own error text.
  async function act(name: string, fn: () => Promise<void>, after?: () => void) {
    if (working || busy) return;
    setWorking(name);
    setError("");
    try {
      await fn();
      if (after) after();
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking("");
    }
  }

  const dirty = (status?.files.length ?? 0) > 0;
  const ahead = status?.ahead ?? 0;
  const disabled = !!working || busy;

  return (
    <div className="search-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wt-box">
        <div className="gw-head">
          <span>
            <Icon name="gitBranch" size={14} /> {worktree.branch}
          </span>
          <button className="gw-close" onClick={onClose} title="Close">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="wt-body">
          <p className="gw-hint">
            Isolated checkout of <span className="mono">{worktree.base}</span> — your project folder keeps
            its branch and its uncommitted work. Dependencies aren't copied here, so the agent may need
            to install them before it can build.
          </p>
          <div className="wt-path mono" title={worktree.path}>{worktree.path}</div>

          {status && (
            <div className="wt-summary">
              {dirty ? `${status.files.length} uncommitted file${status.files.length === 1 ? "" : "s"}` : "working tree clean"}
              {ahead > 0 && ` · ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${worktree.base}`}
            </div>
          )}

          {dirty && (
            <div className="wt-files">
              {status!.files.map((f) => (
                <div className="wt-file" key={f.path}>
                  <span className="wt-file-badge" data-kind={statusLabel(f.status)}>{statusLabel(f.status)}</span>
                  <span className="wt-file-path mono" title={f.path}>{f.path}</span>
                </div>
              ))}
            </div>
          )}

          {status && status.diff.trim() && (
            <pre className="wt-diff mono">
              {status.diff.split("\n").map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")
                      ? "wt-dl head"
                      : line.startsWith("@@")
                        ? "wt-dl hunk"
                        : line.startsWith("+")
                          ? "wt-dl add"
                          : line.startsWith("-")
                            ? "wt-dl del"
                            : "wt-dl"
                  }
                >
                  {line || " "}
                </span>
              ))}
              {status.truncated && <span className="wt-dl hunk">… diff truncated</span>}
            </pre>
          )}

          {status && !dirty && ahead === 0 && !status.diff.trim() && (
            <div className="wt-empty">Nothing changed in this worktree yet.</div>
          )}

          {error && <div className="wt-error">{error}</div>}

          <div className="wt-actions">
            <button
              className="wt-btn"
              disabled={disabled || !dirty}
              onClick={() => void act("commit", () => commitWorktree(worktree.path, title || "Modelius session"))}
            >
              {working === "commit" ? "Committing…" : "Commit changes"}
            </button>
            <button
              className="wt-btn primary"
              disabled={disabled || ahead === 0 || dirty}
              title={
                dirty
                  ? "Commit the changes first"
                  : `Merge into ${worktree.base} with --no-ff, then drop the checkout and the merged branch`
              }
              onClick={() =>
                void act(
                  "merge",
                  async () => {
                    await mergeWorktree(worktree.repo, worktree.base, worktree.branch);
                    // The work now lives in the base — the checkout and its branch are spare parts.
                    await removeWorktree(worktree, true);
                  },
                  () => {
                    onCleared();
                    onClose();
                  }
                )
              }
            >
              {working === "merge" ? "Merging…" : `Merge into ${worktree.base}`}
            </button>
            <span style={{ flex: 1 }} />
            <button
              className="wt-btn"
              disabled={disabled}
              title="Remove the checkout, keep the branch for a PR"
              onClick={() => {
                // Removing the checkout takes uncommitted work with it — the branch only carries
                // what was committed.
                if (dirty && !confirm("Uncommitted changes in this worktree will be lost. Remove it anyway?")) return;
                void act("keep", () => removeWorktree(worktree, false), () => {
                  onCleared();
                  onClose();
                });
              }}
            >
              {working === "keep" ? "Removing…" : "Keep branch"}
            </button>
            <button
              className="wt-btn danger"
              disabled={disabled}
              title="Remove the checkout and delete the branch — the work is lost"
              onClick={() => {
                if (!confirm(`Delete ${worktree.branch} and everything in it?`)) return;
                void act("delete", () => removeWorktree(worktree, true), () => {
                  onCleared();
                  onClose();
                });
              }}
            >
              {working === "delete" ? "Deleting…" : "Discard"}
            </button>
          </div>
          {busy && <div className="wt-note">The agent is still working — actions are paused until the turn ends.</div>}
        </div>
      </div>
    </div>
  );
}
