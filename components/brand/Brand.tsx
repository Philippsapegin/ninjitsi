import { Sparkles } from "lucide-react";
import styles from "./Brand.module.css";

interface BrandProps {
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className={styles.brand} aria-label="Ninjitsi">
      <span className={styles.mark}>
        <Sparkles size={compact ? 16 : 18} strokeWidth={2.2} />
      </span>
      {!compact && <span className={styles.wordmark}>ninjitsi</span>}
    </div>
  );
}
