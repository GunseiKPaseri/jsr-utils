import { sleep } from "./sleep.ts";

/**
 * カスタムPromiseクラス。ジョブIDの取得とジョブのアボート機能を持つ
 * @template T - Promiseが解決する値の型
 */
export class JobPromise<T> extends Promise<T> {
  private _jobId: string;
  private _abortController: AbortController;
  private _abortCallback: (jobId: string) => void;

  /**
   * JobPromiseのコンストラクタ
   * @param executor - Promiseのexecutor関数
   * @param jobId - ジョブID
   * @param abortController - このジョブのAbortController
   * @param abortCallback - ジョブをアボートする際に呼び出すコールバック関数
   */
  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      // deno-lint-ignore no-explicit-any
      reject: (reason?: any) => void,
    ) => void,
    jobId: string,
    abortController: AbortController,
    abortCallback: (jobId: string) => void,
  ) {
    super(executor);
    this._jobId = jobId;
    this._abortController = abortController;
    this._abortCallback = abortCallback;
  }

  /**
   * ジョブIDを取得
   */
  get jobId(): string {
    return this._jobId;
  }

  /**
   * ジョブをアボート
   */
  abort(): void {
    this._abortCallback(this._jobId);
  }
}

/**
 * ジョブ管理クラスで使用するイベントの種類
 */
type JobQueueEventType =
  | "jobStart"
  | "jobComplete"
  | "jobError"
  | "queueEmpty"
  | "error";

/**
 * イベントリスナーの引数の型を定義
 */
type JobQueueEventListenerArgMap<JobData, JobResult> = {
  jobStart: { jobId: string; data: JobData };
  jobComplete: { jobId: string; data: JobData; result: JobResult };
  jobError: { jobId: string; data: JobData; error: Error };
  queueEmpty: Record<string | number | symbol, never>;
  error: { error: Error };
};

/**
 * ジョブイベントのリスナー関数の型
 */
export type JobQueueEventListenerArg<
  JobData,
  JobResult,
  T extends JobQueueEventType,
> = JobQueueEventListenerArgMap<JobData, JobResult>[T];

/**
 * ジョブイベントのリスナー関数の型
 */
export type JobQueueEventListener<
  JobData,
  JobResult,
  T extends JobQueueEventType,
> = (eventData: JobQueueEventListenerArg<JobData, JobResult, T>) => void;

// 内部管理用のイベントリスナーの型配列
type EventListenersRecord<JobData, JobResult> = {
  [K in JobQueueEventType]: JobQueueEventListener<JobData, JobResult, K>[];
};

/**
 * ジョブ情報を格納する型
 * @template JobData - ジョブデータの型
 * @template JobResult - ジョブ結果の型
 */
interface Job<JobData, JobResult> {
  id: string;
  data: JobData;
  abortController: AbortController;
  promise: JobPromise<JobResult>;
  resolve: (value: JobResult) => void;
  // deno-lint-ignore no-explicit-any
  reject: (reason?: any) => void;
}

/**
 * Promiseでabort可能なJobQueueクラス
 * @template JobData - ジョブデータの型
 * @template JobResult - ジョブ結果の型
 */
export class JobQueue<JobData, JobResult> {
  private jobProcessor: (
    data: JobData,
    signal: AbortSignal,
  ) => Promise<JobResult>;
  private maxConcurrent: number;
  private intervalMs: number;
  private queue: Job<JobData, JobResult>[] = [];
  private running: Set<string> = new Set();
  private listeners: EventListenersRecord<JobData, JobResult>;
  private jobCounter: number = 0;
  private processingInterval: number | null = null;
  private isProcessingPaused: boolean = false;

  /**
   * JobQueueのコンストラクタ
   * @param jobProcessor - ジョブを処理する関数。JobDataとAbortSignalを受け取り、JobResultを返す
   * @param maxConcurrent - 最大並行実行数
   * @param intervalMs - ジョブの実行開始間隔(ms)
   */
  constructor(
    jobProcessor: (data: JobData, signal: AbortSignal) => Promise<JobResult>,
    maxConcurrent: number = 1,
    intervalMs: number = 0,
  ) {
    this.jobProcessor = jobProcessor;
    this.maxConcurrent = maxConcurrent;
    this.intervalMs = intervalMs;

    // イベントリスナーマップの初期化
    this.listeners = {
      jobStart: [],
      jobComplete: [],
      jobError: [],
      queueEmpty: [],
      error: [],
    };

    this.startProcessing();
  }

