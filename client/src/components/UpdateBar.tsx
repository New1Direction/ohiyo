import { updateReadyLabel } from "../lib/appUpdate";

type Props = {
  version: string;
  isInstalling: boolean;
  onInstall: () => void;
  onLater: () => void;
};

/** Offers a new version of the desktop app. It asks first; it never installs by itself. */
export function UpdateBar({ version, isInstalling, onInstall, onLater }: Props) {
  return (
    <div className="kc-update-bar" role="status">
      {isInstalling ? (
        <span>Updating… Ohiyo will restart.</span>
      ) : (
        <>
          <span className="kc-update-bar__text">{updateReadyLabel(version)}</span>
          <button type="button" className="kc-update-bar__go" onClick={onInstall}>Update now</button>
          <button type="button" className="kc-update-bar__later" onClick={onLater}>Later</button>
        </>
      )}
    </div>
  );
}
