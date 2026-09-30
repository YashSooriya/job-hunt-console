"use client";

import { setDiagnosticsVisible, useDiagnosticsVisibility } from "@/lib/diagnostics-visibility";
import styles from "./diagnostics-visibility-toggle.module.css";

export function DiagnosticsVisibilityToggle() {
  const visible = useDiagnosticsVisibility();

  return (
    <section className="card settingsCard">
      <div className="cardHeader">
        <div>
          <h2>Diagnostics</h2>
          <p>Show troubleshooting tools in the More menu.</p>
        </div>
      </div>
      <div className={styles.cardBody}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => setDiagnosticsVisible(event.currentTarget.checked)}
          />
          <span className={styles.copy}>
            <strong>Show the diagnostics page</strong>
            <small>Adds Diagnostics to the main navigation on this browser.</small>
          </span>
        </label>
      </div>
    </section>
  );
}
