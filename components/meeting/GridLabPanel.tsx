"use client";

import { Minus, Plus, RotateCcw, TestTubes } from "lucide-react";
import { GRID_LAB_MAX_PHANTOMS } from "@/lib/gridLab";
import styles from "./GridLabPanel.module.css";

const presets = [0, 1, 2, 3, 5, 8, 11, 15, 24, 35];

interface GridLabPanelProps {
  phantomCount: number;
  realCount: number;
  onChange: (count: number) => void;
}

export function GridLabPanel({
  phantomCount,
  realCount,
  onChange,
}: GridLabPanelProps) {
  function setCount(count: number) {
    onChange(Math.max(0, Math.min(GRID_LAB_MAX_PHANTOMS, count)));
  }

  return (
    <section aria-label="Лаборатория видеосетки" className={styles.panel}>
      <div className={styles.identity}>
        <span className={styles.icon}>
          <TestTubes size={16} />
        </span>
        <div>
          <strong>Grid Lab</strong>
          <span>
            живых: {realCount} · фантомов: {phantomCount}
          </span>
        </div>
      </div>

      <div className={styles.presets} role="group" aria-label="Пресеты фантомов">
        {presets.map((count) => (
          <button
            aria-pressed={phantomCount === count}
            className={phantomCount === count ? styles.active : ""}
            key={count}
            onClick={() => setCount(count)}
            type="button"
          >
            {count}
          </button>
        ))}
      </div>

      <div className={styles.counter}>
        <button
          aria-label="Убрать одного фантома"
          disabled={phantomCount === 0}
          onClick={() => setCount(phantomCount - 1)}
          type="button"
        >
          <Minus size={15} />
        </button>
        <output aria-live="polite">{phantomCount}</output>
        <button
          aria-label="Добавить одного фантома"
          disabled={phantomCount === GRID_LAB_MAX_PHANTOMS}
          onClick={() => setCount(phantomCount + 1)}
          type="button"
        >
          <Plus size={15} />
        </button>
        <button
          aria-label="Сбросить фантомов"
          className={styles.reset}
          disabled={phantomCount === 0}
          onClick={() => setCount(0)}
          type="button"
        >
          <RotateCcw size={14} />
          Сбросить
        </button>
      </div>
    </section>
  );
}
