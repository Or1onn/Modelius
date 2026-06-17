// MemoryList.tsx — grouped, editable list of remembered facts (rows + toggle).
import { useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { useMemoryStore, MEMORY_KINDS, type Memory } from "@/entities/memory/model/memory";

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={"switch" + (on ? " on" : "")} onClick={onClick} aria-label={on ? "Enabled" : "Disabled"}>
      <span className="switch-knob" />
    </button>
  );
}

function MemoryRow({ m }: { m: Memory }) {
  const { updateMemory, deleteMemory } = useMemoryStore();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(m.text);

  function saveEdit() {
    const t = val.trim();
    if (t) updateMemory(m.id, { text: t });
    else setVal(m.text);
    setEditing(false);
  }

  return (
    <div className={"mem-row" + (m.enabled ? "" : " off")}>
      <Switch on={m.enabled} onClick={() => updateMemory(m.id, { enabled: !m.enabled })} />
      {editing ? (
        <input
          className="mem-edit"
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={saveEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveEdit();
            if (e.key === "Escape") {
              setVal(m.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="mem-text" onClick={() => setEditing(true)} title="Click to edit">
          {m.text}
        </span>
      )}
      <div className="mem-acts">
        <button className="mem-act" title="Edit" onClick={() => setEditing((e) => !e)}>
          <Icon name="edit" size={14} />
        </button>
        <button className="mem-act danger" title="Delete" onClick={() => deleteMemory(m.id)}>
          <Icon name="xCircle" size={14} />
        </button>
      </div>
    </div>
  );
}

// Remembered facts grouped by kind; empty groups skipped.
export function MemoryList({ memories }: { memories: Memory[] }) {
  return (
    <>
      {MEMORY_KINDS.map((k) => {
        const items = memories.filter((m) => m.kind === k.id);
        if (!items.length) return null;
        return (
          <div key={k.id} className="mem-group">
            <div className="mem-group-label">
              {k.label}
              <span className="mem-count">{items.length}</span>
            </div>
            <div className="mem-list">
              {items.map((m) => (
                <MemoryRow key={m.id} m={m} />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
