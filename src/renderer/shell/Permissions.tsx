import { useEffect, useState } from 'react';
import type { PermissionKind, PermissionsReport } from '../../shared/ipc/contract';
import styles from './NewRecording.module.css';

const NAMES: Record<PermissionKind, string> = {
  screen: 'Screen Recording',
  camera: 'Camera',
  microphone: 'Microphone',
  inputMonitoring: 'Input Monitoring',
};

const STATUS_TEXT: Record<PermissionsReport['items'][number]['status'], string> = {
  granted: 'Allowed',
  'not-determined': 'Not asked yet',
  denied: 'Off',
  restricted: 'Blocked on this Mac',
  unknown: 'Unknown',
};

/** The permissions report, read again when the window gets focus and on `perms.changed`. */
export function usePermissions(): [PermissionsReport | null, (report: PermissionsReport) => void] {
  const api = window.captureStudio;
  const [report, setReport] = useState<PermissionsReport | null>(null);
  useEffect(() => {
    const load = () => {
      api.perms.get().then(setReport, (e: unknown) => console.warn('permissions', e));
    };
    load();
    const off = api.perms.onChanged(setReport);
    window.addEventListener('focus', load);
    return () => {
      off();
      window.removeEventListener('focus', load);
    };
  }, [api]);
  return [report, setReport];
}

interface Props {
  report: PermissionsReport | null;
  onReport: (report: PermissionsReport) => void;
}

/**
 * macOS permission guidance (P3 step 3, R3.6): every permission the app uses that is not allowed
 * yet, what it is for, macOS's own prompt where there is one and a button to the right pane in
 * System Settings. Shows nothing when everything is allowed or on other systems.
 */
export function Permissions({ report, onReport }: Props) {
  const api = window.captureStudio;
  const [busy, setBusy] = useState<PermissionKind | null>(null);
  if (!report?.applies) return null;
  const missing = report.items.filter((i) => i.status !== 'granted');
  if (missing.length === 0) return null;

  const run = (kind: PermissionKind, action: () => Promise<unknown>) => {
    setBusy(kind);
    action()
      .catch((e: unknown) => console.warn('permissions', e))
      .finally(() => {
        setBusy(null);
        api.perms.get().then(onReport, () => undefined);
      });
  };

  return (
    <fieldset className={styles.group} data-testid="permissions">
      <legend>macOS permissions</legend>
      {report.recordingBlocked ? (
        <p className={styles.status} role="alert" data-testid="permissions-blocked">
          {report.recordingBlocked}
        </p>
      ) : null}
      <ul className={styles.permissionList}>
        {missing.map((item) => (
          <li key={item.kind} data-testid={`permission-${item.kind}`}>
            <div>
              <strong>{NAMES[item.kind]}</strong>
              {item.required ? ' (required)' : ''}:{' '}
              <span data-testid={`permission-${item.kind}-status`}>{STATUS_TEXT[item.status]}</span>
              <p className={styles.muted}>{item.purpose}</p>
            </div>
            <div className={styles.permissionActions}>
              {item.canRequest ? (
                <button
                  type="button"
                  data-testid={`permission-${item.kind}-request`}
                  disabled={busy !== null}
                  onClick={() => run(item.kind, () => api.perms.request(item.kind))}
                >
                  Allow…
                </button>
              ) : null}
              <button
                type="button"
                data-testid={`permission-${item.kind}-settings`}
                disabled={busy !== null}
                onClick={() => run(item.kind, () => api.perms.openSettings(item.kind))}
              >
                Open System Settings
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className={styles.muted}>
        Changes made in System Settings show here when you come back to Capture Studio.
      </p>
    </fieldset>
  );
}
