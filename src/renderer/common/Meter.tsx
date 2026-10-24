import { formatDb, meterFraction } from './recorder-format';
import styles from './Meter.module.css';

interface MeterProps {
  label: string;
  /** Linear peak 0–1; null when the source is off. */
  peak: number | null;
  testId?: string;
}

/** A horizontal level meter (R1.5, R1.12). */
export function Meter({ label, peak, testId }: MeterProps) {
  const fraction = peak === null ? 0 : meterFraction(peak);
  // −6 dB and −18 dB on the −60…0 dB scale.
  const zone = fraction > 0.9 ? styles.hot : fraction > 0.7 ? styles.warm : styles.ok;
  return (
    <div className={styles.meter} data-testid={testId}>
      <span className={styles.label}>{label}</span>
      <div
        className={styles.track}
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={fraction}
        aria-valuetext={peak === null ? 'off' : formatDb(peak)}
        data-peak={peak === null ? 'off' : peak.toFixed(3)}
      >
        <div
          className={`${styles.fill ?? ''} ${zone ?? ''}`}
          style={{ width: `${(fraction * 100).toFixed(1)}%` }}
        />
      </div>
      <span className={styles.value}>{peak === null ? 'off' : formatDb(peak)}</span>
    </div>
  );
}