  /**
   * ジョブを実行キューに追加
   * @param data - ジョブデータ
   * @returns 拡張されたPromise。ジョブの結果を解決し、jobIdとabortメソッドを持つ
   *
   * @example
   * ```typescript
   * const queue = new JobQueue<string, number>(
   *   async (data, signal) => {
   *     // 処理例: 文字列の長さを返す
   *     await sleep(1000, { signal });
   *     return data.length;
   *   },
   *   2,  // 最大2ジョブ並行
   *   500 // 500ms間隔で実行
   * );
   *
   * // ジョブを追加
   * const job = queue.addJob("test data");
   * console.log(`ジョブID: ${job.jobId}`);
   *
   * // 結果を待つ
   * job.then(result => console.log(`結果: ${result}`))
   *    .catch(err => console.error(`エラー: ${err.message}`));
   *
   * // ジョブをアボート
   * job.abort();
   *
   * // または、ジョブIDを使ってアボート
   * queue.abortJob(job.jobId);
   * ```
   */
  addJob(data: JobData): JobPromise<JobResult> {
    const jobId = `job-${++this.jobCounter}`;
    const abortController = new AbortController();

    let resolveFunction!: (value: JobResult) => void;
    // deno-lint-ignore no-explicit-any
    let rejectFunction!: (reason?: any) => void;

    const promise = new JobPromise<JobResult>(
      (resolve, reject) => {
        resolveFunction = resolve;
        rejectFunction = reject;
      },
      jobId,
      abortController,
      this.abortJob.bind(this),
    );

    const job: Job<JobData, JobResult> = {
      id: jobId,
      data,
      abortController,
      promise,
      resolve: resolveFunction,
      reject: rejectFunction,
    };

    this.queue.push(job);

    // ジョブが追加され、プロセスが停止していれば再開
    if (this.processingInterval === null) {
      this.startProcessing();
    }

    return promise;
  }

  /**
   * 特定のジョブをアボート
   * @param jobId - アボートするジョブのID
   * @returns ジョブが見つかり、アボートされたかどうか
   */
  abortJob(jobId: string): boolean {
    // キュー内のジョブを検索
    const queueIndex = this.queue.findIndex((job) => job.id === jobId);
    if (queueIndex >= 0) {
      const job = this.queue[queueIndex];
      job.abortController.abort();
      job.reject(new Error(`Job ${jobId} aborted`));
      this.queue.splice(queueIndex, 1);
      return true;
    }

    // 実行中のジョブをアボート
    if (this.running.has(jobId)) {
      const job = this.queue.find((job) => job.id === jobId);
      if (job) {
        job.abortController.abort();
        return true;
      }
    }

    return false;
  }

  /**
   * イベントリスナーを追加
   * @param event - リスナーを追加するイベントタイプ
   * @param listener - イベントが発生したときに呼び出されるリスナー関数
   * @returns this - メソッドチェーン用にインスタンス自身を返す
   *
   * @example
   * ```typescript
   * const queue = new JobQueue<string, number>(
   *   async (data, signal) => {
   *     await sleep(1000, { signal });
   *     return data.length;
   *   }
   * );
   *
   * // 開始イベントリスナーを追加
   * queue.addEventListener("start", (jobId, data) => {
   *   console.log(`ジョブ ${jobId} 開始: ${data}`);
   * });
   *
   * // 完了イベントリスナーを追加
   * queue.addEventListener("complete", (jobId, result) => {
   *   console.log(`ジョブ ${jobId} 完了: ${result}`);
   * });
   * ```
   */
  addEventListener<E extends JobQueueEventType>(
    event: E,
    listener: JobQueueEventListener<JobData, JobResult, E>,
  ): this {
    const listeners = this.listeners[event];
    listeners.push(listener);
    return this;
  }

