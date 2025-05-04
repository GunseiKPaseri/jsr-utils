/**
 * 一定時間待機する
 * @param ms 待機時間
 * @param options オプション
 * @param options.signal - 中断シグナル
 * @returns 待機完了後に解決するPromise
 *
 * @example スリープする
 * ```typescript
 * import { sleep } from '@gunseikpaseri/utils/sleep.ts';
 * await sleep(10000);
 * ```
 *
 * @example スリープ中にAbortSignalで中断する
 * ```typescript
 * import { sleep } from '@gunseikpaseri/utils/sleep.ts';
 * const controller = new AbortController();
 * const signal = controller.signal;
 * setTimeout(() => controller.abort(), 5000);
 * await sleep(10000, {signal});
 * ```
 */

export function sleep(
  ms: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    // タイムアウト用のタイマーID
    const timeoutId = setTimeout(() => {
      resolve();
    }, ms);

    signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      reject(new Error("Aborted"));
    }, { once: true });
  });
}
