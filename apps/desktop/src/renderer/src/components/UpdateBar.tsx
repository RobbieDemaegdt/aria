import type { AvailableUpdateInfo, UpdateStatus } from "@aria/protocol";
import { Download, Hourglass, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { openPage } from "../openPage";
import { canUpdateNow, tasksStoppedByRestart, updateBarShown, useAria } from "../store";
import { Button } from "./CardParts";

/**
 * The update bar (D80), across the top of the window: an update is available, with Update now and Later. Update now
 * downloads and installs it in the app (an installed build), or opens the download in the browser when ARIA can't.
 * While tasks are in progress it asks first, and Update when they're done downloads now and waits for them. While the
 * download runs, while it waits, and when it fails, the bar says so. Later hides it for a day; the sidebar footer's
 * dot and the tray's Update to v… stay.
 */
export function UpdateBar() {
  const update = useAria((s) => s.availableUpdate);
  const appVersion = useAria((s) => s.appVersion);
  const onboarding = useAria((s) => s.onboarding);
  const status = useAria((s) => s.updateStatus);
  const canInstallUpdates = useAria((s) => s.canInstallUpdates);
  const confirming = useAria((s) => s.updateConfirming);
  const tasks = useAria((s) => s.tasks);
  const [now, setNow] = useState(Date.now());

  // Later ends while ARIA runs: the bar comes back then.
  const until = onboarding.updateSnooze?.until;
  useEffect(() => {
    if (until === undefined) return;
    const wait = until - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 1_000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [until]);

  if (!update || !updateBarShown({ availableUpdate: update, appVersion, onboarding, updateStatus: status, updateConfirming: confirming }, now)) {
    return null;
  }
  const ours: UpdateStatus = status.phase !== "idle" && status.version === update.version ? status : { phase: "idle" };
  const installable = canUpdateNow({ availableUpdate: update, canInstallUpdates });
  const underway = ours.phase === "downloading" || ours.phase === "waiting" || ours.phase === "installing";

  return (
    <div
      data-testid="update-bar"
      data-phase={confirming && !underway ? "confirming" : ours.phase}
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-xs"
    >
      <BarBody update={update} appVersion={appVersion} status={ours} installable={installable} confirming={confirming} stopping={tasksStoppedByRestart(tasks)} />
    </div>
  );
}

function BarBody({
  update,
  appVersion,
  status,
  installable,
  confirming,
  stopping,
}: {
  update: AvailableUpdateInfo;
  appVersion: string;
  status: UpdateStatus;
  installable: boolean;
  confirming: boolean;
  stopping: number;
}) {
  const requestUpdate = useAria((s) => s.requestUpdate);
  const confirmUpdate = useAria((s) => s.confirmUpdate);
  const cancelUpdateConfirm = useAria((s) => s.cancelUpdateConfirm);
  const cancelUpdate = useAria((s) => s.cancelUpdate);
  const snoozeUpdate = useAria((s) => s.snoozeUpdate);
  const openWhatsNewModal = useAria((s) => s.openWhatsNewModal);
  const download = () => openPage(update.installerUrl ?? update.releaseUrl);

  if (status.phase === "downloading") {
    const percent = status.total > 0 ? Math.min(100, Math.floor((status.received / status.total) * 100)) : 0;
    return (
      <>
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-warn" />
        <span className="text-fg">
          Downloading ARIA v{status.version}… <span className="font-mono text-muted">{percent}%</span>
        </span>
        <div className="h-1 min-w-24 flex-1 overflow-hidden rounded-full bg-raised" data-testid="update-bar-progress">
          <div className="h-full bg-warn transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </>
    );
  }

  if (status.phase === "installing") {
    return (
      <>
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-warn" />
        <span className="text-fg">Restarting ARIA to install v{status.version}…</span>
      </>
    );
  }

  if (status.phase === "waiting") {
    return (
      <>
        <Hourglass className="h-3.5 w-3.5 shrink-0 text-warn" />
        <span className="min-w-0 flex-1 text-fg" data-testid="update-bar-waiting">
          ARIA v{status.version} is ready. It installs, and ARIA restarts, once no task is in progress.
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button testId="update-bar-cancel-wait" onClick={() => void cancelUpdate()}>
            Cancel
          </Button>
          <Button testId="update-bar-restart-now" primary onClick={() => void confirmUpdate()} title="Tasks in progress stop, and you can resume them after the restart">
            Restart now
          </Button>
        </div>
      </>
    );
  }

  if (confirming) {
    const what =
      stopping === 0
        ? "Updating restarts ARIA."
        : `${stopping === 1 ? "1 task is" : `${stopping} tasks are`} in progress. Updating restarts ARIA: ${
            stopping === 1 ? "it stops" : "they stop"
          }, and you can resume ${stopping === 1 ? "it" : "them"} after the restart.`;
    return (
      <>
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warn" />
        <span className="min-w-0 flex-1 text-fg" data-testid="update-bar-question">
          {what}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button testId="update-bar-cancel" onClick={cancelUpdateConfirm}>
            Cancel
          </Button>
          {stopping > 0 && (
            <Button testId="update-bar-when-done" onClick={() => void confirmUpdate({ whenIdle: true })}>
              Update when {stopping === 1 ? "it's" : "they're"} done
            </Button>
          )}
          <Button testId="update-bar-confirm" primary onClick={() => void confirmUpdate()}>
            Update and restart
          </Button>
        </div>
      </>
    );
  }

  if (status.phase === "failed") {
    return (
      <>
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-bad" />
        <span className="min-w-0 flex-1 text-fg" data-testid="update-bar-error">
          Couldn't update to v{status.version}. <span className="text-muted">{status.reason}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button testId="update-bar-download" onClick={download}>
            Download instead
          </Button>
          <Button testId="update-bar-later" onClick={() => void snoozeUpdate()}>
            Later
          </Button>
          {installable && (
            <Button testId="update-bar-retry" primary onClick={requestUpdate}>
              Try again
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <Download className="h-3.5 w-3.5 shrink-0 text-warn" />
      <span className="min-w-0 flex-1 text-fg" data-testid="update-bar-text">
        <span className="font-semibold">ARIA v{update.version}</span> is available{" "}
        <span className="text-muted">(you have v{appVersion})</span>
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button testId="update-bar-whats-new" onClick={() => openWhatsNewModal()}>
          What's new
        </Button>
        <Button testId="update-bar-later" onClick={() => void snoozeUpdate()}>
          Later
        </Button>
        {installable ? (
          <Button testId="update-bar-update" primary onClick={requestUpdate}>
            Update now
          </Button>
        ) : (
          <Button testId="update-bar-download" primary onClick={download} title="Opens the installer's download in your browser">
            <Download className="h-3.5 w-3.5" /> Download
          </Button>
        )}
      </div>
    </>
  );
}