  /**
   * イベントリスナーを削除
   * @param event - リスナーを削除するイベントタイプ
   * @param listener - 削除するリスナー関数
   * @returns this - メソッドチェーン用にインスタンス自身を返す
   *
   * @example
   * ```typescript
   * const startListener = (jobId, data) => {
   *   console.log(`ジョブ ${jobId} 開始: ${data}`);
   * };
   *
   * // リスナーを追加
   * queue.addEventListener("start", startListener);
   *
   * // リスナーを削除
   * queue.removeEventListener("start", startListener);
   * ```
   */
  removeEventListener<E extends JobQueueEventType>(
    event: E,
    listener: JobQueueEventListener<JobData, JobResult, E>,
  ): this {
    const listeners = this.listeners[event] ?? [];
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
      this.listeners[event] = listeners;
    }
    return this;
  }

  /**
   * イベントを発火します
   * @param event イベントの種類
   * @param listenerArg イベントリスナーに渡す引数
   */
  private emitEvent<E extends JobQueueEventType>(
    event: E,
    listenerArg: JobQueueEventListenerArg<JobData, JobResult, E>,
  ): void {
    const listeners = this.listeners[event] ?? [];
    for (const listener of listeners) {
      try {
        listener(listenerArg);
      } catch (error) {
        console.error(
          `イベントリスナーの実行中にエラーが発生しました: ${error}`,
        );
      }
    }
  }

  /**
   * ジョブの処理を開始
   * @private
   */
  private startProcessing(): void {
    if (this.processingInterval !== null) return;

    // 処理中フラグを設定
    this.processingInterval = 1; // ダミー値、処理中フラグとして使用

    // ジョブを処理するメインループ関数
    const processLoop = async (): Promise<void> => {
      try {
        while (true) {
          // キューのバッチ処理
          await this.processAvailableJobs();

          // キューが空で実行中のジョブもない場合
          if (this.queue.length === 0 && this.running.size === 0) {
            // emptyイベントの発火
            this.emitEvent("queueEmpty", {});

            // 新しいジョブが追加されるまで待機
            if (this.queue.length === 0) {
              // 処理中フラグをクリア
              this.processingInterval = null;
              return;
            }
          }

          // intervalMsが設定されている場合は待機
          if (this.intervalMs > 0) {
            try {
              // AbortSignalなしで単純に待機
              await sleep(this.intervalMs);
            } catch (e) {
              // sleepが中断された場合の処理
              throw new Error("Sleep interrupted", { cause: e });
            }
          } else {
            // CPU過負荷を避けるための小さな遅延
            await sleep(0);
          }
        }
      } catch (error) {
        this.processingInterval = null;
        throw new Error("Error in job queue processing loop", { cause: error });
      }
    };

    // 処理を開始
    processLoop().catch((error) => {
      this.emitEvent("error", {
        error: new Error("Fatal error in job queue processing", {
          cause: error,
        }),
      });
      console.error("Fatal error in job queue processing:", error);
      this.processingInterval = null;
    });
  }

  /**
   * 利用可能なジョブを処理する
   * @private
   */
  private async processAvailableJobs(): Promise<void> {
    // 実行中のジョブ数が最大値未満で、キューにジョブがある場合に実行
    const jobsToProcess = Math.min(
      this.maxConcurrent - this.running.size,
      this.queue.length,
    );

    if (jobsToProcess <= 0) return;

    // 並行して処理できるジョブを取り出して実行
    const processingPromises: Promise<void>[] = [];

    for (let i = 0; i < jobsToProcess; i++) {
      const job = this.queue.shift()!;
      this.running.add(job.id);

      const processPromise = (async () => {
        try {
          // startイベントの発火
          this.emitEvent("jobStart", { jobId: job.id, data: job.data });

          // ジョブの実行
          const result = await this.jobProcessor(
            job.data,
            job.abortController.signal,
          );

          // completeイベントの発火
          this.emitEvent("jobComplete", {
            jobId: job.id,
            data: job.data,
            result,
          });
          job.resolve(result);
        } catch (error) {
          // errorイベントの発火
          const normalizedError = error instanceof Error
            ? error
            : new Error(String(error));
          this.emitEvent("jobError", {
            jobId: job.id,
            data: job.data,
            error: normalizedError,
          });
          job.reject(error);
        } finally {
          this.running.delete(job.id);
        }
      })();

      processingPromises.push(processPromise);
    }

    // すべてのジョブの処理が完了するのを待機
    await Promise.all(processingPromises);
  }

  /**
   * ジョブキューのクリーンアップ
   */
  dispose(): void {
    // processingIntervalはフラグとして使用しているため、単純にnullに設定
    this.processingInterval = null;

    // 残っているすべてのジョブをアボート
    for (const job of this.queue) {
      job.abortController.abort();
      job.reject(new Error("JobQueue disposed"));
    }
    this.queue = [];
  }
}
