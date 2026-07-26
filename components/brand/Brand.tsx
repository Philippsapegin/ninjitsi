import styles from "./Brand.module.css";

interface BrandProps {
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className={styles.brand} aria-label="Ninjitsi">
      <span className={styles.mark}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          height={compact ? 30 : 34}
          src="/icon.svg"
          width={compact ? 30 : 34}
        />
      </span>
      {!compact && <span className={styles.wordmark}>ninjitsi</span>}
    </div>
  );
}
