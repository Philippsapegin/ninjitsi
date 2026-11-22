const CAMERA_RESTART_DELAY_MS = 1_000;

export class CameraOperations {
  private pending = Promise.resolve();
  private readyAt = 0;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  deferOpening() {
    this.readyAt = performance.now() + CAMERA_RESTART_DELAY_MS;
  }

  async waitToOpen(signal?: AbortSignal): Promise<boolean> {
    while (!signal?.aborted) {
      const delay = this.readyAt - performance.now();
      if (delay <= 0) return true;
      await new Promise<void>(resolve => {
        const finish = () => {
          window.clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = window.setTimeout(finish, Math.ceil(delay));
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return false;
  }
}
