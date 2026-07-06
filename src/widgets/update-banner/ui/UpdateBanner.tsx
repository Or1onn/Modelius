// UpdateBanner.tsx — sidebar footer banner shown when a newer release exists.
// Click downloads + installs the update, then relaunches the app.
import { useEffect, useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { checkForUpdate, installAndRelaunch } from "@/features/check-update/model/updater";

export function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    checkForUpdate().then((u) => {
      if (alive && u) setVersion(u.version);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!version || dismissed) return null;

  const apply = async () => {
    if (updating) return;
    setUpdating(true);
    try {
      await installAndRelaunch();
    } catch {
      setUpdating(false);
    }
  };

  return (
    <div className="sb-update">
      <div className="sb-update-row">
        <span className="sb-update-ic">
          <Icon name="download" size={15} />
        </span>
        <span className="sb-update-txt">
          <span className="sb-update-title">{updating ? "Updating Modelius…" : "Update available"}</span>
          <span className="sb-update-sub">
            {updating ? "Restarting to apply" : `v${version} · ready to install`}
          </span>
        </span>
        <button className="sb-update-x" title="Dismiss" onClick={() => setDismissed(true)}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <button className="sb-update-btn" onClick={apply}>
        {updating && (
          <span className="upd-spin">
            <Icon name="refresh" size={13} stroke={1.8} />
          </span>
        )}
        {updating ? "Restarting…" : "Restart to update"}
      </button>
    </div>
  );
}
