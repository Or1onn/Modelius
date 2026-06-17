// MemoryScreen.tsx — manage the durable facts the assistant remembers: review, edit, toggle, delete.
import { useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { useMemoryStore, MEMORY_KINDS, type MemoryKind } from "@/entities/memory/model/memory";
import { MemoryList } from "@/widgets/memory-list/ui/MemoryList";

export function MemoryScreen() {
  const { getMemories, addMemory, clearMemories } = useMemoryStore();
  const memories = getMemories();
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [confirmClear, setConfirmClear] = useState(false);

  function add() {
    const t = draft.trim();
    if (!t) return;
    addMemory(t, kind);
    setDraft("");
  }

  return (
    <div className="screen">
      <div className="pv-wrap">
        <div className="screen-head">
          <div>
            <h1 className="screen-title">Memory</h1>
            <p className="screen-sub">
              Durable facts the assistant remembers about you across every chat. Filled automatically from your
              conversations — review, edit, or switch any off. Stored only on this device.
            </p>
          </div>
          {memories.length > 0 &&
            (confirmClear ? (
              <div className="mem-clear-confirm">
                <button className="mc-btn cancel" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
                <button
                  className="mc-btn confirm"
                  onClick={() => {
                    clearMemories();
                    setConfirmClear(false);
                  }}
                >
                  Clear all
                </button>
              </div>
            ) : (
              <button className="btn-ghost" onClick={() => setConfirmClear(true)}>
                <Icon name="xCircle" size={14} />
                Clear all
              </button>
            ))}
        </div>

        <div className="mem-add">
          <input
            className="mem-add-input"
            placeholder="Add something to remember…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <select className="mem-select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <button className="prov-cta primary" disabled={!draft.trim()} onClick={add}>
            <Icon name="plus" size={14} />
            Add
          </button>
        </div>

        {memories.length === 0 ? (
          <div className="mem-empty">
            <Icon name="spark" size={22} />
            <div className="mem-empty-t">No memories yet</div>
            <div className="mem-empty-s">As you chat, the assistant saves lasting facts about you here.</div>
          </div>
        ) : (
          <MemoryList memories={memories} />
        )}
      </div>
    </div>
  );
}
